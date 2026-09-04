import type { LoopPhase, PhaseDisplayItem } from "./phases.js";
import type { EvaluationReport } from "./harness.js";

export type Unsubscribe = () => void;

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number | string | undefined;
}

export interface LoopUsageSnapshot {
  readonly transitions: number;
  readonly retries: number;
  readonly operations: number;
}

export interface LoopBudgetSnapshot {
  readonly maxTransitions: number;
  readonly maxRetries: number;
  readonly maxOperations: number;
}

export interface LoopHistoryEntry {
  readonly sequence: number;
  readonly from: string;
  readonly to: string;
  readonly triggeredBy?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly autoAdvanced?: boolean | undefined;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type LoopTestStatus = "idle" | "pass" | "fail";

export interface LoopTestSummary {
  readonly status: LoopTestStatus;
  readonly passCount: number;
  readonly failCount: number;
  readonly lastRunAt: string | null;
}

export interface LoopStateSnapshot {
  readonly runId: string;
  readonly schemaVersion: number;
  readonly currentPhase: LoopPhase | string;
  readonly status: "ready" | "running" | "succeeded" | "failed" | "blocked";
  readonly usage: LoopUsageSnapshot;
  readonly budget: LoopBudgetSnapshot;
  readonly phases: readonly PhaseDisplayItem[];
  readonly history?: readonly LoopHistoryEntry[] | undefined;
  readonly testSummary?: LoopTestSummary | undefined;
  readonly lastError?: { readonly code: string; readonly message: string } | undefined;
  readonly syncError?: string | undefined;
  readonly lastUpdated: number;
}

export type McpStatusType = "connected" | "configured" | "idle" | "error" | "unknown";

export interface McpServerInfo {
  readonly name: string;
  readonly status: McpStatusType;
  readonly source: "project" | "global";
  readonly tools: readonly string[];
  readonly lastObserved?: number | undefined;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly serverName: string;
  readonly toolName: string;
  readonly status: "success" | "error" | "running";
  readonly durationMs?: number | undefined;
  readonly error?: string | undefined;
  readonly args?: JsonValue | undefined;
}

export interface McpSnapshot {
  readonly servers: readonly McpServerInfo[];
  readonly recentCalls: readonly ToolCallRecord[];
  readonly lastUpdated: number;
}

export type LogSeverity = "ERROR" | "WARNING" | "MILESTONE";

export interface CriticalLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly source: "cli" | "ai-loop" | "docker" | "system";
  readonly severity: LogSeverity;
  readonly message: string;
  readonly stackTrace?: string | undefined;
}

export interface CriticalLogSnapshot {
  readonly entries: readonly CriticalLogEntry[];
  readonly lastUpdated: number;
}

export type DockerSandboxStatus = "Active" | "Stopped" | "Missing" | "Unavailable" | "Fallback";

export interface ProviderTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface TelemetryMetrics {
  readonly gpt: ProviderTokenUsage;
  readonly gemini: ProviderTokenUsage;
  readonly estimatedCostUsd: number;
}

export type TelemetryViewScope = "session" | "allTime";

export interface TelemetrySnapshot {
  readonly gptPromptTokens: number | null;
  readonly gptCompletionTokens: number | null;
  readonly gptCacheHitTokens: number | null;
  readonly gptCacheMissTokens: number | null;
  readonly gptCacheHitPercentage: number | null;
  readonly geminiPromptTokens: number | null;
  readonly geminiCompletionTokens: number | null;
  readonly geminiCacheStatus: "Active" | "Inactive" | "Unavailable";
  readonly estimatedCostUsd: number | null;
  readonly budgetLimitUsd: number;
  readonly dockerStatus: DockerSandboxStatus;
  readonly lastUpdated: number;
  readonly currentSession: TelemetryMetrics;
  readonly allTime: TelemetryMetrics;
}

export interface RollbackResult {
  readonly success: boolean;
  readonly message: string;
  readonly previousPhase?: string | undefined;
  readonly currentPhase?: string | undefined;
}

export interface LoopResetResult {
  readonly success: boolean;
  readonly message: string;
  readonly state?: LoopStateSnapshot | undefined;
}

export interface StepForwardResult {
  readonly success: boolean;
  readonly message: string;
  readonly state?: LoopStateSnapshot | undefined;
}

export interface ProjectInfo {
  readonly name: string;
  readonly path: string;
}

export interface ProjectState {
  readonly currentProject: ProjectInfo;
  readonly recentProjects: readonly ProjectInfo[];
}

export interface CockpitApi {
  readonly project: {
    readonly getState: () => Promise<ProjectState>;
    readonly switchProject: (projectPath: string) => Promise<ProjectState>;
    readonly openProjectFolder: () => Promise<ProjectState | null>;
  };
  readonly terminal: {
    readonly start: () => Promise<void>;
    readonly write: (data: string) => void;
    readonly resize: (cols: number, rows: number) => void;
    readonly restart: () => Promise<void>;
    readonly onData: (listener: (data: string) => void) => Unsubscribe;
    readonly onExit: (listener: (event: PtyExitEvent) => void) => Unsubscribe;
  };
  readonly loop: {
    readonly getSnapshot: () => Promise<LoopStateSnapshot>;
    readonly stepForward: () => Promise<StepForwardResult>;
    readonly stepBack: () => Promise<RollbackResult>;
    readonly rollback: () => Promise<RollbackResult>;
    readonly reset: () => Promise<LoopResetResult>;
    readonly onSnapshot: (listener: (state: LoopStateSnapshot) => void) => Unsubscribe;
  };
  readonly mcp: {
    readonly getSnapshot: () => Promise<McpSnapshot>;
    readonly onSnapshot: (listener: (state: McpSnapshot) => void) => Unsubscribe;
  };
  readonly logs: {
    readonly getSnapshot: () => Promise<CriticalLogSnapshot>;
    readonly onEntries: (listener: (entries: readonly CriticalLogEntry[]) => void) => Unsubscribe;
    readonly clear: () => Promise<{ success: boolean }>;
  };
  readonly telemetry: {
    readonly getSnapshot: () => Promise<TelemetrySnapshot>;
    readonly onSnapshot: (listener: (state: TelemetrySnapshot) => void) => Unsubscribe;
    readonly resetSession: () => Promise<{ success: boolean }>;
  };
  readonly eval: {
    readonly getSnapshot: () => Promise<EvalHarnessSnapshot>;
    readonly onSnapshot: (listener: (snapshot: EvalHarnessSnapshot) => void) => Unsubscribe;
    readonly runBenchmark: () => Promise<EvalHarnessSnapshot>;
  };
}

export type EvalHarnessStatus =
  | "idle"
  | "ready"
  | "running"
  | "malformed"
  | "failed";

export interface EvalHarnessSnapshot {
  readonly status: EvalHarnessStatus;
  readonly report: EvaluationReport | null;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

