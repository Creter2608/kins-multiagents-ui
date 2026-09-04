/**
 * src/shared/harness.ts
 * Type definitions and contracts for the Autonomous Agent Evaluation Benchmark Harness.
 */

export type EvaluationTaskKind = "f2p" | "p2p";

export interface EvaluationCommand {
  readonly argv: readonly [string, ...string[]];
  readonly timeoutMs: number;
}

export interface HiddenAssertion {
  readonly path: string;
  readonly sha256: string;
}

export type NetworkPolicy =
  | { readonly mode: "none" }
  | {
      readonly mode: "allowlist";
      readonly proxyUrl: string;
      readonly allowedHosts: readonly string[];
    };

export interface DatasetVersion {
  readonly datasetId: string;
  readonly version: string;
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly createdAt: string;
}

export interface TaskProvenance {
  readonly repositoryUrl: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly sourceType: "commit" | "issue";
  readonly sourceId: string;
  readonly license: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly source: "provider" | "gateway" | "unavailable";
}

export interface CostAttribution {
  readonly pricingCatalogVersion: string;
  readonly currency: "USD";
  readonly inputMicroUsd: number;
  readonly outputMicroUsd: number;
  readonly cacheMicroUsd: number;
  readonly surchargeMicroUsd: number;
  readonly totalMicroUsd: number;
}

export interface WorkerAttempt {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly workerId: string;
  readonly containerId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tokenUsage: TokenUsage;
  readonly cost: CostAttribution | null;
}

export interface BenchmarkTask {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly kind: EvaluationTaskKind;
  readonly command: EvaluationCommand;
  readonly hiddenAssertions: readonly HiddenAssertion[];
  readonly datasetId?: string | undefined;
  readonly datasetVersion?: string | undefined;
  readonly manifestSha256?: string | undefined;
  readonly provenance?: TaskProvenance | undefined;
  readonly weight?: number | undefined;
}

export interface TaskExecution {
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export interface EvaluationTaskResult {
  readonly id: string;
  readonly kind: EvaluationTaskKind;
  readonly base: TaskExecution;
  readonly current: TaskExecution;
  readonly passed: boolean;
}

export interface EvaluationMetrics {
  readonly passAt1: number;
  readonly passAtK: number;
  readonly k: number;
  readonly passAtKDistributions?: Readonly<Record<number, number>> | undefined;
  readonly flakyTaskIds?: readonly string[] | undefined;
  readonly ssi: number;
}

export type AntiGamingViolationCode =
  | "FORBIDDEN_FILE_MODIFIED"
  | "ASSERTION_COMMENTED_OUT"
  | "ASSERTION_REMOVED"
  | "ASSERTION_SWALLOWED"
  | "MOCK_EVASION";

export interface AntiGamingViolation {
  readonly code: AntiGamingViolationCode;
  readonly path: string;
  readonly line?: number | undefined;
  readonly message: string;
}

export interface AntiGamingResult {
  readonly clean: boolean;
  readonly violations: readonly AntiGamingViolation[];
}

export type AntiGamingOptions = Readonly<Record<string, never>>;

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly baseCommit: string;
  readonly metrics: EvaluationMetrics;
  readonly passed: boolean;
  readonly results: readonly EvaluationTaskResult[];
  readonly violations: readonly AntiGamingViolation[];
  readonly flakyTaskIds?: readonly string[] | undefined;
}

export interface BatchEvaluationReport {
  readonly schemaVersion: 1;
  readonly dataset: DatasetVersion;
  readonly attempts: readonly WorkerAttempt[];
  readonly taskReports: readonly EvaluationReport[];
  readonly weightedPassed: number;
  readonly totalCostMicroUsd: number;
  readonly dollarEfficiencyIndex: number | null;
  readonly auditDigest: string;
}

