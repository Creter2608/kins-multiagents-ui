export const DEFAULT_MIN_AQI: number;

export interface CriteriaScores {
  readonly surgicalDiff: number;
  readonly simplicity: number;
  readonly modularity: number;
  readonly maintainability: number;
}

export interface ArchitecturalComplianceResult {
  readonly aqi: number;
  readonly passed: boolean;
  readonly criteriaScores: CriteriaScores;
  readonly feedback: readonly string[];
}

export interface EvaluateComplianceOptions {
  readonly minAqi?: number | undefined;
}

export function evaluateArchitecturalCompliance(
  diffText: string,
  options?: EvaluateComplianceOptions
): ArchitecturalComplianceResult;

export function buildJudgeEvaluationPrompt(
  diffText: string,
  context?: { readonly taskDescription?: string | undefined }
): string;
