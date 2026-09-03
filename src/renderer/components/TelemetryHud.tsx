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
    <footer className="h-8 bg-slate-950 border-t border-slate-800/80 px-4 flex items-center justify-between text-xs font-mono select-none">
      {/* Left: Model Tokens & Cache Telemetry */}
      <div className="flex items-center space-x-5">
        {/* GPT Telemetry */}
        <div className="flex items-center space-x-1.5">
          <Cpu className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-slate-400">GPT:</span>
          <span className="text-slate-200 font-medium">
            {telemetry.gptPromptTokens !== null
              ? `${(telemetry.gptPromptTokens + (telemetry.gptCompletionTokens ?? 0)).toLocaleString()} tk`
              : "0 tk"}
          </span>
          <span className="text-[10px] text-purple-400/90 ml-1">
            (Cache Hit:{" "}
            {telemetry.gptCacheHitPercentage !== null
              ? `${telemetry.gptCacheHitPercentage}%`
              : "N/A"}
            )
          </span>
        </div>

        {/* Gemini Telemetry */}
        <div className="flex items-center space-x-1.5">
          <Zap className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-slate-400">Gemini:</span>
          <span className="text-slate-200 font-medium">
            {telemetry.geminiPromptTokens !== null
              ? `${(telemetry.geminiPromptTokens + (telemetry.geminiCompletionTokens ?? 0)).toLocaleString()} tk`
              : "0 tk"}
          </span>
          <span className="text-[10px] text-sky-400/90 ml-1">
            ({telemetry.geminiCacheStatus})
          </span>
        </div>
      </div>

      {/* Right: Cost & Docker Sandbox Status */}
      <div className="flex items-center space-x-5">
        {/* Cost vs Budget */}
        <div className="flex items-center space-x-1">
          <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-slate-400">Cost:</span>
          <span
            className={`font-medium ${
              isOverBudget ? "text-rose-400 font-bold" : "text-slate-200"
            }`}
          >
            {telemetry.estimatedCostUsd !== null
              ? `$${telemetry.estimatedCostUsd.toFixed(4)}`
              : "$0.0000"}
          </span>
          <span className="text-slate-500 text-[10px]">
            / ${telemetry.budgetLimitUsd.toFixed(2)}
          </span>
        </div>

        {/* Docker Sandbox Status */}
        <div className="flex items-center space-x-1.5">
          <Box className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-slate-400">Sandbox:</span>
          <span
            className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
              telemetry.dockerStatus === "Active"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                : telemetry.dockerStatus === "Stopped"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
            }`}
          >
            {telemetry.dockerStatus}
          </span>
        </div>
      </div>
    </footer>
  );
};
