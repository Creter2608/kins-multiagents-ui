import React, { useState } from "react";
import type { TelemetrySnapshot, TelemetryViewScope, TelemetryMetrics } from "../../shared/contracts.js";
import { Cpu, Zap, DollarSign, Box, RotateCcw } from "lucide-react";

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

interface TelemetryHudProps {
  readonly telemetry: TelemetrySnapshot;
}

export const TelemetryHud: React.FC<TelemetryHudProps> = ({ telemetry }) => {
  const [scope, setScope] = useState<TelemetryViewScope>("session");
  const [isResetting, setIsResetting] = useState(false);

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

  const gptTotalInput = metrics.gpt.inputTokens;
  const gptCachedInput = Math.min(gptTotalInput, metrics.gpt.cachedInputTokens);
  const cacheHitPct =
    gptTotalInput > 0
      ? Math.round((gptCachedInput / gptTotalInput) * 100)
      : null;

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

  return (
    <footer className="h-10 bg-[#0c0c0c] border-t border-[#1f1f1f] px-4 flex items-center justify-between text-xs font-mono select-none text-zinc-300">
      {/* Left: Scope Toggle, Reset & Provider In/Out Breakdown */}
      <div className="flex items-center space-x-5">
        {/* Scope Selector: Session vs All-Time */}
        <div className="flex items-center bg-[#141414] border border-[#27272a] rounded p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setScope("session")}
            className={`px-2 py-0.5 rounded transition-colors ${
              scope === "session"
                ? "bg-[#27272a] text-zinc-100 font-semibold shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Show metrics accumulated for current session"
          >
            Session
          </button>
          <button
            type="button"
            onClick={() => setScope("allTime")}
            className={`px-2 py-0.5 rounded transition-colors ${
              scope === "allTime"
                ? "bg-[#27272a] text-zinc-100 font-semibold shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Show cumulative all-time metrics"
          >
            All-Time
          </button>
        </div>

        {/* Manual Reset Button */}
        <button
          type="button"
          onClick={handleResetSession}
          disabled={isResetting}
          className="flex items-center space-x-1 text-[11px] text-zinc-400 hover:text-zinc-200 bg-[#141414] hover:bg-[#1f1f1f] border border-[#27272a] px-2 py-0.5 rounded transition-colors disabled:opacity-50"
          title="Reset current session tokens to 0 (retains All-Time totals)"
        >
          <RotateCcw className={`w-3 h-3 ${isResetting ? "animate-spin" : ""}`} />
          <span>Reset</span>
        </button>

        {/* GPT Telemetry */}
        <div className="flex items-center space-x-2">
          <Cpu className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-zinc-400 font-medium">GPT:</span>
          <span className="text-zinc-100 font-semibold">
            {formatTokens(metrics.gpt.inputTokens)} in / {formatTokens(metrics.gpt.outputTokens)} out
          </span>
          <span className="text-[11px] text-zinc-400 bg-[#141414] px-1.5 py-0.5 rounded border border-[#27272a]">
            Cache: {cacheHitPct !== null ? `${cacheHitPct}%` : "N/A"}
          </span>
        </div>

        {/* Gemini Telemetry */}
        <div className="flex items-center space-x-2">
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-zinc-400 font-medium">Gemini:</span>
          <span className="text-zinc-100 font-semibold">
            {formatTokens(metrics.gemini.inputTokens)} in / {formatTokens(metrics.gemini.outputTokens)} out
          </span>
          <span className="text-[11px] text-emerald-400/90 bg-[#141414] px-1.5 py-0.5 rounded border border-[#27272a]">
            {telemetry.geminiCacheStatus === "Active" ? "Pro" : telemetry.geminiCacheStatus}
          </span>
        </div>
      </div>

      {/* Right: Cost & Docker Sandbox Status */}
      <div className="flex items-center space-x-5">
        {/* Cost vs Budget */}
        <div className="flex items-center space-x-1.5">
          <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-zinc-400 font-medium">Cost:</span>
          <span
            className={`font-semibold text-xs ${
              isOverBudget ? "text-rose-400 font-bold" : "text-emerald-400"
            }`}
          >
            ${metrics.estimatedCostUsd.toFixed(4)}
          </span>
          <span className="text-zinc-500 text-[11px]">
            / ${telemetry.budgetLimitUsd.toFixed(2)}
          </span>
        </div>

        {/* Docker Sandbox Status */}
        <div className="flex items-center space-x-1.5">
          <Box className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-zinc-400 font-medium">Sandbox:</span>
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded font-mono font-medium uppercase border ${
              telemetry.dockerStatus === "Active"
                ? "bg-emerald-950/20 text-emerald-400 border-emerald-800/40"
                : telemetry.dockerStatus === "Stopped"
                ? "bg-amber-950/20 text-amber-400 border-amber-800/40"
                : "bg-zinc-900 text-zinc-400 border-zinc-800"
            }`}
          >
            {telemetry.dockerStatus}
          </span>
        </div>
      </div>
    </footer>
  );
};
