export type ProviderId = "openai" | "gemini" | "anthropic";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Cached tokens are a subset of inputTokens; never add this again to total tokens.
   */
  readonly cachedInputTokens: number;
}

export type AttributionProvenance = "transcript" | "launch" | "observation";

export interface WorktreeAttribution {
  readonly repositoryId: string; // Opaque local identifier, not an exposed raw sensitive path
  readonly worktreeId: string;
  readonly branch: string | null; // null for detached HEAD
  readonly commit: string | null;
  readonly provenance: AttributionProvenance;
}

export interface UsageEvent {
  readonly id: string; // Stable source-derived key for idempotency
  readonly sourceId: string;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly provider: ProviderId;
  readonly tool: string;
  readonly model: string | null;
  readonly runId: string | null;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly tokens: TokenUsage;
  readonly estimatedCostUsd: number | null;
  readonly pricingVersion: string | null;
  readonly attribution: WorktreeAttribution | null;
}

export interface BranchUsageSummary {
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly branch: string | null;
  readonly tokens: TokenUsage;
  readonly knownEstimatedCostUsd: number;
  readonly unpricedEventCount: number;
}

/**
 * Calculates canonical total tokens. Cached input tokens are a subset of inputTokens
 * and must NEVER be double-counted.
 */
export function calculateTotalTokens(tokens: TokenUsage): number {
  return Math.max(0, tokens.inputTokens) + Math.max(0, tokens.outputTokens);
}
