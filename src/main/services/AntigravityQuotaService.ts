import type { ProviderCapacityService } from "./ProviderCapacityService.js";
import type { AntigravityQuotaTransport, AntigravityEndpoint } from "./AntigravityQuotaClient.js";
import { parseAntigravityQuota, parseQuotaResponse } from "./antigravityQuotaTransform.js";

export type AntigravityRefreshReason =
  | "startup"
  | "interval"
  | "loop-complete"
  | "manual"
  | "reset";

export interface AntigravityQuotaServiceOptions {
  readonly pollingIntervalMs?: number;
  readonly freshnessMs?: number;
  readonly cooldownMs?: number;
  readonly deadlineMs?: number;
}

export class AntigravityQuotaService {
  private readonly capacityService: ProviderCapacityService;
  private readonly transport: AntigravityQuotaTransport;
  private readonly pollingIntervalMs: number;
  private readonly freshnessMs: number;
  private readonly cooldownMs: number;
  private readonly deadlineMs: number;

  private pollTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private cachedEndpoint: AntigravityEndpoint | null = null;
  private ownedScopes = new Set<string>();
  private activeRefreshPromise: Promise<void> | null = null;
  private lastRefreshMs = 0;
  private isDisposed = false;

  constructor(
    capacityService: ProviderCapacityService,
    transport: AntigravityQuotaTransport,
    options?: AntigravityQuotaServiceOptions
  ) {
    this.capacityService = capacityService;
    this.transport = transport;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 60_000;
    this.freshnessMs = options?.freshnessMs ?? 120_000;
    this.cooldownMs = options?.cooldownMs ?? 5_000;
    this.deadlineMs = options?.deadlineMs ?? 15_000;
  }

  start(): void {
    if (this.isDisposed || this.pollTimer) {
      return;
    }

    // Trigger initial startup refresh
    void this.refresh("startup").catch(() => {
      // Background startup error fails closed without throwing
    });

    // Schedule regular polling interval
    this.pollTimer = setInterval(() => {
      void this.refresh("interval").catch(() => {
        // Polling error handled gracefully
      });
    }, this.pollingIntervalMs);
  }

  async refresh(reason: AntigravityRefreshReason): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    // Cooldown protection: minimum 5s between request batches unless triggered by reset epoch
    const now = Date.now();
    if (reason !== "reset" && now - this.lastRefreshMs < this.cooldownMs) {
      if (this.activeRefreshPromise) {
        return this.activeRefreshPromise;
      }
      return;
    }

    // Single-flight: share identical in-flight promise
    if (this.activeRefreshPromise) {
      return this.activeRefreshPromise;
    }

    this.activeRefreshPromise = this.performRefresh(reason)
      .finally(() => {
        this.activeRefreshPromise = null;
      });

    return this.activeRefreshPromise;
  }

  private async performRefresh(reason: AntigravityRefreshReason): Promise<void> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.deadlineMs);
    this.lastRefreshMs = Date.now();

    try {
      const candidates: AntigravityEndpoint[] = [];

      // 1. Try cached endpoint first if previously verified
      if (this.cachedEndpoint) {
        candidates.push(this.cachedEndpoint);
      }

      // 2. Discover candidates if no cached endpoint or to supplement
      const discovered = await this.transport.discover(controller.signal);
      for (const ep of discovered) {
        if (!candidates.some((c) => c.port === ep.port)) {
          candidates.push(ep);
        }
      }

      let success = false;
      const observedAt = new Date();

      for (const endpoint of candidates) {
        if (controller.signal.aborted || this.isDisposed) {
          break;
        }

        try {
          const rawResponse = await this.transport.getUserStatus(endpoint, controller.signal);
          const quotaResult = parseQuotaResponse(rawResponse, observedAt, this.freshnessMs);
          const capacities = quotaResult.status === "available"
            ? quotaResult.quota
            : parseAntigravityQuota(rawResponse, observedAt, this.freshnessMs);

          if (capacities.length > 0 && quotaResult.status !== "unavailable") {
            // Structurally recognized response: cache endpoint
            this.cachedEndpoint = endpoint;
            success = true;

            const nextOwnedScopes = new Set<string>();
            let nearestResetMs: number | null = null;

            for (const cap of capacities) {
              nextOwnedScopes.add(cap.scope);
              this.capacityService.record(cap);

              if (cap.resetAt) {
                const rMs = new Date(cap.resetAt).getTime();
                if (Number.isFinite(rMs) && rMs > observedAt.getTime()) {
                  if (nearestResetMs === null || rMs < nearestResetMs) {
                    nearestResetMs = rMs;
                  }
                }
              }
            }

            // Invalidate previously owned scopes absent from the new result
            for (const oldScope of this.ownedScopes) {
              if (!nextOwnedScopes.has(oldScope)) {
                this.publishUnavailable(oldScope, observedAt);
              }
            }

            this.ownedScopes = nextOwnedScopes;

            // Schedule bounded reset timer for the nearest valid reset epoch
            this.scheduleResetTimer(nearestResetMs);
            break;
          }
        } catch {
          // If cached endpoint failed, invalidate cache and try others
          if (this.cachedEndpoint && this.cachedEndpoint.port === endpoint.port) {
            this.cachedEndpoint = null;
          }
        }
      }

      // If all candidates failed or no candidates found: publish unavailable for previously owned scopes
      if (!success) {
        this.cachedEndpoint = null;
        for (const scope of this.ownedScopes) {
          this.publishUnavailable(scope, observedAt);
        }
      }
    } catch {
      this.cachedEndpoint = null;
      const observedAt = new Date();
      for (const scope of this.ownedScopes) {
        this.publishUnavailable(scope, observedAt);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private publishUnavailable(scope: string, observedAt: Date): void {
    this.capacityService.record({
      provider: "gemini",
      scope,
      metric: "requests",
      limit: null,
      remaining: null,
      resetAt: null,
      windowSeconds: null,
      windowKind: "unknown",
      source: "unavailable",
      observedAt: observedAt.toISOString(),
      expiresAt: null
    });
  }

  private scheduleResetTimer(resetMs: number | null): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    if (resetMs === null || this.isDisposed) {
      return;
    }

    const now = Date.now();
    const delayMs = Math.max(500, resetMs - now + 500); // 500ms grace after epoch

    // Cap delay to 24 hours to avoid 32-bit timer overflow
    const boundedDelay = Math.min(delayMs, 24 * 60 * 60 * 1000);

    this.resetTimer = setTimeout(() => {
      void this.refresh("reset").catch(() => {
        // Reset timer error handled gracefully
      });
    }, boundedDelay);
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.cachedEndpoint = null;
    this.activeRefreshPromise = null;
  }
}
