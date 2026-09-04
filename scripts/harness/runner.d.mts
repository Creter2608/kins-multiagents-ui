import type { BenchmarkTask, EvaluationReport, EvaluationMetrics, EvaluationTaskResult } from '../../src/shared/harness.js';

export interface RunEvaluationOptions {
  repoRoot: string;
  evalRoot: string;
  baseCommit: string;
  outputPath?: string | undefined;
}

export function parseTask(content: unknown, sourcePath?: string): BenchmarkTask;
export function computeMetrics(results: readonly EvaluationTaskResult[]): EvaluationMetrics;
export function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationReport>;
export function main(argv?: string[]): Promise<void>;
