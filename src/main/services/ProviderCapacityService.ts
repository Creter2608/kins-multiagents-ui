import type { ProviderCapacity } from "../../shared/providerCapacity.js";
import { isCapacityActive } from "../../shared/providerCapacity.js";

function cloneCapacity(cap: ProviderCapacity): ProviderCapacity {
  return {
    provider: cap.provider,
    scope: cap.scope,
    metric: cap.metric,
    limit: cap.limit,
    remaining: cap.remaining,
    remainingPercentage: cap.remainingPercentage,
    resetAt: cap.resetAt,
    windowSeconds: cap.windowSeconds,
    windowKind: cap.windowKind,
    source: cap.source,
    observedAt: cap.observedAt,
    expiresAt: cap.expiresAt
  };
}

export class ProviderCapacityService {
  private observations = new Map<string, ProviderCapacity>();
  private listeners = new Set<(capacities: readonly ProviderCapacity[]) => void>();

  /**
   * Records a provider capacity observation.
   * Isolates internal state by defensively copying input.
   */
  record(observation: ProviderCapacity): void {
    if (!observation || !observation.provider || !observation.scope) {
      return;
    }

    const key = `${observation.provider}::${observation.scope}`;
    this.observations.set(key, cloneCapacity(observation));

    const currentSnapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(currentSnapshot);
    }
  }

  /**
   * Retrieves a snapshot of provider capacities with strict expiry evaluation.
   * Golden Assertion 4: If an observation has expired, its source becomes "unavailable"
   * and remaining/limit/percentage are nullified, ensuring no false or stale quota is displayed.
   */
  snapshot(now: Date = new Date()): readonly ProviderCapacity[] {
    const nowMs = now.getTime();
    const result: ProviderCapacity[] = [];

    for (const obs of this.observations.values()) {
      const active = isCapacityActive(obs, nowMs);
      if (!active) {
        // Expired or unavailable
        result.push({
          ...cloneCapacity(obs),
          source: "unavailable",
          remaining: null,
          limit: null,
          remainingPercentage: null
        });
      } else {
        result.push(cloneCapacity(obs));
      }
    }

    return Object.freeze(result);
  }

  subscribe(listener: (capacities: readonly ProviderCapacity[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.observations.clear();
  }
}
