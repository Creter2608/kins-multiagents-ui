export interface ContextItem {
  readonly id: string;
  readonly kind: "instructions" | "mcp-schema" | "other";
  readonly text: string;
  readonly required: boolean;
  readonly removable: boolean;
  readonly origin?: string | undefined;
}

export type ContextFindingReason = "duplicate" | "large" | "unused-tool";
export type ContextFindingSeverity = "info" | "warning";

export interface ContextFinding {
  readonly itemIds: readonly string[];
  readonly reason: ContextFindingReason;
  readonly estimatedAvoidableTokens: number | null;
  readonly severity: ContextFindingSeverity;
  readonly message: string;
}

export type ContextEstimationType = "tokenizer" | "heuristic" | "unavailable";

export interface ContextOptimizationReport {
  readonly totalChars: number;
  readonly estimatedInputTokens: number | null;
  readonly estimation: ContextEstimationType;
  readonly findings: readonly ContextFinding[];
  readonly avoidableTokens: number;
}

/**
 * Deterministic character-based token estimator heuristic (~4 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
