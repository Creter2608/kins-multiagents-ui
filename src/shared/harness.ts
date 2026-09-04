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

export interface BenchmarkTask {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly kind: EvaluationTaskKind;
  readonly command: EvaluationCommand;
  readonly hiddenAssertions: readonly HiddenAssertion[];
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
  readonly k: 1;
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
}
