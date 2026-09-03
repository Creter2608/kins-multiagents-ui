import type { TelemetrySnapshot, DockerSandboxStatus } from "../../shared/contracts.js";

export function calculateCacheHitPercentage(hit: number | null, miss: number | null): number | null {
  if (hit === null || miss === null) {
    return null;
  }
  const total = hit + miss;
  // Assertion 3: {"in":"cache hit=0, miss=0","out":"percentage unavailable; never NaN"}
  if (total <= 0) {
    return null;
  }
  return Math.round((hit / total) * 1000) / 10;
}

export function calculateEstimatedCostUsd(
  gptPrompt: number | null,
  gptCompletion: number | null,
  geminiPrompt: number | null,
  geminiCompletion: number | null
): number | null {
  if (gptPrompt === null && gptCompletion === null && geminiPrompt === null && geminiCompletion === null) {
    return null;
  }
  // Standard pricing reference (GPT-4o/5 class ~$2.5/1M in, $10/1M out; Gemini 2.0 Flash ~$0.10/1M in, $0.40/1M out)
  const gptIn = (gptPrompt ?? 0) * 0.0000025;
  const gptOut = (gptCompletion ?? 0) * 0.00001;
  const geminiIn = (geminiPrompt ?? 0) * 0.0000001;
  const geminiOut = (geminiCompletion ?? 0) * 0.0000004;

  const total = gptIn + gptOut + geminiIn + geminiOut;
  return Math.round(total * 10000) / 10000;
}

export class TelemetryService {
  private snapshot: TelemetrySnapshot = {
    gptPromptTokens: null,
    gptCompletionTokens: null,
    gptCacheHitTokens: null,
    gptCacheMissTokens: null,
    gptCacheHitPercentage: null,
    geminiPromptTokens: null,
    geminiCompletionTokens: null,
    geminiCacheStatus: "Unavailable",
    estimatedCostUsd: null,
    budgetLimitUsd: 0.50,
    dockerStatus: "Unavailable",
    lastUpdated: Date.now()
  };

  private listeners = new Set<(snapshot: TelemetrySnapshot) => void>();

  getSnapshot(): TelemetrySnapshot {
    return this.snapshot;
  }

  updateMetrics(partial: Partial<TelemetrySnapshot>): void {
    const nextGptHit = partial.gptCacheHitTokens !== undefined ? partial.gptCacheHitTokens : this.snapshot.gptCacheHitTokens;
    const nextGptMiss = partial.gptCacheMissTokens !== undefined ? partial.gptCacheMissTokens : this.snapshot.gptCacheMissTokens;

    const hitPct = calculateCacheHitPercentage(nextGptHit, nextGptMiss);

    const gptPrompt = partial.gptPromptTokens !== undefined ? partial.gptPromptTokens : this.snapshot.gptPromptTokens;
    const gptComp = partial.gptCompletionTokens !== undefined ? partial.gptCompletionTokens : this.snapshot.gptCompletionTokens;
    const geminiPrompt = partial.geminiPromptTokens !== undefined ? partial.geminiPromptTokens : this.snapshot.geminiPromptTokens;
    const geminiComp = partial.geminiCompletionTokens !== undefined ? partial.geminiCompletionTokens : this.snapshot.geminiCompletionTokens;

    const cost = calculateEstimatedCostUsd(gptPrompt, gptComp, geminiPrompt, geminiComp);

    this.snapshot = {
      ...this.snapshot,
      ...partial,
      gptCacheHitPercentage: hitPct,
      estimatedCostUsd: cost,
      lastUpdated: Date.now()
    };

    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  updateDockerStatus(status: DockerSandboxStatus): void {
    this.updateMetrics({ dockerStatus: status });
  }

  subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
