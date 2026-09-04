/**
 * scripts/harness/worker-pool.d.mts
 * Type declarations for Parallel Worker Pool & Ephemeral Container Orchestration.
 */

import type {
  BenchmarkTask,
  EvaluationTaskResult,
  EvaluationMetrics,
  NetworkPolicy,
  WorkerAttempt
} from "../../src/shared/harness.js";
import type { SandboxOptions } from "./sandbox.d.mts";

export interface PoolOptions {
  readonly concurrency?: number | undefined;
  readonly taskTimeoutMs?: number | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly sandbox?: boolean | SandboxOptions | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly repoRoot?: string | undefined;
  readonly baseCommit?: string | undefined;
  readonly runId?: string | undefined;
}

export interface WorkerContext {
  readonly workerId: string;
  readonly runId: string;
  readonly attemptIndex: number;
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly sandbox?: boolean | SandboxOptions | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
}

export interface PoolTaskOutcome {
  readonly taskResult: EvaluationTaskResult;
  readonly attempt: WorkerAttempt;
}

export interface PoolBatchResult {
  readonly runId: string;
  readonly results: readonly EvaluationTaskResult[];
  readonly attempts: readonly WorkerAttempt[];
  readonly metrics: EvaluationMetrics;
  readonly passed: boolean;
  readonly peakWorkers: number;
}

export function validatePoolOptions(options?: unknown): { readonly valid: boolean; readonly errors: readonly string[] };

export function runTaskPool(
  tasks: readonly BenchmarkTask[],
  taskExecutor: (task: BenchmarkTask, workerCtx: WorkerContext) => Promise<PoolTaskOutcome>,
  options?: PoolOptions
): Promise<PoolBatchResult>;
