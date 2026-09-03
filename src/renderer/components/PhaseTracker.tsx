import React, { useState } from "react";
import type { LoopStateSnapshot } from "../../shared/contracts.js";
import { RefreshCw, RotateCcw, AlertCircle, CheckCircle2, CircleDot, Circle } from "lucide-react";

interface PhaseTrackerProps {
  readonly loopState: LoopStateSnapshot;
  readonly onRollback: () => Promise<void>;
}

export const PhaseTracker: React.FC<PhaseTrackerProps> = ({ loopState, onRollback }) => {
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

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

  return (
    <aside className="w-72 bg-slate-950/80 border-r border-slate-800/80 flex flex-col h-full text-slate-300 select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-800/60 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin-slow" />
          <span className="font-semibold text-xs tracking-wider uppercase text-slate-200">
            Autonomous Loop
          </span>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full font-mono uppercase font-medium ${
            loopState.status === "running"
              ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
              : loopState.status === "succeeded"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              : loopState.status === "failed"
              ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
              : "bg-slate-800 text-slate-400"
          }`}
        >
          {loopState.status}
        </span>
      </div>

      {/* Sync Error Alert Banner */}
      {loopState.syncError && (
        <div className="m-2.5 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-tight">{loopState.syncError}</span>
        </div>
      )}

      {/* Phase State Machine List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 custom-scrollbar">
        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider mb-2 px-1">
          Pipeline Phases
        </div>
        {loopState.phases.map((item, idx) => {
          const isCurrent = item.status === "current";
          const isCompleted = item.status === "completed";

          return (
            <div
              key={item.phase}
              className={`flex items-center px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors ${
                isCurrent
                  ? "bg-cyan-950/60 border border-cyan-500/50 text-cyan-200 shadow-sm shadow-cyan-900/40"
                  : isCompleted
                  ? "text-emerald-400/90 hover:bg-slate-900/50"
                  : "text-slate-500 hover:text-slate-400"
              }`}
            >
              <div className="mr-2.5 shrink-0">
                {isCompleted ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                ) : isCurrent ? (
                  <CircleDot className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-slate-600" />
                )}
              </div>
              <span className="truncate flex-1">{item.phase}</span>
              <span className="text-[10px] text-slate-500 font-mono ml-1">#{idx + 1}</span>
            </div>
          );
        })}
      </div>

      {/* Budget & Stats Panel */}
      <div className="p-3 border-t border-slate-800/60 bg-slate-900/40 space-y-2">
        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
          Loop Budget & Stats
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="bg-slate-950/60 p-2 rounded border border-slate-800/40">
            <span className="text-[10px] text-slate-500 block">TRANSITIONS</span>
            <span className="text-slate-200 font-medium">
              {loopState.usage.transitions} / {loopState.budget.maxTransitions}
            </span>
          </div>
          <div className="bg-slate-950/60 p-2 rounded border border-slate-800/40">
            <span className="text-[10px] text-slate-500 block">RETRIES REMAINING</span>
            <span
              className={`font-medium ${
                loopState.budget.maxRetries - loopState.usage.retries <= 0
                  ? "text-rose-400"
                  : "text-slate-200"
              }`}
            >
              {Math.max(0, loopState.budget.maxRetries - loopState.usage.retries)} /{" "}
              {loopState.budget.maxRetries}
            </span>
          </div>
        </div>

        {/* Rollback Action */}
        <button
          onClick={handleRollbackClick}
          disabled={isRollingBack || loopState.status === "succeeded"}
          className={`w-full py-1.5 px-3 rounded text-xs font-medium flex items-center justify-center space-x-1.5 transition-all ${
            confirmRollback
              ? "bg-amber-600 hover:bg-amber-500 text-white animate-pulse"
              : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <RotateCcw className={`w-3.5 h-3.5 ${isRollingBack ? "animate-spin" : ""}`} />
          <span>{confirmRollback ? "Click again to confirm rollback" : "Rollback to Prior Phase"}</span>
        </button>
      </div>
    </aside>
  );
};
