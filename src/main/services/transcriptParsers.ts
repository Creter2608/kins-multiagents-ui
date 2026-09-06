import * as path from "node:path";
import { LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import type { LoopTestSummary, LoopTestStatus } from "../../shared/contracts.js";

export function isVerificationCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  const lower = cmd.toLowerCase().trim();
  const verifyPattern = /\b(test|typecheck|tsc|lint|check|verify|pytest|vitest|jest|cargo\s+test|ctest|mvn\s+test|gradlew\s+test)\b/i;
  return verifyPattern.test(lower);
}

export function isIsolationCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  const lower = cmd.toLowerCase().trim();
  const isolatePattern = /\b(git\s+worktree|docker\s+(inspect|ps|run|exec|compose)|devcontainer)\b/i;
  return isolatePattern.test(lower);
}

export function isStackDetectionTarget(target: string): boolean {
  if (!target || typeof target !== "string") return false;
  const lower = target.toLowerCase().trim();
  return /\b(package\.json|tsconfig\.json|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|dockerfile|composer\.json)\b/i.test(lower);
}

export function parseVerificationOutput(text: string, exitCode?: number): LoopTestSummary | null {
  if (!text && exitCode === undefined) return null;

  const raw = typeof text === "string" ? text : "";
  let passCount: number | null = null;
  let failCount: number | null = null;

  // 1. TAP format: # pass 4, # fail 0
  const tapPassMatch = /#\s*pass\s+(\d+)/i.exec(raw);
  const tapFailMatch = /#\s*fail\s+(\d+)/i.exec(raw);
  if (tapPassMatch || tapFailMatch) {
    passCount = tapPassMatch && tapPassMatch[1] ? parseInt(tapPassMatch[1], 10) : 0;
    failCount = tapFailMatch && tapFailMatch[1] ? parseInt(tapFailMatch[1], 10) : 0;
  }

  // 2. Jest/Vitest/Pytest format:
  // e.g., "Tests: 1 failed, 3 passed", "Tests 4 passed | 1 failed", "2 passed", "3 passed, 1 failed"
  if (passCount === null && failCount === null) {
    const passedMatch = /(\d+)\s+passed\b/i.exec(raw);
    const failedMatch = /(\d+)\s+failed\b/i.exec(raw);

    if (passedMatch || failedMatch) {
      passCount = passedMatch && passedMatch[1] ? parseInt(passedMatch[1], 10) : 0;
      failCount = failedMatch && failedMatch[1] ? parseInt(failedMatch[1], 10) : 0;
    }
  }

  // If explicit counts were found, they take precedence over exitCode
  if (passCount !== null && failCount !== null) {
    const status: LoopTestStatus = failCount > 0 ? "fail" : passCount > 0 ? "pass" : "idle";
    return {
      status,
      passCount,
      failCount,
      lastRunAt: new Date().toISOString()
    };
  }

  // 3. Fallback based on exitCode if verification finished without explicit count output
  if (exitCode !== undefined) {
    if (exitCode === 0) {
      return {
        status: "pass",
        passCount: 0,
        failCount: 0,
        lastRunAt: new Date().toISOString()
      };
    } else {
      return {
        status: "fail",
        passCount: 0,
        failCount: 1,
        lastRunAt: new Date().toISOString()
      };
    }
  }

  return null;
}

export interface PhaseDetectionResult {
  readonly phase: LoopPhase;
  readonly evidence: string;
}

export function detectPhaseWithEvidenceFromTranscriptStep(step: unknown): PhaseDetectionResult | null {
  if (!step) return null;

  // Normalize string inputs if passed directly
  let s: Record<string, unknown>;
  if (typeof step === "string") {
    s = { content: step };
  } else if (typeof step === "object") {
    s = step as Record<string, unknown>;
  } else {
    return null;
  }

  const candidates: PhaseDetectionResult[] = [];

  // 1. Check Tool Calls (Highest precedence)
  if (Array.isArray(s.tool_calls) && s.tool_calls.length > 0) {
    for (const tc of s.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const name = String(call.name || "").toLowerCase().trim();
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};

      if (name === "ask_question") {
        candidates.push({ phase: "SPEC_GATE", evidence: "tool: ask_question" });
      }

      if (name === "run_command") {
        const cmd = String(args.CommandLine || args.command || "").trim();
        if (isVerificationCommand(cmd)) {
          candidates.push({ phase: "VERIFY", evidence: `cmd: ${cmd}` });
        } else if (isIsolationCommand(cmd)) {
          candidates.push({ phase: "ISOLATE", evidence: `cmd: ${cmd}` });
        } else if (/\b(list_dir|find_by_name)\b/i.test(cmd) || isStackDetectionTarget(cmd)) {
          candidates.push({ phase: "DETECT_STACKS", evidence: `cmd: ${cmd}` });
        }
      }

      if (name === "list_dir" || name === "find_by_name") {
        candidates.push({ phase: "DETECT_STACKS", evidence: `tool: ${name}` });
      }

      if (name === "view_file" || name === "read_resource") {
        const targetPath = String(args.AbsolutePath || args.TargetFile || args.filePath || args.Uri || "").trim();
        if (isStackDetectionTarget(targetPath)) {
          candidates.push({ phase: "DETECT_STACKS", evidence: `inspect: ${path.basename(targetPath)}` });
        }
      }

      if (name === "craft_technical_prompt_with_gpt") {
        candidates.push({ phase: "PLAN", evidence: "tool: craft_technical_prompt_with_gpt" });
      }

      if (name === "call_mcp_tool") {
        const toolName = String(args.ToolName || args.tool_name || "").replace(/^"|"$/g, "").trim();
        const serverName = String(args.ServerName || args.server_name || "").replace(/^"|"$/g, "").trim();
        if (toolName === "craft_technical_prompt_with_gpt" || serverName === "gpt_architect") {
          candidates.push({ phase: "PLAN", evidence: "mcp: gpt_architect" });
        } else if (toolName.includes("codegraph") || serverName === "codegraph") {
          candidates.push({ phase: "PLAN", evidence: "mcp: codegraph" });
        }
      }

      if (name === "write_to_file" || name === "replace_file_content") {
        candidates.push({ phase: "EXECUTE", evidence: `tool: ${name}` });
      }
    }
  }

  // 2. Check Textual / Template Signals in content or thinking
  const content = typeof s.content === "string" ? s.content : "";
  const thinking = typeof s.thinking === "string" ? s.thinking : "";
  const combined = content + "\n" + thinking;

  if (combined.trim()) {
    const phaseMatch = /\[Phase:\s*(INITIALIZE|SPEC_GATE|ISOLATE|DETECT_STACKS|PLAN|EXECUTE|VERIFY|REALITY_CHECK|RELEASE_GATE|COMPLETE)\]/i.exec(combined);
    if (phaseMatch && phaseMatch[1]) {
      const p = phaseMatch[1].toUpperCase() as LoopPhase;
      candidates.push({ phase: p, evidence: `tag: [Phase: ${p}]` });
    }

    const templateMatch = /\[Template Applied\]:\s*Loaded\s+([^\s]+\.md)/i.exec(combined);
    if (templateMatch && templateMatch[1]) {
      const tName = templateMatch[1].toLowerCase();
      if (tName.includes("spec-document")) {
        candidates.push({ phase: "SPEC_GATE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("using-git-worktrees")) {
        candidates.push({ phase: "ISOLATE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("writing-plans") || tName.includes("brainstorming")) {
        candidates.push({ phase: "PLAN", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("implementer-prompt")) {
        candidates.push({ phase: "EXECUTE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("task-reviewer") || tName.includes("verification-before-completion")) {
        candidates.push({ phase: "VERIFY", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("reality-checker")) {
        candidates.push({ phase: "REALITY_CHECK", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("finishing-a-development-branch") || tName.includes("release")) {
        candidates.push({ phase: "RELEASE_GATE", evidence: `template: ${templateMatch[1]}` });
      }
    }

    // Direct plain-text keyword detection for early signals if not already covered
    if (/\blist_dir\s+package\.json\b/i.test(combined)) {
      candidates.push({ phase: "DETECT_STACKS", evidence: "list_dir package.json" });
    }

    // Completion, release, and reality check detection from text ONLY for model/assistant output
    const isModelStep = s.source === "MODEL" || s.type === "PLANNER_RESPONSE";
    if (isModelStep) {
      if (
        /\b(hoàn thành|đã hoàn thành|hoàn tất|task completed|work is complete|successfully implemented|all tests passed|release complete|pipeline complete)\b/i.test(combined) ||
        /\[Phase:\s*COMPLETE\]/i.test(combined)
      ) {
        candidates.push({ phase: "COMPLETE", evidence: "completion reported" });
      } else if (
        /\b(release gate|ready for release|chờ nghiệm thu|sign-off|human sign-off)\b/i.test(combined) ||
        /\[Phase:\s*RELEASE_GATE\]/i.test(combined)
      ) {
        candidates.push({ phase: "RELEASE_GATE", evidence: "release gate reported" });
      } else if (
        /\b(reality check|reality audit|kiểm tra thực tế|pre-completion audit)\b/i.test(combined) ||
        /\[Phase:\s*REALITY_CHECK\]/i.test(combined)
      ) {
        candidates.push({ phase: "REALITY_CHECK", evidence: "reality check reported" });
      }
    }
  }

  // 3. Check User Prompt & Loop Reset Intent (Absolute highest precedence)
  if (s.source === "USER" || s.source === "USER_EXPLICIT" || s.type === "USER_INPUT") {
    const text = typeof s.content === "string" ? s.content : "";
    if (
      s.step_index === 0 ||
      /\b(loop\s*m[oóớơ>a-z]*|new\s*loop|start\s*loop|chạy\s*loop|bắt\s*đầu\s*loop|reset\s*loop)\b/i.test(text) ||
      (/\bloop\b/i.test(text) && /\b(m[oóớơ>a-z]*|new|start|chạy|bắt\s*đầu|reset)\b/i.test(text))
    ) {
      return {
        phase: "INITIALIZE",
        evidence: s.step_index === 0 ? "user: initial prompt" : "user: new loop requested"
      };
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Assertion: Select the furthest credible phase in canonical order
  // e.g. write_to_file + tsc -> VERIFY
  candidates.sort((a, b) => {
    const idxA = (LOOP_PHASES as readonly string[]).indexOf(a.phase);
    const idxB = (LOOP_PHASES as readonly string[]).indexOf(b.phase);
    return idxB - idxA;
  });

  return candidates[0] || null;
}

export function detectPhaseFromTranscriptStep(step: unknown): LoopPhase | null {
  return detectPhaseWithEvidenceFromTranscriptStep(step)?.phase ?? null;
}

export interface ParsedGptTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly missTokens: number;
  readonly totalTokens: number;
}

export function parseGptTokenUsageLine(text: string): ParsedGptTokenUsage | null {
  const regex = /(?:[\[(]?(?:GPT Token Usage|Usage)[\])]?:\s*)?Input:\s*([\d,]+)(?:\s*\(Cached:\s*([\d,]+)\))?\s*\|\s*Output:\s*(?:(?:Blueprint:\s*([\d,]+)(?:\s*\|\s*Thinking:\s*([\d,]+))?)|([\d,]+))\s*\|\s*Total:\s*([\d,]+)/i;
  const match = regex.exec(text);
  if (!match) {
    return null;
  }

  const parseNum = (str?: string) => (str ? parseInt(str.replace(/,/g, ""), 10) : 0);

  const inputTokens = parseNum(match[1]);
  const rawCached = parseNum(match[2]);
  const cachedTokens = Math.min(inputTokens, Math.max(0, rawCached));
  const blueprint = parseNum(match[3]);
  const thinking = parseNum(match[4]);
  const rawOutput = parseNum(match[5]);
  const outputTokens = rawOutput > 0 ? rawOutput : blueprint + thinking;
  const totalTokens = parseNum(match[6]);
  const missTokens = Math.max(0, inputTokens - cachedTokens);

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    missTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  };
}
