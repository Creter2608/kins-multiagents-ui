import * as fs from "node:fs";
import * as path from "node:path";
import type { TelemetryService } from "./TelemetryService.js";
import type { McpMonitorService } from "./McpMonitorService.js";
import type { LoopStateService } from "./LoopStateService.js";
import type { SubagentService } from "./SubagentService.js";
import type { JsonValue } from "../../shared/contracts.js";
import { LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine,
  type PhaseDetectionResult,
  type ParsedGptTokenUsage
} from "./transcriptParsers.js";

export {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine,
  type PhaseDetectionResult,
  type ParsedGptTokenUsage
};

function extractConversationIds(text: string): string[] {
  const matches = text.matchAll(/"conversationId":\s*"([^"]+)"/g);
  const ids: string[] = [];
  for (const m of matches) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

function extractSystemMessageSender(text: string): string | undefined {
  const match = text.match(/sender=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : undefined;
}

export class TranscriptIngestionService {
  private telemetryService: TelemetryService;
  private mcpService: McpMonitorService;
  private loopService: LoopStateService | null = null;
  private subagentService: SubagentService | null = null;
  private customTranscriptPath: string | null = null;
  private currentTranscriptPath: string | null = null;
  private lastOffset: number = 0;
  private incompleteLine: string = "";
  private pollTimer: NodeJS.Timeout | null = null;

  // Queue of pending synthetic subagent ID batches awaiting tool result conversationIds
  private pendingSubagentsQueue: string[][] = [];

  // Deduplication registries for idempotent ingestion
  private seenToolCallKeys = new Set<string>();
  private seenGptEventKeys = new Set<string>();
  private seenGeminiStepIndices = new Set<number>();

  // Monotonic telemetry totals
  private totalGptPrompt = 0;
  private totalGptCompletion = 0;
  private totalGptCacheHit = 0;
  private totalGptCacheMiss = 0;
  private totalGeminiPrompt = 0;
  private totalGeminiCompletion = 0;
  private cumulativeContextLength = 30000;
  private sessionGeneration = 0;
  private projectRoot = process.cwd();

  constructor(
    telemetryService: TelemetryService,
    mcpService: McpMonitorService,
    loopServiceOrPath?: LoopStateService | string | null,
    customTranscriptPath?: string | null,
    subagentService?: SubagentService | null
  ) {
    this.telemetryService = telemetryService;
    this.mcpService = mcpService;
    if (typeof loopServiceOrPath === "string") {
      this.customTranscriptPath = loopServiceOrPath;
      this.loopService = null;
    } else {
      this.loopService = loopServiceOrPath ?? null;
      this.customTranscriptPath = customTranscriptPath ?? null;
    }
    this.subagentService = subagentService ?? null;
  }

  setSubagentService(subagentService: SubagentService | null): void {
    this.subagentService = subagentService;
  }

  getSessionGeneration(): number {
    return this.sessionGeneration;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.sessionGeneration++;
    this.projectRoot = path.resolve(projectPath);
    this.resetSessionCounters();
    this.lastOffset = 0;
    this.incompleteLine = "";
    this.currentTranscriptPath = null;
  }

  reset(): void {
    this.sessionGeneration++;
    this.resetSessionCounters();
    this.lastOffset = 0;
    this.incompleteLine = "";
    this.currentTranscriptPath = null;
  }

  resetSessionCounters(): void {
    this.seenToolCallKeys.clear();
    this.seenGptEventKeys.clear();
    this.seenGeminiStepIndices.clear();
    this.pendingSubagentsQueue = [];
    this.totalGptPrompt = 0;
    this.totalGptCompletion = 0;
    this.totalGptCacheHit = 0;
    this.totalGptCacheMiss = 0;
    this.totalGeminiPrompt = 0;
    this.totalGeminiCompletion = 0;
    this.cumulativeContextLength = 30000;
  }

  findActiveTranscriptPath(): string | null {
    if (this.customTranscriptPath && fs.existsSync(this.customTranscriptPath)) {
      return this.customTranscriptPath;
    }

    const homeDir = process.env.USERPROFILE || process.env.HOME || "";
    const searchRoots = [
      path.join(homeDir, ".gemini", "antigravity-cli", "brain"),
      path.join(homeDir, ".gemini", "antigravity", "brain")
    ];

    let newestPath: string | null = null;
    let newestMtime = 0;

    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const convDirs = fs.readdirSync(root, { withFileTypes: true });
        for (const dir of convDirs) {
          if (!dir.isDirectory()) continue;
          const candidate = path.join(root, dir.name, ".system_generated", "logs", "transcript.jsonl");
          if (fs.existsSync(candidate)) {
            const stat = fs.statSync(candidate);
            if (stat.mtimeMs > newestMtime) {
              newestMtime = stat.mtimeMs;
              newestPath = candidate;
            }
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    }

    return newestPath;
  }

  processLine(line: string, generation?: number): void {
    if (generation !== undefined && generation !== this.sessionGeneration) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;

    let step: any;
    try {
      step = JSON.parse(trimmed);
    } catch {
      const gptUsage = parseGptTokenUsageLine(trimmed);
      if (gptUsage) {
        const eventKey = "raw:" + trimmed;
        if (!this.seenGptEventKeys.has(eventKey)) {
          this.seenGptEventKeys.add(eventKey);
          this.totalGptPrompt += gptUsage.inputTokens;
          this.totalGptCompletion += gptUsage.outputTokens;
          this.totalGptCacheHit += gptUsage.cachedTokens;
          this.totalGptCacheMiss += gptUsage.missTokens;

          this.telemetryService.updateMetrics({
            gptPromptTokens: this.totalGptPrompt,
            gptCompletionTokens: this.totalGptCompletion,
            gptCacheHitTokens: this.totalGptCacheHit,
            gptCacheMissTokens: this.totalGptCacheMiss
          });
        }
      }
      return;
    }

    const stepIdx = typeof step.step_index === "number" ? step.step_index : Date.now();

    // Cumulative context tracking and auto-reset on new user turn
    if (step.source === "USER_EXPLICIT" || step.source === "USER" || step.type === "USER_INPUT") {
      const userContent = typeof step.content === "string" ? step.content : "";
      this.cumulativeContextLength += userContent.length;

      if (this.loopService) {
        const current = this.loopService.getSnapshot();
        const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
        const isExplicitNewLoop =
          /\b(loop\s*m[oóớơ>a-z]*|new\s*loop|start\s*loop|chạy\s*loop|bắt\s*đầu\s*loop|reset\s*loop)\b/i.test(userContent) ||
          (/\bloop\b/i.test(userContent) && /\b(m[oóớơ>a-z]*|new|start|chạy|bắt\s*đầu|reset)\b/i.test(userContent));
        // Automatically reset loop if user submits a new prompt after previous run reached VERIFY or later,
        // or if status succeeded, or if user explicitly requested a new loop
        if (isExplicitNewLoop || (stepIdx > 0 && (currentIdx >= 6 || current.status === "succeeded"))) {
          this.loopService.resetLoop();
        }
      }
    }

    // 1. Process Tool Calls (Layer 1 Assertion 5: dedupe step.tool_calls)
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (let i = 0; i < step.tool_calls.length; i++) {
        const tc = step.tool_calls[i];
        if (!tc || typeof tc !== "object") continue;

        let serverName = "native";
        let toolName = String(tc.name || "unknown");
        let args: JsonValue | undefined = undefined;

        if (tc.args !== undefined) {
          if (typeof tc.args === "string") {
            try {
              args = JSON.parse(tc.args) as JsonValue;
            } catch {
              args = tc.args;
            }
          } else {
            args = tc.args as unknown as JsonValue;
          }
        }

        if (tc.name === "call_mcp_tool" && tc.args) {
          const rawServer = tc.args.ServerName || tc.args.server_name || "unknown";
          const rawTool = tc.args.ToolName || tc.args.tool_name || "unknown";
          serverName = String(rawServer).replace(/^"|"$/g, "");
          toolName = String(rawTool).replace(/^"|"$/g, "");

          const innerArgs = tc.args.Arguments || tc.args.arguments || tc.args.args;
          if (innerArgs !== undefined) {
            if (typeof innerArgs === "string") {
              try {
                args = JSON.parse(innerArgs) as JsonValue;
              } catch {
                args = innerArgs;
              }
            } else {
              args = innerArgs as unknown as JsonValue;
            }
          }
        }

        const callKey = stepIdx + ":" + i + ":" + serverName + ":" + toolName;
        if (!this.seenToolCallKeys.has(callKey)) {
          this.seenToolCallKeys.add(callKey);
          this.mcpService.recordToolCall({
            serverName,
            toolName,
            status: step.status === "ERROR" ? "error" : "success",
            args
          });

          if (this.subagentService && (toolName === "invoke_subagent" || toolName.endsWith(".invoke_subagent"))) {
            this.handleSubagentToolCall(step, tc, stepIdx, i);
          } else if (this.subagentService && (toolName === "manage_subagents" || toolName.endsWith(".manage_subagents"))) {
            this.handleManageSubagentsToolCall(tc);
          }
        }
      }
    }

    // Correlated subagent tool results or lifecycle updates
    if (this.subagentService) {
      if (step.tool_call_id && (step.type === "TOOL_RESULT" || step.source === "TOOL_RESULT")) {
        const resultId = String(step.tool_call_id);
        if (step.is_error || step.status === "ERROR") {
          this.subagentService.updateStatus({
            id: resultId,
            status: "error",
            errorMessage: typeof step.content === "string" ? step.content : "Tool execution error"
          });
        } else {
          this.subagentService.updateStatus({
            id: resultId,
            status: "completed"
          });
        }
      } else if (step.sender && typeof step.sender === "string" && (step.status === "DONE" || step.type === "SUBAGENT_COMPLETED")) {
        this.subagentService.updateStatus({
          id: step.sender,
          status: "completed"
        });
      }

      if (typeof step.content === "string") {
        this.handleSubagentOutput(step.content);
      }
    }

    // 2. Process GPT Token Metrics (Layer 1 Assertion 4: dedupe usage)
    const content = typeof step.content === "string" ? step.content : "";
    const thinking = typeof step.thinking === "string" ? step.thinking : "";
    const combinedText = content + "\n" + thinking;

    const gptUsage = parseGptTokenUsageLine(combinedText);
    if (gptUsage) {
      const gptKey = "step:" + stepIdx + ":" + gptUsage.totalTokens;
      if (!this.seenGptEventKeys.has(gptKey)) {
        this.seenGptEventKeys.add(gptKey);
        this.totalGptPrompt += gptUsage.inputTokens;
        this.totalGptCompletion += gptUsage.outputTokens;
        this.totalGptCacheHit += gptUsage.cachedTokens;
        this.totalGptCacheMiss += gptUsage.missTokens;

        this.telemetryService.updateMetrics({
          gptPromptTokens: this.totalGptPrompt,
          gptCompletionTokens: this.totalGptCompletion,
          gptCacheHitTokens: this.totalGptCacheHit,
          gptCacheMissTokens: this.totalGptCacheMiss
        });

        if (this.loopService) {
          const totalGpt = this.totalGptPrompt + this.totalGptCompletion;
          this.loopService.updateResourceUsage({
            promptTokens: this.totalGptPrompt,
            completionTokens: this.totalGptCompletion,
            cachedTokens: this.totalGptCacheHit,
            totalTokens: totalGpt,
            oracleCalls: this.seenGptEventKeys.size
          });
        }
      }
    }

    // 3. Process Gemini Telemetry
    if (step.source === "MODEL" && typeof step.step_index === "number") {
      if (!this.seenGeminiStepIndices.has(step.step_index)) {
        this.seenGeminiStepIndices.add(step.step_index);

        let estPrompt: number;
        let estComp: number;

        if (step.usage && typeof step.usage.prompt_tokens === "number") {
          estPrompt = step.usage.prompt_tokens;
          estComp = typeof step.usage.completion_tokens === "number"
            ? step.usage.completion_tokens
            : Math.max(50, Math.ceil((content.length + thinking.length) / 4));
        } else if (step.usage && typeof step.usage.input_tokens === "number") {
          estPrompt = step.usage.input_tokens;
          estComp = typeof step.usage.output_tokens === "number"
            ? step.usage.output_tokens
            : Math.max(50, Math.ceil((content.length + thinking.length) / 4));
        } else {
          estPrompt = Math.max(1000, Math.ceil(this.cumulativeContextLength / 4));
          estComp = Math.max(50, Math.ceil((content.length + thinking.length) / 4));
        }

        this.cumulativeContextLength += content.length + thinking.length;
        this.totalGeminiPrompt += estPrompt;
        this.totalGeminiCompletion += estComp;

        this.telemetryService.updateMetrics({
          geminiPromptTokens: this.totalGeminiPrompt,
          geminiCompletionTokens: this.totalGeminiCompletion,
          geminiCacheStatus: "Active"
        });

        if (this.loopService) {
          const totalTokens = (this.totalGptPrompt + this.totalGptCompletion) + (this.totalGeminiPrompt + this.totalGeminiCompletion);
          this.loopService.updateResourceUsage({
            promptTokens: this.totalGptPrompt + this.totalGeminiPrompt,
            completionTokens: this.totalGptCompletion + this.totalGeminiCompletion,
            cachedTokens: this.totalGptCacheHit,
            totalTokens
          });
        }
      }
    }

    // 4. Process Workflow Phase Detection & Auto-Transition
    const detection = detectPhaseWithEvidenceFromTranscriptStep(step);
    if (detection && this.loopService) {
      const current = this.loopService.getSnapshot();
      const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
      const targetIdx = LOOP_PHASES.indexOf(detection.phase);
      // Invariant: Transcript evidence is forward-only.
      // Casual inspections (list_dir, view_file, codegraph) during EXECUTE or VERIFY
      // must NOT attempt to rewind the active workflow.
      if (targetIdx > currentIdx || detection.phase === "INITIALIZE") {
        this.loopService.advanceToPhase(detection.phase, detection.evidence);
      }
    }

    // 5. Process Verification Test Results
    const testResult = parseVerificationOutput(combinedText);
    if (testResult && this.loopService) {
      this.loopService.updateTestSummary(testResult);
      if (testResult.status === "pass" && testResult.failCount === 0) {
        const current = this.loopService.getSnapshot();
        const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
        const verifyIdx = LOOP_PHASES.indexOf("VERIFY");
        if (currentIdx <= verifyIdx) {
          this.loopService.advanceToPhase("REALITY_CHECK", `Tests passed (${testResult.passCount} passed, 0 failed)`);
        }
      } else if (testResult.status === "fail" && testResult.failCount > 0) {
        // Explicit loopback to EXECUTE on test failure
        const current = this.loopService.getSnapshot();
        if (current.currentPhase === "VERIFY" && current.usage.retries < current.budget.maxRetries) {
          this.loopService.advanceToPhase(
            "EXECUTE",
            `Test failure detected (${testResult.failCount} failed)`,
            "verify-test-failure"
          );
        }
      }
    }
  }

  processFile(): void {
    const targetFile = this.customTranscriptPath || this.findActiveTranscriptPath();
    if (!targetFile || !fs.existsSync(targetFile)) {
      return;
    }

    if (targetFile !== this.currentTranscriptPath) {
      const isSwitchingSession = this.currentTranscriptPath !== null;
      this.currentTranscriptPath = targetFile;
      this.lastOffset = 0;
      this.incompleteLine = "";

      if (isSwitchingSession) {
        this.resetSessionCounters();
        this.telemetryService.resetCurrentSession();
        if (this.loopService) {
          this.loopService.resetLoop();
        }
      }
    }

    try {
      const stat = fs.statSync(targetFile);
      if (stat.size < this.lastOffset) {
        this.lastOffset = 0;
        this.incompleteLine = "";
      }

      if (stat.size === this.lastOffset) {
        return;
      }

      const bytesToRead = stat.size - this.lastOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(targetFile, "r");
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, this.lastOffset);
      } finally {
        fs.closeSync(fd);
      }

      this.lastOffset = stat.size;

      const raw = this.incompleteLine + buffer.toString("utf-8");
      const lines = raw.split(/\r?\n/);
      this.incompleteLine = lines.pop() ?? "";

      const currentGen = this.sessionGeneration;
      for (const line of lines) {
        if (this.sessionGeneration !== currentGen) return;
        this.processLine(line, currentGen);
      }
    } catch {
      // Defensive handling
    }
  }

  private handleSubagentToolCall(step: any, tc: any, stepIdx: number, toolIdx: number): void {
    if (!this.subagentService) return;
    let args = tc.args || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }

    let rawList = args.Subagents || args.subagents;
    if (typeof rawList === "string") {
      try {
        const parsed = JSON.parse(rawList);
        if (Array.isArray(parsed)) {
          rawList = parsed;
        }
      } catch {
        // preserve safe fallback
      }
    }

    if (Array.isArray(rawList) && rawList.length > 0) {
      const batchIds: string[] = [];
      for (let sIdx = 0; sIdx < rawList.length; sIdx++) {
        const item = rawList[sIdx];
        if (!item || typeof item !== "object") continue;
        const subId = item.id || item.conversationId || `${stepIdx}:sub:${toolIdx}:${sIdx}`;
        const role = item.Role || item.role || item.TypeName || item.type_name || item.typeName;
        const model = item.Model || item.model;
        const prompt = item.Prompt || item.prompt || item.task || item.instruction;

        this.subagentService.recordInvocation({
          id: String(subId),
          role: role ? String(role) : undefined,
          model: model ? String(model) : undefined,
          prompt: prompt ? String(prompt) : undefined,
          startedAt: typeof step.created_at === "string" ? new Date(step.created_at).getTime() : undefined
        });

        batchIds.push(String(subId));

        if (step.status === "ERROR") {
          this.subagentService.updateStatus({
            id: String(subId),
            status: "error",
            errorMessage: typeof step.content === "string" ? step.content : "Subagent error"
          });
        }
      }
      if (batchIds.length > 0) {
        this.pendingSubagentsQueue.push(batchIds);
      }
    } else {
      const subId = args.id || args.conversationId || `${stepIdx}:sub:${toolIdx}:0`;
      const role = args.Role || args.role || args.TypeName || args.type_name;
      const model = args.Model || args.model;
      const prompt = args.Prompt || args.prompt || args.task || args.instruction;

      this.subagentService.recordInvocation({
        id: String(subId),
        role: role ? String(role) : undefined,
        model: model ? String(model) : undefined,
        prompt: prompt ? String(prompt) : undefined,
        startedAt: typeof step.created_at === "string" ? new Date(step.created_at).getTime() : undefined
      });

      this.pendingSubagentsQueue.push([String(subId)]);

      if (step.status === "ERROR") {
        this.subagentService.updateStatus({
          id: String(subId),
          status: "error",
          errorMessage: typeof step.content === "string" ? step.content : "Subagent error"
        });
      }
    }
  }

  private handleManageSubagentsToolCall(tc: any): void {
    if (!this.subagentService) return;
    let args = tc.args || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const action = String(args.Action || args.action || "").toLowerCase();
    if (action === "kill_all") {
      this.subagentService.markAllCompleted();
    } else if (action === "kill") {
      const ids = args.ConversationIds || args.conversationIds || args.conversationId || args.id;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string") {
            this.subagentService.markCompletedByConversationId(id);
          }
        }
      } else if (typeof ids === "string") {
        this.subagentService.markCompletedByConversationId(ids);
      }
    }
  }

  private handleSubagentOutput(content: string): void {
    if (!this.subagentService) return;

    if (content.includes("conversationId")) {
      const ids = extractConversationIds(content);
      if (ids.length > 0 && this.pendingSubagentsQueue.length > 0) {
        const batch = this.pendingSubagentsQueue.shift();
        if (batch) {
          const limit = Math.min(batch.length, ids.length);
          for (let i = 0; i < limit; i++) {
            const subId = batch[i];
            const convId = ids[i];
            if (subId && convId) {
              this.subagentService.bindConversationId(subId, convId);
            }
          }
        }
      }
    }

    const sender = extractSystemMessageSender(content);
    if (sender) {
      this.subagentService.markCompletedByConversationId(sender);
    }

    if (content.includes("Successfully killed")) {
      this.subagentService.markAllCompleted();
    } else if (content.includes('"state":"idle"')) {
      const idleMatches = content.matchAll(/"conversationId":\s*"([^"]+)",[^}]*"state":\s*"idle"/g);
      for (const m of idleMatches) {
        if (m[1]) {
          this.subagentService.markIdleByConversationId(m[1]);
        }
      }
    }
  }

  start(): void {
    this.processFile();
    this.pollTimer = setInterval(() => {
      this.processFile();
    }, 1500);
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
