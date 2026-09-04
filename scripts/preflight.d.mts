export interface SyntaxDiagnosticError {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
}

export interface CheckSyntaxResult {
  readonly passed: boolean;
  readonly checkedCount: number;
  readonly errors: readonly SyntaxDiagnosticError[];
}

export interface BenchmarkResult {
  readonly minMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
  readonly p95Ms: number;
}

export function getChangedTsFiles(cwd?: string): string[];
export function checkSyntaxDiagnostics(filePaths: string[]): CheckSyntaxResult;
export function benchmarkPreflight(filePaths: string[], iterations?: number): BenchmarkResult;
