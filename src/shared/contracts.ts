import type { LoopPhase, PhaseDisplayItem } from "./phases.js";
import type { EvaluationReport, ArchitecturalCompliance, ArchitecturalCriteriaScores } from "./harness.js";

export type { ArchitecturalCompliance, ArchitecturalCriteriaScores };
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

export interface ResourceBudget {
  readonly maxCostMicroUsd: number;
  readonly maxTokens: number;
  readonly maxOracleCalls: number;
  readonly maxGlobalCycles: number;
  readonly maxVerificationRetries: number;
  readonly maxQualityRemediations: number;
}

export interface ResourceUsage {
  readonly costMicroUsd: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly oracleCalls: number;
  readonly globalCycles: number;
  readonly verificationRetries: number;
  readonly qualityRemediations: number;
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

export type AuditStatus =
  | "pending"
  | "running"
  | "accepted"
  | "remediation_required"
  | "closure_pending"
  | "closed"
  | "failed";

export interface AuditFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly description: string;
  readonly failingTestAssertion?: string | undefined;
  readonly resolved?: boolean | undefined;
}

export interface AuditRecord {
  readonly status: AuditStatus;
  readonly invocationKey?: string | undefined;
  readonly auditedTreeHash?: string | undefined;
  readonly findings?: readonly AuditFinding[] | undefined;
  readonly remediationCount: number;
  readonly report?: string | undefined;
  readonly completedAt?: number | undefined;
}

export type BlueprintStatus = "pending" | "running" | "ready" | "failed";

export interface GoldenAssertionSnapshot {
  readonly in: string;
  readonly out: string;
}

export type ArchitectureTaskType = "fix" | "feat" | "refactor" | "bootstrap";

export type QualityGateFailureKind = "AQI" | "AUDIT";

export type QualityGateDisposition =
  | "REMEDIATE"
  | "OVERRIDE"
  | "REJECT_REVERT";

export interface QualityGateBlock {
  readonly blockedFrom: "REALITY_CHECK";
  readonly artifactHash: string;
  readonly failureKinds: readonly QualityGateFailureKind[];
  readonly observedAqi?: number | undefined;
  readonly minAqi?: number | undefined;
  readonly auditFindingIds: readonly string[];
  readonly remediationRemaining: boolean;
  readonly overridePermitted: boolean;
}

export interface QualityGateDecisionRecord {
  readonly decisionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly disposition: QualityGateDisposition;
  readonly principalId: string;
  readonly reason: string;
  readonly feedback?: string | undefined;
  readonly ticketReference?: string | undefined;
  readonly artifactHash: string;
  readonly failureKinds: readonly QualityGateFailureKind[];
  readonly observedAqi?: number | undefined;
  readonly minAqi?: number | undefined;
  readonly auditFindingIds: readonly string[];
  readonly timestamp: number;
}

export interface BlueprintRecordSnapshot {
  readonly status: BlueprintStatus;
  readonly invocationKey: string;
  readonly invocationCount: 0 | 1;
  readonly artifactPath: ".ai/blueprint.md";
  readonly plannedTreeHash: string;
  readonly protectedEvalHash?: string | undefined;
  readonly artifactSha256?: string | undefined;
  readonly assertionsSha256?: string | undefined;
  readonly goldenAssertions?: readonly GoldenAssertionSnapshot[] | undefined;
  readonly completedAt?: number | undefined;
  readonly failureCode?: string | undefined;
  readonly taskType?: ArchitectureTaskType | undefined;
}

export interface AuthenticatedBlueprintApproval {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly canonicalWorkspacePath: string;
  readonly blueprintSha256: string;
  readonly approvedAt: string;
  readonly signature: string;
}

export interface LoopStateSnapshot {
  readonly runId: string;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly currentPhase: LoopPhase | string;
  readonly status: "ready" | "running" | "succeeded" | "failed" | "blocked";
  readonly usage: LoopUsageSnapshot;
  readonly budget: LoopBudgetSnapshot;
  readonly resourceBudget: ResourceBudget;
  readonly resourceUsage: ResourceUsage;
  readonly phases: readonly PhaseDisplayItem[];
  readonly history?: readonly LoopHistoryEntry[] | undefined;
  readonly testSummary?: LoopTestSummary | undefined;
  readonly architecturalCompliance?: ArchitecturalCompliance | undefined;
  readonly goldenSha256?: string | undefined;
  readonly blueprint?: BlueprintRecordSnapshot | undefined;
  readonly blueprintApproval?: AuthenticatedBlueprintApproval | undefined;
  readonly audit?: AuditRecord | undefined;
  readonly qualityGateBlock?: QualityGateBlock | undefined;
  readonly qualityGateDecisions?: readonly QualityGateDecisionRecord[] | undefined;
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

export interface GateDecisionInput {
  readonly runId: string;
  readonly expectedPhase: "SPEC_GATE" | "RELEASE_GATE" | "BLOCKED";
  readonly decision: "approve" | "reject" | "remediate" | "override_quality_gate";
  readonly reason?: string | undefined;
  readonly feedback?: string | undefined;
  readonly ticketReference?: string | undefined;
  readonly artifactHash?: string | undefined;
}

export interface GateDecisionResult {
  readonly success: boolean;
  readonly message: string;
  readonly state?: LoopStateSnapshot | undefined;
}

export type RuleSource =
  | "host-policy"
  | "user-global-constraint"
  | "workspace-sidecar"
  | "repository-native"
  | "user-global-preference";

export interface ResolvedRuleBlock {
  readonly source: RuleSource;
  readonly origin: string;
  readonly content: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
}

export interface WorkspaceContext {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
  readonly sidecarDirectory: string;
  readonly rules: readonly ResolvedRuleBlock[];
}

export type GlobalIdeTarget = "gemini" | "claude" | "cursor";
export type StealthRuleTarget = "agents" | "claude";

export interface GlobalIdeSyncResult {
  readonly success: boolean;
  readonly synced: readonly string[];
}

export interface StealthEquipResult {
  readonly success: boolean;
  readonly filesCreated: readonly string[];
  readonly excluded: boolean;
}

export interface StealthUnequipResult {
  readonly success: boolean;
  readonly filesRemoved: readonly string[];
}

export interface WorkspaceStealthStatus {
  readonly equipped: boolean;
  readonly excluded: boolean;
  readonly files: readonly string[];
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
    readonly getWorkspaceContext?: () => Promise<WorkspaceContext | null>;
    readonly syncGlobalIdeRules?: (options?: { targets?: readonly GlobalIdeTarget[] }) => Promise<GlobalIdeSyncResult>;
    readonly equipStealthRules?: (options?: { targets?: readonly StealthRuleTarget[] }) => Promise<StealthEquipResult>;
    readonly unequipStealthRules?: () => Promise<StealthUnequipResult>;
    readonly getStealthStatus?: () => Promise<WorkspaceStealthStatus>;
    readonly onProjectChanged?: (listener: (state: ProjectState) => void) => Unsubscribe;
    readonly onWorkspaceContextChanged?: (listener: (context: WorkspaceContext) => void) => Unsubscribe;
  };
  readonly terminal: {
    readonly start: () => Promise<void>;
    readonly write: (data: string) => void;
    readonly resize: (cols: number, rows: number) => void;
    readonly restart: () => Promise<void>;
    readonly onData: (listener: (data: string) => void) => Unsubscribe;
    readonly onExit: (listener: (event: PtyExitEvent) => void) => Unsubscribe;
    readonly onClear?: (listener: () => void) => Unsubscribe;
  };
  readonly loop: {
    readonly getSnapshot: () => Promise<LoopStateSnapshot>;
    readonly stepForward: () => Promise<StepForwardResult>;
    readonly stepBack: () => Promise<RollbackResult>;
    readonly rollback: () => Promise<RollbackResult>;
    readonly reset: () => Promise<LoopResetResult>;
    readonly decideGate?: (input: GateDecisionInput) => Promise<GateDecisionResult>;
    readonly evaluateArchitecture?: () => Promise<ArchitecturalCompliance | null>;
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
  readonly subagents?: {
    readonly getSubagents: () => Promise<SubagentActivity[]>;
    readonly onSubagentsChanged: (listener: (activities: SubagentActivity[]) => void) => Unsubscribe;
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

export type SubagentStatus =
  | "running"
  | "idle"
  | "completed"
  | "error";

export interface SubagentActivity {
  readonly id: string;
  readonly role: string;
  readonly model: string;
  readonly promptSummary: string;
  readonly fullPrompt?: string | undefined;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly elapsedMs: number;
  readonly errorMessage?: string | undefined;
}

export interface SubagentInvocationInput {
  readonly id: string;
  readonly role?: string | undefined;
  readonly model?: string | undefined;
  readonly prompt?: string | undefined;
  readonly startedAt?: number | undefined;
}

export interface SubagentStatusUpdate {
  readonly id: string;
  readonly status: SubagentStatus;
  readonly timestamp?: number | undefined;
  readonly errorMessage?: string | undefined;
}

export const SUBAGENT_IPC_CHANNELS = {
  list: "subagents:list",
  changed: "subagents:changed",
} as const;

