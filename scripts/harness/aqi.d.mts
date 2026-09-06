export interface TaskProfile {
  readonly id: string;
  readonly fileBudget: number;
  readonly churnBudget: number;
  readonly hunkBudget: number;
  readonly minAqi: number;
  readonly floors?: Readonly<Record<string, number>>;
}

export const TASK_PROFILES: Readonly<Record<string, TaskProfile>>;
export const FINDING_CODES: Readonly<Record<string, string>>;

export interface ParsedDiffFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly path: string;
  readonly isNew: boolean;
  readonly isDeleted: boolean;
  readonly isRename: boolean;
  readonly isBinary: boolean;
  readonly addedLinesCount: number;
  readonly deletedLinesCount: number;
  readonly semanticChurn: number;
  readonly addedLines: readonly string[];
  readonly addedLineNumbers: readonly number[];
  readonly hunks: readonly object[];
}

export function parseUnifiedDiff(diffText: string): ParsedDiffFile[];

export function findDependencyCycles(graph: Map<string, Set<string>>): string[][];

export function isExecutableCodeComment(text: string): boolean;

export interface Finding {
  readonly code: string;
  readonly category: 'surgicalDiff' | 'simplicity' | 'modularity' | 'maintainability';
  readonly severity: 'info' | 'warning' | 'error';
  readonly file: string;
  readonly line: number | null;
  readonly evidence: string;
  readonly penalty: number;
}

export interface AnalyzeOptions {
  readonly taskType?: 'fix' | 'feat' | 'refactor' | 'bootstrap' | string;
  readonly repoRoot?: string;
  readonly sourcePairs?: Map<string, { readonly before: string | null; readonly after: string | null }>;
}

export interface ArchitectureAnalysis {
  readonly taskType: string;
  readonly files: readonly ParsedDiffFile[];
  readonly touchedFilesCount: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly findings: readonly Finding[];
  readonly hardFailures: readonly string[];
  readonly coverage: {
    readonly eligibleFiles: number;
    readonly parsedFiles: number;
  };
}

export function analyzeArchitectureChange(
  diffText: string,
  options?: AnalyzeOptions
): ArchitectureAnalysis;

export interface ScoreOptions {
  readonly minAqi?: number;
}

export interface ArchitectureScore {
  readonly aqi: number;
  readonly passed: boolean;
  readonly taskType: string;
  readonly threshold: number;
  readonly criteriaScores: {
    readonly surgicalDiff: number;
    readonly simplicity: number;
    readonly modularity: number;
    readonly maintainability: number;
  };
  readonly hardFailures: readonly string[];
  readonly findings: readonly Finding[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly feedback: readonly string[];
}

export function scoreArchitectureAnalysis(
  analysis: ArchitectureAnalysis,
  options?: ScoreOptions
): ArchitectureScore;
