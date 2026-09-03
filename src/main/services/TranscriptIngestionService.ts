import * as fs from "node:fs";
import * as path from "node:path";
import type { TelemetryService } from "./TelemetryService.js";
import type { McpMonitorService } from "./McpMonitorService.js";

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
  const cachedTokens = parseNum(match[2]);
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

export class TranscriptIngestionService {
  private telemetryService: TelemetryService;
  private mcpService: McpMonitorService;
  private customTranscriptPath: string | null = null;
  private currentTranscriptPath: string | null = null;
  private lastOffset: number = 0;
  private incompleteLine: string = "";
  private pollTimer: NodeJS.Timeout | null = null;

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

  constructor(
    telemetryService: TelemetryService,
    mcpService: McpMonitorService,
    customTranscriptPath: string | null = null
  ) {
    this.telemetryService = telemetryService;
    this.mcpService = mcpService;
    this.customTranscriptPath = customTranscriptPath;
  }

  resetSessionCounters(): void {
    this.seenToolCallKeys.clear();
    this.seenGptEventKeys.clear();
    this.seenGeminiStepIndices.clear();
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

  processLine(line: string): void {
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

    // Cumulative context tracking from user turns
    if (step.source === "USER_EXPLICIT" || step.source === "USER") {
      const userContent = typeof step.content === "string" ? step.content : "";
      this.cumulativeContextLength += userContent.length;
    }

    // 1. Process Tool Calls (Layer 1 Assertion 5: dedupe step.tool_calls)
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (let i = 0; i < step.tool_calls.length; i++) {
        const tc = step.tool_calls[i];
        if (!tc || typeof tc !== "object") continue;

        let serverName = "native";
        let toolName = String(tc.name || "unknown");

        if (tc.name === "call_mcp_tool" && tc.args) {
          const rawServer = tc.args.ServerName || tc.args.server_name || "unknown";
          const rawTool = tc.args.ToolName || tc.args.tool_name || "unknown";
          serverName = String(rawServer).replace(/^"|"$/g, "");
          toolName = String(rawTool).replace(/^"|"$/g, "");
        }

        const callKey = stepIdx + ":" + i + ":" + serverName + ":" + toolName;
        if (!this.seenToolCallKeys.has(callKey)) {
          this.seenToolCallKeys.add(callKey);
          this.mcpService.recordToolCall({
            serverName,
            toolName,
            status: step.status === "ERROR" ? "error" : "success"
          });
        }
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

      for (const line of lines) {
        this.processLine(line);
      }
    } catch {
      // Defensive handling
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
