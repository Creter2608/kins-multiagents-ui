import React from "react";
import type { TelemetrySnapshot } from "../../shared/contracts.js";
import { Cpu, Zap, DollarSign, Box } from "lucide-react";

interface TelemetryHudProps {
  readonly telemetry: TelemetrySnapshot;
}

export const TelemetryHud: React.FC<TelemetryHudProps> = ({ telemetry }) => {
  const isOverBudget =
    telemetry.estimatedCostUsd !== null &&
    telemetry.estimatedCostUsd >= telemetry.budgetLimitUsd;

  return (
    <footer className="h-10 bg-slate-900 border-t border-slate-700 px-5 flex items-center justify-between text-xs font-mono select-none">
      {/* Left: Model Tokens & Cache Telemetry */}
      <div className="flex items-center space-x-6">
        {/* GPT Telemetry */}
        <div className="flex items-center space-x-2">
          <Cpu className="w-4 h-4 text-purple-400" />
          <span className="text-slate-300 font-medium">GPT:</span>
          <span className="text-white font-bold">
            {telemetry.gptPromptTokens !== null
              ? `${(telemetry.gptPromptTokens + (telemetry.gptCompletionTokens ?? 0)).toLocaleString()} tk`
              : "0 tk"}
          </span>
          <span className="text-xs text-purple-300 font-semibold bg-purple-950/60 px-1.5 py-0.5 rounded border border-purple-800/60">
            Cache:{" "}
            {telemetry.gptCacheHitPercentage !== null
              ? `${telemetry.gptCacheHitPercentage}%`
              : "N/A"}
          </span>
        </div>

        {/* Gemini Telemetry */}
        <div className="flex items-center space-x-2">
          <Zap className="w-4 h-4 text-sky-400" />
          <span className="text-slate-300 font-medium">Gemini:</span>
          <span className="text-white font-bold">
            {telemetry.geminiPromptTokens !== null
              ? `${(telemetry.geminiPromptTokens + (telemetry.geminiCompletionTokens ?? 0)).toLocaleString()} tk`
              : "0 tk"}
          </span>
          <span className="text-xs text-sky-300 font-semibold bg-sky-950/60 px-1.5 py-0.5 rounded border border-sky-800/60">
            {telemetry.geminiCacheStatus}
          </span>
        </div>
      </div>

      {/* Right: Cost & Docker Sandbox Status */}
      <div className="flex items-center space-x-6">
        {/* Cost vs Budget */}
        <div className="flex items-center space-x-1.5">
          <DollarSign className="w-4 h-4 text-emerald-400" />
          <span className="text-slate-300 font-medium">Cost:</span>
          <span
            className={`font-bold text-sm ${
              isOverBudget ? "text-rose-400 font-bold" : "text-emerald-400"
            }`}
          >
            {telemetry.estimatedCostUsd !== null
              ? `$${telemetry.estimatedCostUsd.toFixed(4)}`
              : "$0.0000"}
          </span>
          <span className="text-slate-400 text-xs">
            / ${telemetry.budgetLimitUsd.toFixed(2)}
          </span>
        </div>

        {/* Docker Sandbox Status */}
        <div className="flex items-center space-x-2">
          <Box className="w-4 h-4 text-slate-300" />
          <span className="text-slate-300 font-medium">Sandbox:</span>
          <span
            className={`text-xs px-2 py-0.5 rounded font-bold uppercase ${
              telemetry.dockerStatus === "Active"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50"
                : telemetry.dockerStatus === "Stopped"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/50"
                : "bg-rose-500/20 text-rose-300 border border-rose-500/50"
            }`}
          >
            {telemetry.dockerStatus}
          </span>
        </div>
      </div>
    </footer>
  );
};
