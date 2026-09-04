import React, { useState, useEffect, useRef } from "react";
import type { LoopStateSnapshot } from "../../shared/contracts.js";
import { computePhaseStatuses, LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import {
  RefreshCw,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Circle,
  ChevronRight,
  RotateCw,
  Info,
  X
} from "lucide-react";

interface PhaseTrackerProps {
  readonly loopState: LoopStateSnapshot;
  readonly onRollback: () => Promise<void>;
  readonly onStepForward?: () => Promise<void>;
  readonly onReset?: () => Promise<void>;
}

export const PhaseTracker: React.FC<PhaseTrackerProps> = ({
  loopState,
  onRollback,
  onStepForward,
  onReset
}) => {
  const [displayPhase, setDisplayPhase] = useState<string>(loopState.currentPhase);
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
  const [isOperating, setIsOperating] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Staggered Visual Catch-up: Smoothly step through intermediate phases (180ms delay)
  useEffect(() => {
    const targetIdx = LOOP_PHASES.indexOf(loopState.currentPhase as LoopPhase);
    const currIdx = LOOP_PHASES.indexOf(displayPhase as LoopPhase);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Direct snap if target moves backward, resets, or matches
    if (targetIdx === -1 || currIdx === -1 || targetIdx <= currIdx) {
      setDisplayPhase(loopState.currentPhase);
      return;
    }

    // Advance step-by-step toward target phase
    const stepNext = (nextIdx: number) => {
      const nextPhase = LOOP_PHASES[nextIdx];
      if (!nextPhase) return;
      setDisplayPhase(nextPhase);

      if (nextIdx < targetIdx) {
        timerRef.current = setTimeout(() => {
          stepNext(nextIdx + 1);
        }, 180);
      }
    };

    timerRef.current = setTimeout(() => {
      stepNext(currIdx + 1);
    }, 180);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [loopState.currentPhase]);

  const phases = computePhaseStatuses(displayPhase);

  const handleStepForwardClick = async () => {
    if (!onStepForward || isOperating) return;
    setIsOperating(true);
    try {
      await onStepForward();
    } finally {
      setIsOperating(false);
    }
  };

  const handleRollbackClick = async () => {
    if (isOperating) return;
    if (!confirmRollback) {
      setConfirmRollback(true);
      setTimeout(() => setConfirmRollback(false), 4000);
      return;
    }
    setIsOperating(true);
    setConfirmRollback(false);
    try {
      await onRollback();
    } finally {
      setIsOperating(false);
    }
  };

  const handleResetClick = async () => {
    if (!onReset || isOperating) return;
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    setIsOperating(true);
    setConfirmReset(false);
    try {
      await onReset();
    } finally {
      setIsOperating(false);
    }
  };

  // Selected phase evidence
  const selectedHistory = selectedPhase
    ? loopState.history?.filter((h) => h.to === selectedPhase).pop()
    : null;

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
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1 flex items-center justify-between">
          <span>Pipeline Phases</span>
          <span className="text-[10px] text-zinc-600 font-normal">Click to inspect</span>
        </div>
        {phases.map((item, idx) => {
          const isCurrent = item.status === "current";
          const isCompleted = item.status === "completed";
          const isSelected = selectedPhase === item.phase;

          // Check if auto-advanced
          const isAuto = loopState.history?.some((h) => h.to === item.phase && h.autoAdvanced);

          return (
            <button
              type="button"
              key={item.phase}
              onClick={() => setSelectedPhase(isSelected ? null : item.phase)}
              className={`w-full text-left flex items-center px-3 py-2 rounded text-xs font-mono transition-colors ${
                isSelected
                  ? "bg-[#1f1f23] border border-cyan-500/70 text-cyan-200"
                  : isCurrent
                  ? "bg-[#141414] border border-emerald-500/60 text-emerald-300 font-bold"
                  : isCompleted
                  ? "text-zinc-300 hover:bg-[#141414] font-medium border border-transparent"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-[#141414] border border-transparent"
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
              {isAuto && (
                <span className="text-[9px] px-1 py-0.5 rounded bg-amber-950/60 text-amber-400 border border-amber-800/40 mr-1.5 uppercase">
                  Auto
                </span>
              )}
              <span className="text-xs text-zinc-600 font-mono">#{idx + 1}</span>
            </button>
          );
        })}
      </div>

      {/* Verification / Test Summary Card */}
      <div className="px-3 py-2.5 border-t border-[#1f1f1f] bg-[#0c0c0c] space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Test Results
          </div>
          <span
            className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold border ${
              loopState.testSummary?.status === "pass"
                ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/60"
                : loopState.testSummary?.status === "fail"
                ? "bg-rose-950/40 text-rose-400 border-rose-800/60"
                : "bg-[#141414] text-zinc-500 border-[#27272a]"
            }`}
          >
            {loopState.testSummary?.status ? loopState.testSummary.status.toUpperCase() : "IDLE"}
          </span>
        </div>
        <div className="bg-[#141414] p-2 rounded border border-[#27272a] flex items-center justify-between text-xs font-mono">
          <span className="text-emerald-400 font-medium">
            {loopState.testSummary?.passCount ?? 0} Passed
          </span>
          <span className="text-zinc-600">•</span>
          <span
            className={
              (loopState.testSummary?.failCount ?? 0) > 0
                ? "text-rose-400 font-bold"
                : "text-zinc-400 font-medium"
            }
          >
            {loopState.testSummary?.failCount ?? 0} Failed
          </span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-500 text-[10px]">
            {loopState.testSummary?.lastRunAt
              ? new Date(loopState.testSummary.lastRunAt).toLocaleTimeString()
              : "Never"}
          </span>
        </div>
      </div>

      {/* Phase Evidence Inspector Drawer */}
      {selectedPhase && (
        <div className="p-3 border-t border-[#1f1f1f] bg-[#111114] space-y-1.5 animate-fadeIn">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-1.5 text-cyan-400 text-xs font-bold">
              <Info className="w-3.5 h-3.5" />
              <span>Evidence: {selectedPhase}</span>
            </div>
            <button
              onClick={() => setSelectedPhase(null)}
              className="text-zinc-500 hover:text-zinc-200 p-0.5 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-[11px] text-zinc-400 space-y-1 bg-[#0a0a0c] p-2 rounded border border-[#27272a]">
            <div>
              <span className="text-zinc-500">Trigger: </span>
              <span className="text-zinc-200 font-medium">
                {selectedHistory?.triggeredBy ||
                  (selectedPhase === "INITIALIZE"
                    ? "Initial workspace startup"
                    : "Pending activation")}
              </span>
            </div>
            {selectedHistory?.timestamp && (
              <div>
                <span className="text-zinc-500">Recorded: </span>
                <span className="text-zinc-300">
                  {new Date(selectedHistory.timestamp).toLocaleTimeString()}
                </span>
              </div>
            )}
            <div>
              <span className="text-zinc-500">Mode: </span>
              <span
                className={
                  selectedHistory?.autoAdvanced ? "text-amber-400" : "text-emerald-400"
                }
              >
                {selectedHistory?.autoAdvanced ? "Auto-advanced (catch-up)" : "Direct Transition"}
              </span>
            </div>
          </div>
        </div>
      )}

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

        {/* Action Controls: Step Forward, Rollback, Reset */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {/* Step Forward Button */}
            <button
              type="button"
              onClick={handleStepForwardClick}
              disabled={
                isOperating ||
                loopState.status === "succeeded" ||
                loopState.status === "failed" ||
                loopState.currentPhase === "COMPLETE"
              }
              className="py-1.5 px-2 rounded text-xs font-semibold flex items-center justify-center space-x-1 transition-all bg-[#141414] hover:bg-[#1f1f1f] text-emerald-400 border border-[#27272a] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Step Forward</span>
            </button>

            {/* Reset Loop Button */}
            <button
              type="button"
              onClick={handleResetClick}
              disabled={isOperating}
              className={`py-1.5 px-2 rounded text-xs font-semibold flex items-center justify-center space-x-1 transition-all ${
                confirmReset
                  ? "bg-rose-700 hover:bg-rose-600 text-white"
                  : "bg-[#141414] hover:bg-[#1f1f1f] text-zinc-400 border border-[#27272a]"
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <RotateCw className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{confirmReset ? "Confirm Reset" : "Reset"}</span>
            </button>
          </div>

          {/* Rollback to Prior Phase Button */}
          <button
            type="button"
            onClick={handleRollbackClick}
            disabled={
              isOperating ||
              loopState.status === "succeeded" ||
              (loopState.currentPhase === "INITIALIZE" &&
                loopState.usage.transitions === 0 &&
                loopState.status !== "failed" &&
                loopState.status !== "blocked")
            }
            className={`w-full py-2 px-2.5 rounded text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${
              confirmRollback
                ? "bg-amber-600 hover:bg-amber-500 text-white"
                : "bg-[#141414] hover:bg-[#1f1f1f] text-zinc-300 border border-[#27272a]"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isOperating ? "animate-spin" : ""}`} />
            <span className="truncate">
              {confirmRollback ? "Confirm Rollback" : "Rollback to Prior Phase"}
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
};
