import React, { useState } from "react";
import type { TelemetrySnapshot, TelemetryViewScope, TelemetryMetrics, BranchUsageSummary, ProviderCapacity } from "../../shared/contracts.js";
import { calculateTotalTokens, calculateRemainingPercentage, isGeminiScope, isGeminiProScope, isCapacityActive } from "../../shared/contracts.js";
import { Cpu, Zap, DollarSign, Box, RotateCcw, Download, GitBranch, Gauge } from "lucide-react";
import { GeminiQuotaRing } from "./GeminiQuotaRing.js";

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

export type CeilingStatus = "normal" | "approaching" | "exceeded";

export function evaluateCeilingStatus(
  gptInputTokens: number,
  gptOutputTokens: number,
  estimatedCostUsd?: number | null
): CeilingStatus {
  const gptTotal = Math.max(0, gptInputTokens ?? 0) + Math.max(0, gptOutputTokens ?? 0);
  const cost =
    typeof estimatedCostUsd === "number" && Number.isFinite(estimatedCostUsd)
      ? estimatedCostUsd
      : null;

  if ((cost !== null && cost >= 0.50) || gptTotal >= 60_000) {
    return "exceeded";
  }
  if ((cost !== null && cost >= 0.40) || gptTotal >= 50_000) {
    return "approaching";
  }
  return "normal";
}

export interface DiagnosticsPayload {
  readonly exportedAt: string;
  readonly scope: TelemetryViewScope;
  readonly metrics: TelemetryMetrics;
  readonly telemetry: {
    readonly budgetLimitUsd: number;
    readonly dockerStatus: string;
    readonly geminiCacheStatus: string;
    readonly allTime?: TelemetryMetrics;
    readonly currentSession?: TelemetryMetrics;
    readonly branchUsage?: readonly BranchUsageSummary[] | undefined;
    readonly providerCapacity?: readonly ProviderCapacity[] | undefined;
  };
  readonly ceilingStatus: CeilingStatus;
}

export function createDiagnosticsSnapshot(
  telemetry: TelemetrySnapshot,
  scope: TelemetryViewScope,
  metrics: TelemetryMetrics
): DiagnosticsPayload {
  return {
    exportedAt: new Date().toISOString(),
    scope,
    metrics,
    telemetry: {
      budgetLimitUsd: telemetry.budgetLimitUsd,
      dockerStatus: telemetry.dockerStatus,
      geminiCacheStatus: telemetry.geminiCacheStatus,
      allTime: telemetry.allTime,
      currentSession: telemetry.currentSession,
      branchUsage: telemetry.branchUsage,
      providerCapacity: telemetry.providerCapacity
    },
    ceilingStatus: evaluateCeilingStatus(
      metrics.gpt.inputTokens,
      metrics.gpt.outputTokens,
      metrics.estimatedCostUsd
    )
  };
}

/**
 * Selects only active Gemini capacity, ranked:
 * 1. Exact active-model scope match.
 * 2. Gemini Pro.
 * 3. Any Gemini scope.
 * Within a rank, prefer provider-sourced capacity, then newest valid observation; retain input order for ties.
 */
export function selectBestGeminiCapacity(
  capacities: readonly ProviderCapacity[] | undefined,
  activeModel?: string | null,
  nowMs: number = Date.now()
): ProviderCapacity | null {
  if (!capacities || capacities.length === 0) {
    return null;
  }

  const geminiCapacities = capacities.filter(
    (c) => c.provider === "gemini" && isGeminiScope(c.scope) && isCapacityActive(c, nowMs)
  );

  if (geminiCapacities.length === 0) {
    return null;
  }

  const normalizedActive = activeModel?.trim().toLowerCase() ?? null;

  const getRank = (cap: ProviderCapacity): number => {
    const scopeLower = cap.scope.trim().toLowerCase();
    if (normalizedActive && scopeLower === normalizedActive) {
      return 1;
    }
    if (isGeminiProScope(cap.scope)) {
      return 2;
    }
    return 3;
  };

  const getSourceScore = (cap: ProviderCapacity): number => {
    return cap.source === "provider" ? 2 : cap.source === "local-estimate" ? 1 : 0;
  };

  const getObservedEpoch = (cap: ProviderCapacity): number => {
    return cap.observedAt ? new Date(cap.observedAt).getTime() : 0;
  };

  const sorted = [...geminiCapacities].sort((a, b) => {
    const rankDiff = getRank(a) - getRank(b);
    if (rankDiff !== 0) return rankDiff;

    const sourceDiff = getSourceScore(b) - getSourceScore(a);
    if (sourceDiff !== 0) return sourceDiff;

    const timeDiff = getObservedEpoch(b) - getObservedEpoch(a);
    if (timeDiff !== 0) return timeDiff;

    return 0;
  });

  return sorted[0] ?? null;
}

interface TelemetryHudProps {
  readonly telemetry: TelemetrySnapshot;
  readonly activeModel?: string | null | undefined;
}

const TelemetryHudComponent: React.FC<TelemetryHudProps> = ({ telemetry, activeModel }) => {
  const [scope, setScope] = useState<TelemetryViewScope>("session");
  const [isResetting, setIsResetting] = useState(false);
  const [quotaRefreshError, setQuotaRefreshError] = useState<string | null>(null);

  const metrics: TelemetryMetrics =
    scope === "allTime" && telemetry.allTime
      ? telemetry.allTime
      : telemetry.currentSession ?? {
          gpt: {
            inputTokens: telemetry.gptPromptTokens ?? 0,
            outputTokens: telemetry.gptCompletionTokens ?? 0,
            cachedInputTokens: telemetry.gptCacheHitTokens ?? 0
          },
          gemini: {
            inputTokens: telemetry.geminiPromptTokens ?? 0,
            outputTokens: telemetry.geminiCompletionTokens ?? 0,
            cachedInputTokens: 0
          },
          estimatedCostUsd: telemetry.estimatedCostUsd ?? 0
        };

  const isOverBudget =
    metrics.estimatedCostUsd !== null &&
    metrics.estimatedCostUsd >= telemetry.budgetLimitUsd;

  const gptTotalTokens = metrics.gpt.inputTokens + metrics.gpt.outputTokens;
  const ceilingStatus = evaluateCeilingStatus(
    metrics.gpt.inputTokens,
    metrics.gpt.outputTokens,
    metrics.estimatedCostUsd
  );
  const isApproachingCeiling = ceilingStatus === "approaching";
  const isCeilingExceeded = ceilingStatus === "exceeded";

  const gptTotalInput = metrics.gpt.inputTokens;
  const gptCachedInput = Math.min(gptTotalInput, metrics.gpt.cachedInputTokens);
  const cacheHitPct =
    gptTotalInput > 0
      ? Math.round((gptCachedInput / gptTotalInput) * 100)
      : null;

  const branchList = telemetry.branchUsage;
  const activeBranch: BranchUsageSummary | undefined =
    branchList && branchList.length > 0 ? branchList[branchList.length - 1] : undefined;

  const handleResetSession = async () => {
    if (isResetting) return;
    const api = window.cockpitApi;
    if (!api?.telemetry?.resetSession) return;
    setIsResetting(true);
    try {
      await api.telemetry.resetSession();
    } finally {
      setTimeout(() => setIsResetting(false), 500);
    }
  };

  const handleRefreshQuota = async () => {
    const api = window.cockpitApi;
    if (!api?.providerCapacity?.refresh) {
      return;
    }
    try {
      await api.providerCapacity.refresh();
      setQuotaRefreshError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to refresh quota";
      setQuotaRefreshError(message);
    }
  };

  const selectedGeminiCapacity = selectBestGeminiCapacity(
    telemetry.providerCapacity,
    activeModel
  );

  const otherCapacities =
    telemetry.providerCapacity?.filter(
      (c) => c !== selectedGeminiCapacity
    ) ?? [];

  const handleExportDiagnostics = () => {
    try {
      const data = createDiagnosticsSnapshot(telemetry, scope, metrics);
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `kins-diagnostics-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export diagnostics JSON:", err);
    }
  };

  return (
    <footer className="h-10 bg-zinc-900/95 backdrop-blur-md border-t border-zinc-800 px-4 flex items-center justify-between text-xs font-sans select-none text-zinc-300">
      {/* Left: Scope Toggle, Reset & Provider In/Out Breakdown */}
      <div className="flex items-center space-x-5">
        {/* Scope Selector: Session vs All-Time */}
        <div className="flex items-center bg-zinc-800/80 border border-zinc-700/60 rounded-md p-0.5 text-[11px]" role="tablist" aria-label="Telemetry time scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "session"}
            onClick={() => setScope("session")}
            className={`px-2.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
              scope === "session"
                ? "bg-zinc-700 text-zinc-100 font-semibold shadow-xs"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Show metrics accumulated for current session"
          >
            Session
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "allTime"}
            onClick={() => setScope("allTime")}
            className={`px-2.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
              scope === "allTime"
                ? "bg-zinc-700 text-zinc-100 font-semibold shadow-xs"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Show cumulative all-time metrics"
          >
            All-Time
          </button>
        </div>

        {/* Action Buttons: Reset & Export */}
        <div className="flex items-center space-x-2">
          <button
            type="button"
            onClick={handleResetSession}
            disabled={isResetting}
            aria-label="Reset session telemetry"
            className="flex items-center space-x-1 text-[11px] font-sans text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700/70 px-2 py-0.5 rounded-md transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer min-h-[26px]"
            title="Reset current session tokens to 0 (retains All-Time totals)"
          >
            <RotateCcw className={`w-3 h-3 ${isResetting ? "animate-spin motion-reduce:animate-none" : ""}`} />
            <span>Reset</span>
          </button>

          <button
            type="button"
            onClick={handleExportDiagnostics}
            aria-label="Export diagnostic JSON snapshot"
            className="flex items-center space-x-1 text-[11px] font-sans text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700/70 px-2 py-0.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer min-h-[26px]"
            title="Export diagnostics JSON snapshot"
          >
            <Download className="w-3 h-3" />
            <span>Export</span>
          </button>
        </div>

        {/* GPT Telemetry */}
        <div className="flex items-center space-x-2">
          <Cpu className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-zinc-400 font-medium font-sans">GPT:</span>
          <span className="text-zinc-100 font-semibold font-mono tabular-nums">
            {formatTokens(metrics.gpt.inputTokens)} in / {formatTokens(metrics.gpt.outputTokens)} out
          </span>
          <span className="text-[11px] text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 font-mono">
            Cache: {cacheHitPct !== null ? `${cacheHitPct}%` : "N/A"}
          </span>
        </div>

        {/* Gemini Telemetry */}
        <div className="flex items-center space-x-2">
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-zinc-400 font-medium font-sans">Gemini:</span>
          <span className="text-zinc-100 font-semibold font-mono tabular-nums">
            {formatTokens(metrics.gemini.inputTokens)} in / {formatTokens(metrics.gemini.outputTokens)} out
          </span>
          <span className="text-[11px] text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 font-mono">
            {telemetry.geminiCacheStatus === "Active" ? "Pro" : telemetry.geminiCacheStatus}
          </span>
          <GeminiQuotaRing capacity={selectedGeminiCapacity} onRefresh={handleRefreshQuota} />
          {quotaRefreshError && (
            <span
              role="alert"
              className="text-[10px] text-rose-400 bg-rose-950/60 border border-rose-800/80 px-1.5 py-0.5 rounded font-mono"
              title={quotaRefreshError}
            >
              Refresh failed
            </span>
          )}
        </div>
      </div>

      {/* Right: Cost & Docker Sandbox Status */}
      <div className="flex items-center space-x-5">
        {/* Branch Attribution Badge */}
        {activeBranch && (
          <div
            className="flex items-center space-x-1.5 px-2 py-0.5 rounded-md bg-zinc-800/90 border border-zinc-700/80 text-[11px] font-mono"
            title={`Branch Attribution: ${activeBranch.branch || "detached"} (${formatTokens(calculateTotalTokens(activeBranch.tokens))} tokens, $${activeBranch.knownEstimatedCostUsd.toFixed(4)})`}
          >
            <GitBranch className="w-3 h-3 text-cyan-400" />
            <span className="text-zinc-300 max-w-[110px] truncate font-sans">
              {activeBranch.branch || "detached"}
            </span>
            <span className="text-cyan-400 font-semibold tabular-nums">
              ${activeBranch.knownEstimatedCostUsd.toFixed(3)}
            </span>
          </div>
        )}

        {/* Other Provider Capacity Badges (e.g. non-Gemini Pro) */}
        {otherCapacities.length > 0 && (
          <div className="flex items-center space-x-2">
            {otherCapacities.map((cap) => {
              const pct = calculateRemainingPercentage(cap);
              const isUnavailable = cap.source === "unavailable" || pct === null;
              return (
                <div
                  key={`${cap.provider}::${cap.scope}::${cap.metric}`}
                  className="flex items-center space-x-1.5 px-2 py-0.5 rounded-md bg-zinc-800/90 border border-zinc-700/80 text-[11px] font-mono"
                  title={`Provider Quota ${cap.provider.toUpperCase()} [${cap.scope}]: ${
                    isUnavailable
                      ? "Unavailable / Expired"
                      : `${pct}% remaining (${cap.remaining ?? 0}/${cap.limit ?? 0} ${cap.metric})`
                  }${cap.resetAt ? ` - Reset: ${cap.resetAt}` : ""}`}
                >
                  <Gauge className="w-3 h-3 text-indigo-400" />
                  <span className="text-zinc-400 uppercase font-sans font-semibold text-[10px]">
                    {cap.provider}
                  </span>
                  <span
                    className={`font-semibold tabular-nums ${
                      isUnavailable
                        ? "text-zinc-500"
                        : pct < 20
                        ? "text-rose-400 font-bold"
                        : pct < 50
                        ? "text-amber-400"
                        : "text-indigo-300"
                    }`}
                  >
                    {isUnavailable ? "N/A" : `${pct}%`}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Cost vs Budget */}
        <div className="flex items-center space-x-1.5">
          <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-zinc-400 font-medium font-sans">Cost:</span>
          <span
            className={`font-semibold text-xs font-mono tabular-nums ${
              isOverBudget ? "text-rose-400 font-bold" : "text-emerald-400"
            }`}
          >
            ${metrics.estimatedCostUsd.toFixed(4)}
          </span>
          <span className="text-zinc-400 text-[11px] font-mono tabular-nums">
            / ${telemetry.budgetLimitUsd.toFixed(2)}
          </span>
        </div>

        {/* Telemetry Budget Ceiling Warning */}
        <div
          className={`flex items-center space-x-1.5 px-2 py-0.5 rounded-md border text-[11px] font-mono ${
            isCeilingExceeded
              ? "bg-rose-950/50 text-rose-300 border-rose-800/80 font-bold animate-pulse motion-reduce:animate-none"
              : isApproachingCeiling
              ? "bg-amber-950/40 text-amber-300 border-amber-800/60 font-semibold"
              : "bg-zinc-800 text-zinc-300 border-zinc-700"
          }`}
          title={`Canonical hard execution limits: $0.50 USD and 60k tokens (Layer 1 GPT only: ${formatTokens(gptTotalTokens)} / 60k)`}
        >
          <span className="text-zinc-400 font-medium font-sans">Ceiling:</span>
          <span className="text-zinc-200 font-semibold">$0.50</span>
          <span className="text-zinc-500">/</span>
          <span className="text-zinc-200 font-semibold">60k tokens</span>
        </div>

        {/* Docker Sandbox Status */}
        <div className="flex items-center space-x-1.5 font-sans">
          <Box className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-zinc-400 font-medium">Sandbox:</span>
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded font-mono font-medium uppercase border ${
              telemetry.dockerStatus === "Active"
                ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/60"
                : telemetry.dockerStatus === "Stopped"
                ? "bg-amber-950/40 text-amber-400 border-amber-800/60"
                : "bg-zinc-800 text-zinc-300 border-zinc-700"
            }`}
          >
            {telemetry.dockerStatus}
          </span>
        </div>
      </div>
    </footer>
  );
};

export const TelemetryHud = React.memo(TelemetryHudComponent);
