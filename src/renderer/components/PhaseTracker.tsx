import React, { useState } from "react";
import type { LoopStateSnapshot } from "../../shared/contracts.js";
import { RefreshCw, RotateCcw, AlertCircle, CheckCircle2, CircleDot, Circle } from "lucide-react";

interface PhaseTrackerProps {
  readonly loopState: LoopStateSnapshot;
  readonly onRollback: () => Promise<void>;
  readonly onReset?: () => Promise<void>;
}

export const PhaseTracker: React.FC<PhaseTrackerProps> = ({ loopState, onRollback, onReset }) => {
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleRollbackClick = async () => {
    if (!confirmRollback) {
      setConfirmRollback(true);
      setTimeout(() => setConfirmRollback(false), 4000);
      return;
    }
    setIsRollingBack(true);
    setConfirmRollback(false);
    try {
      await onRollback();
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleResetClick = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    setIsResetting(true);
    setConfirmReset(false);
    try {
      if (onReset) {
        await onReset();
      } else if (window.cockpitApi?.loop?.reset) {
        await window.cockpitApi.loop.reset();
      }
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <aside className="w-80 bg-[#0c0c0c] border-r border-[#1f1f1f] flex flex-col h-full text-zinc-300 select-none font-mono">
      {/* Header */}
      <div className="p-3.5 border-b border-[#1f1f1f] flex items-center justify-between bg-[#0c0c0c]">
        <div className="flex items-center space-x-2">
          <RefreshCw className="w-4 h-4 text-zinc-400 animate-spin-slow" />
          <span className="font-bold text-sm tracking-wide uppercase text-zinc-100">
            Autonomous Loop
          </span>
        </div>
        <span
          className={`text-xs px-2.5 py-0.5 rounded font-mono uppercase font-bold border ${
            loopState.status === "running"
              ? "bg-emerald-950/30 text-emerald-400 border-emerald-800/50"
              : loopState.status === "succeeded"
              ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/60"
              : loopState.status === "failed"
              ? "bg-rose-950/40 text-rose-400 border-rose-800/60"
              : "bg-[#141414] text-zinc-400 border-[#27272a]"
          }`}
        >
          {loopState.status}
        </span>
      </div>

      {/* Sync Error Alert Banner */}
      {loopState.syncError && (
        <div className="m-3 p-2.5 rounded bg-amber-950/40 border border-amber-800/60 text-amber-300 text-xs flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span className="text-xs leading-tight font-medium">{loopState.syncError}</span>
        </div>
      )}

      {/* Phase State Machine List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 custom-scrollbar">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1">
          Pipeline Phases
        </div>
        {loopState.phases.map((item, idx) => {
          const isCurrent = item.status === "current";
          const isCompleted = item.status === "completed";

          return (
            <div
              key={item.phase}
              className={`flex items-center px-3 py-2 rounded text-xs font-mono transition-colors ${
                isCurrent
                  ? "bg-[#141414] border border-emerald-500/60 text-emerald-300 font-bold"
                  : isCompleted
                  ? "text-zinc-300 hover:bg-[#141414] font-medium"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-[#141414]"
              }`}
            >
              <div className="mr-2.5 shrink-0">
                {isCompleted ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : isCurrent ? (
                  <CircleDot className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Circle className="w-4 h-4 text-zinc-700" />
                )}
              </div>
              <span className="truncate flex-1 text-sm">{item.phase}</span>
              <span className="text-xs text-zinc-600 font-mono ml-1">#{idx + 1}</span>
            </div>
          );
        })}
      </div>

      {/* Budget & Stats Panel */}
      <div className="p-3.5 border-t border-[#1f1f1f] bg-[#0c0c0c] space-y-2.5">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Loop Budget & Stats
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="bg-[#141414] p-2.5 rounded border border-[#27272a]">
            <span className="text-xs text-zinc-500 font-medium block">TRANSITIONS</span>
            <span className="text-zinc-100 text-sm font-bold">
              {loopState.usage.transitions} / {loopState.budget.maxTransitions}
            </span>
          </div>
          <div className="bg-[#141414] p-2.5 rounded border border-[#27272a]">
            <span className="text-xs text-zinc-500 font-medium block">RETRIES LEFT</span>
            <span
              className={`text-sm font-bold ${
                loopState.budget.maxRetries - loopState.usage.retries <= 0
                  ? "text-rose-400"
                  : "text-zinc-100"
              }`}
            >
              {Math.max(0, loopState.budget.maxRetries - loopState.usage.retries)} /{" "}
              {loopState.budget.maxRetries}
            </span>
          </div>
        </div>

        {/* Actions: Rollback and New Run */}
        <div className="flex gap-2">
          <button
            onClick={handleRollbackClick}
            disabled={isRollingBack || loopState.status === "succeeded" || loopState.usage.transitions === 0}
            className={`flex-1 py-2 px-2.5 rounded text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${
              confirmRollback
                ? "bg-amber-600 hover:bg-amber-500 text-white"
                : "bg-[#141414] hover:bg-[#1f1f1f] text-zinc-300 border border-[#27272a]"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRollingBack ? "animate-spin" : ""}`} />
            <span className="truncate">{confirmRollback ? "Confirm" : "Rollback"}</span>
          </button>

          <button
            onClick={handleResetClick}
            disabled={isResetting}
            className={`flex-1 py-2 px-2.5 rounded text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${
              confirmReset
                ? "bg-rose-600 hover:bg-rose-500 text-white"
                : "bg-[#141414] hover:bg-[#1f1f1f] text-zinc-300 border border-[#27272a]"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isResetting ? "animate-spin" : ""}`} />
            <span className="truncate">{confirmReset ? "Confirm Reset" : "New Run"}</span>
          </button>
        </div>
      </div>
    </aside>
  );
};
