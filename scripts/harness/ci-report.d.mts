import type { EvaluationReport, BatchEvaluationReport } from '../../src/shared/harness.js';

export const SCORECARD_MARKER: string;

export interface CompareReportsOptions {
  readonly minPassAt1?: number | undefined;
  readonly maxPassAt1Regression?: number | undefined;
  readonly maxSsiRegression?: number | undefined;
  readonly requireCleanViolations?: boolean | undefined;
}

export interface MetricComparison {
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  readonly passed?: boolean | undefined;
}

export interface BenchmarkComparisonResult {
  readonly incomparable: boolean;
  readonly incomparableReason?: string | undefined;
  readonly gatePassed: boolean;
  readonly failureReasons: readonly string[];
  readonly metrics?: {
    readonly passAt1: MetricComparison;
    readonly ssi: MetricComparison;
    readonly dei: {
      readonly baseline: number | null;
      readonly candidate: number | null;
      readonly delta: number | null;
    };
    readonly costMicroUsd: {
      readonly baseline: number;
      readonly candidate: number;
      readonly delta: number;
    };
    readonly violations: {
      readonly baselineCount: number;
      readonly candidateCount: number;
      readonly clean: boolean;
    };
  } | undefined;
}

export type BenchmarkReportInput =
  | EvaluationReport
  | BatchEvaluationReport
  | (Partial<BatchEvaluationReport> & {
      readonly schemaVersion: number;
      readonly metrics?: any;
      readonly violations?: readonly any[] | undefined;
      readonly [key: string]: any;
    });

export function compareBenchmarkReports(
  baseline: BenchmarkReportInput,
  candidate: BenchmarkReportInput,
  options?: CompareReportsOptions
): BenchmarkComparisonResult;

export function generateMarkdownScorecard(
  comparison: BenchmarkComparisonResult,
  options?: { readonly prNumber?: number | string | undefined; readonly commitSha?: string | undefined }
): string;
