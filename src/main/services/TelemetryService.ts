import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type {
  TelemetrySnapshot,
  DockerSandboxStatus,
  ProviderTokenUsage,
  TelemetryMetrics
} from "../../shared/contracts.js";
import type { UsageEvent, BranchUsageSummary } from "../../shared/usage.js";
import type { ProviderCapacity } from "../../shared/providerCapacity.js";
import { calculateTotalTokens } from "../../shared/usage.js";

const require = createRequire(import.meta.url);

export function createZeroUsage(): ProviderTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0
  };
}

export function createZeroMetrics(): TelemetryMetrics {
  return {
    gpt: createZeroUsage(),
    gemini: createZeroUsage(),
    estimatedCostUsd: 0
  };
}

export function calculateCacheHitPercentage(hit: number | null, miss: number | null): number | null {
  if (hit === null || miss === null) {
    return null;
  }
  const total = hit + miss;
  // Assertion 3: {"in":"cache hit=0, miss=0","out":"percentage unavailable; never NaN"}
  if (total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((hit / total) * 1000) / 10));
}

export function calculateEstimatedCostUsd(
  gptPrompt: number | null,
  gptCompletion: number | null,
  gptCacheHit?: number | null,
  _geminiPrompt?: number | null,
  _geminiCompletion?: number | null
): number | null {
  if (gptPrompt === null && gptCompletion === null) {
    return null;
  }
  const input = Math.max(0, gptPrompt ?? 0);
  const cached = Math.min(input, Math.max(0, gptCacheHit ?? 0));
  const uncached = Math.max(0, input - cached);
  const output = Math.max(0, gptCompletion ?? 0);

  // gpt-6.1-sol pricing:
  // Input (uncached): $2.00 / 1M = $0.000002/token
  // Cached input:    $0.10 / 1M = $0.0000001/token (5% of uncached rate)
  // Output:         $10.00 / 1M = $0.000010/token
  // Gemini:          $0.00 (Pro subscription)
  const gptCost = uncached * 0.000002 + cached * 0.0000001 + output * 0.00001;
  return Math.round(gptCost * 10000) / 10000;
}

function validateMetrics(data: unknown): TelemetryMetrics {
  if (!data || typeof data !== "object") {
    return createZeroMetrics();
  }
  const obj = data as Record<string, unknown>;
  const validateUsage = (u: unknown): ProviderTokenUsage => {
    if (!u || typeof u !== "object") return createZeroUsage();
    const o = u as Record<string, unknown>;
    return {
      inputTokens: typeof o.inputTokens === "number" && o.inputTokens >= 0 ? Math.floor(o.inputTokens) : 0,
      outputTokens: typeof o.outputTokens === "number" && o.outputTokens >= 0 ? Math.floor(o.outputTokens) : 0,
      cachedInputTokens: typeof o.cachedInputTokens === "number" && o.cachedInputTokens >= 0 ? Math.floor(o.cachedInputTokens) : 0
    };
  };

  const gpt = validateUsage(obj.gpt);
  const gemini = validateUsage(obj.gemini);
  const estimatedCostUsd = typeof obj.estimatedCostUsd === "number" && obj.estimatedCostUsd >= 0
    ? obj.estimatedCostUsd
    : (calculateEstimatedCostUsd(gpt.inputTokens, gpt.outputTokens, gpt.cachedInputTokens) ?? 0);

  return { gpt, gemini, estimatedCostUsd };
}

function cloneUsageEvent(event: UsageEvent): UsageEvent {
  return {
    id: event.id,
    sourceId: event.sourceId,
    sourceEventId: event.sourceEventId,
    occurredAt: event.occurredAt,
    provider: event.provider,
    tool: event.tool,
    model: event.model,
    runId: event.runId,
    agentId: event.agentId,
    sessionId: event.sessionId,
    tokens: {
      inputTokens: event.tokens.inputTokens,
      outputTokens: event.tokens.outputTokens,
      cachedInputTokens: event.tokens.cachedInputTokens
    },
    estimatedCostUsd: event.estimatedCostUsd,
    pricingVersion: event.pricingVersion,
    attribution: event.attribution
      ? {
          repositoryId: event.attribution.repositoryId,
          worktreeId: event.attribution.worktreeId,
          branch: event.attribution.branch,
          commit: event.attribution.commit,
          provenance: event.attribution.provenance
        }
      : null
  };
}

function cloneBranchSummary(summary: BranchUsageSummary): BranchUsageSummary {
  return {
    repositoryId: summary.repositoryId,
    worktreeId: summary.worktreeId,
    branch: summary.branch,
    tokens: {
      inputTokens: summary.tokens.inputTokens,
      outputTokens: summary.tokens.outputTokens,
      cachedInputTokens: summary.tokens.cachedInputTokens
    },
    knownEstimatedCostUsd: summary.knownEstimatedCostUsd,
    unpricedEventCount: summary.unpricedEventCount
  };
}

function cloneMetrics(metrics: TelemetryMetrics): TelemetryMetrics {
  return {
    gpt: {
      inputTokens: metrics.gpt.inputTokens,
      outputTokens: metrics.gpt.outputTokens,
      cachedInputTokens: metrics.gpt.cachedInputTokens
    },
    gemini: {
      inputTokens: metrics.gemini.inputTokens,
      outputTokens: metrics.gemini.outputTokens,
      cachedInputTokens: metrics.gemini.cachedInputTokens
    },
    estimatedCostUsd: metrics.estimatedCostUsd
  };
}

function cloneProviderCapacity(cap: ProviderCapacity): ProviderCapacity {
  return {
    provider: cap.provider,
    scope: cap.scope,
    metric: cap.metric,
    limit: cap.limit,
    remaining: cap.remaining,
    resetAt: cap.resetAt,
    windowSeconds: cap.windowSeconds,
    windowKind: cap.windowKind,
    source: cap.source,
    observedAt: cap.observedAt,
    expiresAt: cap.expiresAt
  };
}

export class TelemetryService {
  private storagePath: string | null = null;
  private currentSessionMetrics: TelemetryMetrics = createZeroMetrics();
  private allTimeMetrics: TelemetryMetrics = createZeroMetrics();
  private usageEvents = new Map<string, UsageEvent>();
  private listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private snapshot: TelemetrySnapshot;

  constructor(storagePath?: string | null) {
    if (storagePath !== undefined) {
      this.storagePath = storagePath;
    } else {
      try {
        const electron = require("electron");
        const app = electron?.app || electron?.default?.app;
        if (app && typeof app.getPath === "function") {
          this.storagePath = path.join(app.getPath("userData"), "telemetry_alltime.json");
        }
      } catch {
        this.storagePath = null;
      }
    }

    this.allTimeMetrics = this.loadAllTimeMetrics();
    this.currentSessionMetrics = createZeroMetrics();

    this.snapshot = {
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
      lastUpdated: Date.now(),
      currentSession: this.currentSessionMetrics,
      allTime: this.allTimeMetrics,
      branchUsage: [],
      providerCapacity: []
    };
  }

  private loadAllTimeMetrics(): TelemetryMetrics {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) {
      return createZeroMetrics();
    }
    try {
      const raw = fs.readFileSync(this.storagePath, "utf-8");
      const parsed = JSON.parse(raw);
      return validateMetrics(parsed);
    } catch {
      return createZeroMetrics();
    }
  }

  private saveAllTimeMetrics(): void {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.storagePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.allTimeMetrics, null, 2), "utf-8");
      fs.renameSync(tmp, this.storagePath);
    } catch {
      // Defensive handling against filesystem errors
    }
  }

  getSnapshot(): TelemetrySnapshot {
    return {
      ...this.snapshot,
      currentSession: cloneMetrics(this.currentSessionMetrics),
      allTime: cloneMetrics(this.allTimeMetrics),
      branchUsage: this.snapshot.branchUsage ? this.snapshot.branchUsage.map(cloneBranchSummary) : [],
      providerCapacity: this.snapshot.providerCapacity ? this.snapshot.providerCapacity.map(cloneProviderCapacity) : []
    };
  }

  resetCurrentSession(): void {
    this.currentSessionMetrics = createZeroMetrics();
    this.snapshot = {
      ...this.snapshot,
      gptPromptTokens: 0,
      gptCompletionTokens: 0,
      gptCacheHitTokens: 0,
      gptCacheMissTokens: 0,
      gptCacheHitPercentage: null,
      geminiPromptTokens: 0,
      geminiCompletionTokens: 0,
      estimatedCostUsd: 0,
      currentSession: this.currentSessionMetrics,
      allTime: this.allTimeMetrics,
      lastUpdated: Date.now()
    };
    const broadcast = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(broadcast);
    }
  }

  updateMetrics(partial: Partial<TelemetrySnapshot>): void {
    const nextGptHit = partial.gptCacheHitTokens !== undefined ? partial.gptCacheHitTokens : this.snapshot.gptCacheHitTokens;
    const nextGptMiss = partial.gptCacheMissTokens !== undefined ? partial.gptCacheMissTokens : this.snapshot.gptCacheMissTokens;

    const hitPct = calculateCacheHitPercentage(nextGptHit, nextGptMiss);

    const gptPrompt = partial.gptPromptTokens !== undefined ? partial.gptPromptTokens : this.snapshot.gptPromptTokens;
    const gptComp = partial.gptCompletionTokens !== undefined ? partial.gptCompletionTokens : this.snapshot.gptCompletionTokens;
    const geminiPrompt = partial.geminiPromptTokens !== undefined ? partial.geminiPromptTokens : this.snapshot.geminiPromptTokens;
    const geminiComp = partial.geminiCompletionTokens !== undefined ? partial.geminiCompletionTokens : this.snapshot.geminiCompletionTokens;

    const sessionCost = calculateEstimatedCostUsd(gptPrompt, gptComp, nextGptHit);

    // Calculate deltas against previous currentSessionMetrics to increment allTimeMetrics
    const prevSessionGptInput = this.currentSessionMetrics.gpt.inputTokens;
    const prevSessionGptOutput = this.currentSessionMetrics.gpt.outputTokens;
    const prevSessionGptCached = this.currentSessionMetrics.gpt.cachedInputTokens;
    const prevSessionGeminiInput = this.currentSessionMetrics.gemini.inputTokens;
    const prevSessionGeminiOutput = this.currentSessionMetrics.gemini.outputTokens;

    const currentGptInput = Math.max(0, gptPrompt ?? 0);
    const currentGptOutput = Math.max(0, gptComp ?? 0);
    const currentGptCached = Math.min(currentGptInput, Math.max(0, nextGptHit ?? 0));
    const currentGeminiInput = Math.max(0, geminiPrompt ?? 0);
    const currentGeminiOutput = Math.max(0, geminiComp ?? 0);

    const deltaGptInput = Math.max(0, currentGptInput - prevSessionGptInput);
    const deltaGptOutput = Math.max(0, currentGptOutput - prevSessionGptOutput);
    const deltaGptCached = Math.max(0, currentGptCached - prevSessionGptCached);
    const deltaGeminiInput = Math.max(0, currentGeminiInput - prevSessionGeminiInput);
    const deltaGeminiOutput = Math.max(0, currentGeminiOutput - prevSessionGeminiOutput);

    if (deltaGptInput > 0 || deltaGptOutput > 0 || deltaGptCached > 0 || deltaGeminiInput > 0 || deltaGeminiOutput > 0) {
      const nextAllTimeGptInput = this.allTimeMetrics.gpt.inputTokens + deltaGptInput;
      const nextAllTimeGptOutput = this.allTimeMetrics.gpt.outputTokens + deltaGptOutput;
      const nextAllTimeGptCached = this.allTimeMetrics.gpt.cachedInputTokens + deltaGptCached;
      const nextAllTimeGeminiInput = this.allTimeMetrics.gemini.inputTokens + deltaGeminiInput;
      const nextAllTimeGeminiOutput = this.allTimeMetrics.gemini.outputTokens + deltaGeminiOutput;

      this.allTimeMetrics = {
        gpt: {
          inputTokens: nextAllTimeGptInput,
          outputTokens: nextAllTimeGptOutput,
          cachedInputTokens: nextAllTimeGptCached
        },
        gemini: {
          inputTokens: nextAllTimeGeminiInput,
          outputTokens: nextAllTimeGeminiOutput,
          cachedInputTokens: 0
        },
        estimatedCostUsd: calculateEstimatedCostUsd(nextAllTimeGptInput, nextAllTimeGptOutput, nextAllTimeGptCached) ?? 0
      };
      this.saveAllTimeMetrics();
    }

    this.currentSessionMetrics = {
      gpt: {
        inputTokens: currentGptInput,
        outputTokens: currentGptOutput,
        cachedInputTokens: currentGptCached
      },
      gemini: {
        inputTokens: currentGeminiInput,
        outputTokens: currentGeminiOutput,
        cachedInputTokens: 0
      },
      estimatedCostUsd: sessionCost ?? 0
    };

    this.snapshot = {
      ...this.snapshot,
      ...partial,
      gptCacheHitPercentage: hitPct,
      estimatedCostUsd: sessionCost,
      currentSession: this.currentSessionMetrics,
      allTime: this.allTimeMetrics,
      lastUpdated: Date.now()
    };

    const broadcast = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(broadcast);
    }
  }

  /**
   * Records a canonical UsageEvent into the immutable attribution ledger.
   * Guarantees idempotency: replaying an event with the same ID has no effect.
   * Returns true if newly recorded, false if ignored as duplicate.
   */
  recordUsageEvent(event: UsageEvent): boolean {
    if (!event || !event.id) {
      return false;
    }
    if (this.usageEvents.has(event.id)) {
      return false;
    }
    this.usageEvents.set(event.id, cloneUsageEvent(event));
    this.recalculateBranchUsage();
    return true;
  }

  /**
   * Aggregates usage events by repository, worktree, and branch.
   */
  private recalculateBranchUsage(): void {
    const groups = new Map<
      string,
      {
        repositoryId: string;
        worktreeId: string;
        branch: string | null;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        knownEstimatedCostUsd: number;
        unpricedEventCount: number;
      }
    >();

    for (const event of this.usageEvents.values()) {
      const repoId = event.attribution?.repositoryId ?? "default-repo";
      const worktreeId = event.attribution?.worktreeId ?? "default-worktree";
      const branch = event.attribution?.branch ?? null;
      const key = `${repoId}::${worktreeId}::${branch ?? "<detached>"}`;

      let entry = groups.get(key);
      if (!entry) {
        entry = {
          repositoryId: repoId,
          worktreeId,
          branch,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          knownEstimatedCostUsd: 0,
          unpricedEventCount: 0
        };
        groups.set(key, entry);
      }

      entry.inputTokens += Math.max(0, event.tokens.inputTokens);
      entry.outputTokens += Math.max(0, event.tokens.outputTokens);
      entry.cachedInputTokens += Math.min(
        Math.max(0, event.tokens.inputTokens),
        Math.max(0, event.tokens.cachedInputTokens)
      );

      if (typeof event.estimatedCostUsd === "number" && Number.isFinite(event.estimatedCostUsd)) {
        entry.knownEstimatedCostUsd += Math.max(0, event.estimatedCostUsd);
      } else {
        entry.unpricedEventCount += 1;
      }
    }

    const summaries: BranchUsageSummary[] = Array.from(groups.values()).map((g) => ({
      repositoryId: g.repositoryId,
      worktreeId: g.worktreeId,
      branch: g.branch,
      tokens: {
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        cachedInputTokens: g.cachedInputTokens
      },
      knownEstimatedCostUsd: Math.round(g.knownEstimatedCostUsd * 10000) / 10000,
      unpricedEventCount: g.unpricedEventCount
    }));

    this.snapshot = {
      ...this.snapshot,
      branchUsage: summaries.map(cloneBranchSummary),
      lastUpdated: Date.now()
    };

    const broadcast = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(broadcast);
    }
  }

  getBranchUsageSummaries(): readonly BranchUsageSummary[] {
    return (this.snapshot.branchUsage ?? []).map(cloneBranchSummary);
  }

  getUsageEvents(): readonly UsageEvent[] {
    return Array.from(this.usageEvents.values()).map(cloneUsageEvent);
  }

  updateProviderCapacity(capacities: readonly ProviderCapacity[]): void {
    this.snapshot = {
      ...this.snapshot,
      providerCapacity: capacities.map(cloneProviderCapacity),
      lastUpdated: Date.now()
    };
    const broadcast = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(broadcast);
    }
  }

  updateDockerStatus(status: DockerSandboxStatus): void {
    this.updateMetrics({ dockerStatus: status });
  }

  subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
