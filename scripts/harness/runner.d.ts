import type {
  BenchmarkTask,
  EvaluationReport,
  EvaluationMetrics,
  EvaluationTaskResult,
  NetworkPolicy,
  DatasetVersion,
  BatchEvaluationReport
} from '../../src/shared/harness.js';
import type { SandboxOptions } from './sandbox.d.mts';
import type { AuditEventStream } from './telemetry.d.mts';

export interface ExecuteTaskCommandOptions {
  readonly sandbox?: boolean | SandboxOptions | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly securePatchPath?: string | undefined;
}

export interface RunEvaluationOptions {
  readonly repoRoot: string;
  readonly evalRoot: string;
  readonly baseCommit: string;
  readonly outputPath?: string | undefined;
  readonly sandbox?: boolean | SandboxOptions | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly securePatchPath?: string | undefined;
  readonly dataset?: DatasetVersion | undefined;
  readonly auditStream?: AuditEventStream | undefined;
  readonly auditLogPath?: string | undefined;
}


export interface BenchmarkTaskRunContext {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly evalRoot?: string | undefined;
  readonly sandbox?: boolean | SandboxOptions | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly securePatchPath?: string | undefined;
}

export interface ComputeMetricsOptions {
  readonly k?: number | undefined;
  readonly passAtK?: number | undefined;
  readonly passAtKDistributions?: Readonly<Record<number, number>> | undefined;
  readonly flakyTaskIds?: readonly string[] | undefined;
}

export function parseTask(content: unknown, sourcePath?: string): BenchmarkTask;
export function computeMetrics(
  results: readonly EvaluationTaskResult[],
  options?: ComputeMetricsOptions
): EvaluationMetrics;
export function executeTaskCommand(
  command: BenchmarkTask['command'],
  workingDir: string,
  mode: string,
  targetRoot: string,
  options?: ExecuteTaskCommandOptions
): Promise<{
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly signal: string | null;
  readonly timedOut: boolean;
}>;
export function runBenchmarkTask(
  task: BenchmarkTask,
  runContext: BenchmarkTaskRunContext
): Promise<EvaluationTaskResult>;
export function runBenchmarkBatch(
  tasks: readonly BenchmarkTask[],
  options: RunEvaluationOptions & { readonly concurrency?: number | undefined }
): Promise<EvaluationReport & BatchEvaluationReport>;
export function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationReport>;
export function main(argv?: string[]): Promise<void>;

