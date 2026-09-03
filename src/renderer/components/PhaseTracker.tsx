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
    <aside className="w-80 bg-slate-900 border-r border-slate-700 flex flex-col h-full text-slate-200 select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-700 flex items-center justify-between bg-slate-950/40">
        <div className="flex items-center space-x-2">
          <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin-slow" />
          <span className="font-bold text-sm tracking-wide uppercase text-white">
            Autonomous Loop
          </span>
        </div>
        <span
          className={`text-xs px-2.5 py-0.5 rounded-full font-mono uppercase font-bold border ${
            loopState.status === "running"
              ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
              : loopState.status === "succeeded"
              ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
              : loopState.status === "failed"
              ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
              : "bg-slate-800 text-slate-300 border-slate-700"
          }`}
        >
          {loopState.status}
        </span>
      </div>

      {/* Sync Error Alert Banner */}
      {loopState.syncError && (
        <div className="m-3 p-2.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span className="text-xs leading-tight font-medium">{loopState.syncError}</span>
        </div>
      )}

      {/* Phase State Machine List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 custom-scrollbar">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 px-1">
          Pipeline Phases
        </div>
        {loopState.phases.map((item, idx) => {
          const isCurrent = item.status === "current";
          const isCompleted = item.status === "completed";

          return (
            <div
              key={item.phase}
              className={`flex items-center px-3 py-2 rounded-md text-xs font-mono transition-colors ${
                isCurrent
                  ? "bg-cyan-950/80 border border-cyan-400 text-cyan-100 font-bold shadow-md shadow-cyan-950"
                  : isCompleted
                  ? "text-emerald-300 hover:bg-slate-800/60 font-medium"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <div className="mr-2.5 shrink-0">
                {isCompleted ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : isCurrent ? (
                  <CircleDot className="w-4 h-4 text-cyan-400 animate-pulse" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-600" />
                )}
              </div>
              <span className="truncate flex-1 text-sm">{item.phase}</span>
              <span className="text-xs text-slate-500 font-mono ml-1">#{idx + 1}</span>
            </div>
          );
        })}
      </div>

      {/* Budget & Stats Panel */}
      <div className="p-3.5 border-t border-slate-700 bg-slate-950/60 space-y-2.5">
        <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Loop Budget & Stats
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="bg-slate-900 p-2.5 rounded border border-slate-700/80">
            <span className="text-xs text-slate-400 font-medium block">TRANSITIONS</span>
            <span className="text-white text-sm font-bold">
              {loopState.usage.transitions} / {loopState.budget.maxTransitions}
            </span>
          </div>
          <div className="bg-slate-900 p-2.5 rounded border border-slate-700/80">
            <span className="text-xs text-slate-400 font-medium block">RETRIES LEFT</span>
            <span
              className={`text-sm font-bold ${
                loopState.budget.maxRetries - loopState.usage.retries <= 0
                  ? "text-rose-400"
                  : "text-white"
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
          className={`w-full py-2 px-3 rounded text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${
            confirmRollback
              ? "bg-amber-600 hover:bg-amber-500 text-white animate-pulse"
              : "bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-600"
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          <RotateCcw className={`w-4 h-4 ${isRollingBack ? "animate-spin" : ""}`} />
          <span>{confirmRollback ? "Click again to confirm rollback" : "Rollback to Prior Phase"}</span>
        </button>
      </div>
    </aside>
  );
};
