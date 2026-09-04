/**
 * scripts/harness/ast-merger.d.mts
 * TypeScript type definitions for the AST-Level 3-Way Worktree Merger.
 */

export interface MergeOptions {
  readonly fileName?: string | undefined;
}

export interface WorktreeOptions extends MergeOptions {
  readonly outputDir?: string | undefined;
}

export type ConflictKind =
  | "declaration"
  | "interface-member"
  | "type-member"
  | "delete-modify"
  | "file";

export interface ConflictRecord {
  readonly kind: ConflictKind;
  readonly symbol?: string | undefined;
  readonly filePath?: string | undefined;
  readonly message: string;
  readonly base?: string | undefined;
  readonly current?: string | undefined;
  readonly incoming?: string | undefined;
}

export interface MergeResult {
  readonly code: string;
  readonly clean: boolean;
  readonly conflictsCount: number;
  readonly autoMergedCount: number;
  readonly conflicts: readonly ConflictRecord[];
}

export interface FileMergeResult extends MergeResult {
  readonly filePath: string;
  readonly baseFilePath?: string | undefined;
  readonly currentFilePath?: string | undefined;
  readonly incomingFilePath?: string | undefined;
}

export interface WorktreeMergeResult {
  readonly clean: boolean;
  readonly conflictsCount: number;
  readonly autoMergedCount: number;
  readonly files: readonly FileMergeResult[];
  readonly conflicts: readonly ConflictRecord[];
}

export function mergeSource3Way(
  baseCode: string,
  currentCode: string,
  incomingCode: string,
  options?: MergeOptions
): MergeResult;

export function mergeFiles3Way(
  baseFilePath: string,
  currentFilePath: string,
  incomingFilePath: string,
  options?: MergeOptions
): Promise<FileMergeResult>;

export function mergeWorktrees3Way(
  baseDir: string,
  currentDir: string,
  incomingDir: string,
  options?: WorktreeOptions
): Promise<WorktreeMergeResult>;
