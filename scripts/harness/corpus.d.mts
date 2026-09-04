/**
 * scripts/harness/corpus.d.mts
 * Type declarations for the Benchmark Corpus Management & Task Ingestion Engine.
 */

import type { BenchmarkTask, EvaluationTaskKind } from "../../src/shared/harness.js";

export interface TaskCommandSpec {
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
}

export interface TaskHiddenAssertionSpec {
  readonly path: string;
  readonly sha256?: string;
}

export interface IngestTaskOptions {
  readonly repoRoot?: string;
  readonly taskId: string;
  readonly title: string;
  readonly datasetId?: string;
  readonly datasetVersion?: string;
  readonly repositoryUrl?: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly sourceType?: "commit" | "issue";
  readonly sourceId?: string;
  readonly license?: string;
  readonly taskType: EvaluationTaskKind;
  readonly weight?: number;
  readonly commands: readonly TaskCommandSpec[] | TaskCommandSpec;
  readonly hiddenAssertions?: readonly TaskHiddenAssertionSpec[];
  readonly publicFiles?: readonly string[];
  readonly stagingDir?: string;
  readonly validateSemantics?: boolean;
}

export interface TaskManifest {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly title: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly repositoryUrl: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly sourceType: "commit" | "issue";
  readonly sourceId: string;
  readonly license: string;
  readonly taskType: EvaluationTaskKind;
  readonly weight: number;
  readonly publicFiles: readonly string[];
  readonly goldenBundleDigest: string;
  readonly containerImageDigest?: string;
  readonly commands: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
  readonly hiddenAssertions: readonly { readonly path: string; readonly sha256: string }[];
  readonly manifestSha256: string;
}

export interface IngestResult {
  readonly taskId: string;
  readonly manifestPath: string;
  readonly benchmarkTaskPath: string;
  readonly manifestSha256: string;
  readonly validated: boolean;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CorpusVerificationResult {
  readonly valid: boolean;
  readonly count: number;
  readonly issues: readonly string[];
}

export function canonicalizeTaskManifest(manifest: Record<string, unknown>): string;
export function hashTaskManifest(manifest: Record<string, unknown>): string;
export function validateCandidateTask(candidate: unknown, options?: { readonly verifyDigest?: boolean }): ValidationResult;
export function ingestTask(options: IngestTaskOptions): Promise<IngestResult>;
export function verifyCorpus(corpusDir: string): Promise<CorpusVerificationResult>;
