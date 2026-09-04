import type { BenchmarkTask } from '../../src/shared/harness.js';

export interface FlakinessResult {
  readonly taskId: string;
  readonly isFlaky: boolean;
  readonly runs: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly flakinessRate: number;
}

export interface FlakinessFilterResult {
  readonly stableTasks: readonly BenchmarkTask[];
  readonly flakyTasks: readonly BenchmarkTask[];
  readonly flakyTaskIds: readonly string[];
}

export interface JitterOptions {
  readonly minMs?: number | undefined;
  readonly maxMs?: number | undefined;
}

export interface DetectFlakinessOptions {
  readonly runs?: number | undefined;
  readonly stopOnFirstVariance?: boolean | undefined;
  readonly jitter?: JitterOptions | undefined;
}

export function estimatePassAtK(n: number, c: number, k: number): number;

export function computePassAtKDistribution(
  tasksWithAttempts: readonly { readonly id: string; readonly attempts: readonly boolean[] }[],
  kValues?: readonly number[]
): Readonly<Record<number, number>>;

export function detectTaskFlakiness(
  task: BenchmarkTask | { readonly id: string },
  executeFn: (task: any, runIndex: number) => Promise<{ readonly passed: boolean }>,
  options?: DetectFlakinessOptions
): Promise<FlakinessResult>;

export function filterFlakyTasks(
  tasks: readonly BenchmarkTask[],
  flakinessResults: readonly FlakinessResult[]
): FlakinessFilterResult;

export function injectExecutionJitter(options?: JitterOptions): Promise<number>;

export function injectCpuStress(durationMs?: number): number;
