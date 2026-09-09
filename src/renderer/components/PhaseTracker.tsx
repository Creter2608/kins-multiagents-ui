import React, { useState, useEffect, useRef } from "react";
import type { LoopStateSnapshot, TelemetrySnapshot } from "../../shared/contracts.js";
import { computePhaseStatuses, LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import {
  RefreshCw,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Circle,
  ChevronRight,
  ChevronDown,
  RotateCw,
  Info,
  X
} from "lucide-react";

interface PhaseTrackerProps {
  readonly loopState: LoopStateSnapshot;
  readonly telemetry?: TelemetrySnapshot | undefined;
  readonly onRollback: () => Promise<void>;
  readonly onStepForward?: () => Promise<void>;
  readonly onReset?: () => Promise<void>;
}

const PhaseTrackerComponent: React.FC<PhaseTrackerProps> = ({
  loopState,
  telemetry,
  onRollback,
  onStepForward,
  onReset
}) => {
  const [displayPhase, setDisplayPhase] = useState<string>(loopState.currentPhase);
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
  const [isOperating, setIsOperating] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showGateModal, setShowGateModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [gateDecisionError, setGateDecisionError] = useState<string | null>(null);
  const [scoreExpanded, setScoreExpanded] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const isGate = loopState.currentPhase === "SPEC_GATE" || loopState.currentPhase === "RELEASE_GATE";

  const handleGateAction = async (decision: "approve" | "reject") => {
    if (decision === "reject" && !rejectionReason.trim()) {
      setGateDecisionError("Rejection requires an explicit explanation");
      return;
    }
    setGateDecisionError(null);
    setIsOperating(true);
    try {
      if (window.cockpitApi?.loop?.decideGate) {
        const res = await window.cockpitApi.loop.decideGate({
          runId: loopState.runId,
          expectedPhase: loopState.currentPhase as "SPEC_GATE" | "RELEASE_GATE",
          decision,
          reason: decision === "reject" ? rejectionReason.trim() : undefined
        });
        if (!res.success) {
          setGateDecisionError(res.message);
        } else {
          setShowGateModal(false);
          setRejectionReason("");
        }
      }
    } catch (err) {
      setGateDecisionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsOperating(false);
    }
  };

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

  // Effective Tokens: Prefer loopState.resourceUsage, fallback to live telemetry
  const stateTokens = loopState.resourceUsage?.totalTokens ?? 0;
  const sessionGptTokens =
    (telemetry?.currentSession?.gpt?.inputTokens ?? 0) +
    (telemetry?.currentSession?.gpt?.outputTokens ?? 0);
  const directGptTokens =
    (telemetry?.gptPromptTokens ?? 0) + (telemetry?.gptCompletionTokens ?? 0);
  const gptTokens = Math.max(sessionGptTokens, directGptTokens);
  const geminiTokens =
    (telemetry?.currentSession?.gemini?.inputTokens ?? 0) +
    (telemetry?.currentSession?.gemini?.outputTokens ?? 0);
  const directGeminiTokens =
    (telemetry?.geminiPromptTokens ?? 0) + (telemetry?.geminiCompletionTokens ?? 0);
  const effectiveGemini = Math.max(geminiTokens, directGeminiTokens);
  const telemetryTotalTokens = gptTokens + effectiveGemini;
  const effectiveTokens = Math.max(stateTokens, telemetryTotalTokens);
  const maxTokens = loopState.resourceBudget?.maxTokens ?? 120_000;

  return (
    <aside className="w-80 bg-[#0c0c0c] border-r border-[#1f1f1f] flex flex-col h-full text-zinc-300 select-none font-mono">
      {/* Header */}
      <div className="p-3.5 border-b border-[#1f1f1f] flex items-center justify-between bg-[#0c0c0c]">
        <div className="flex items-center space-x-2">
          <RefreshCw className="w-4 h-4 text-zinc-400 animate-spin-slow" />
          <span className="font-bold text-sm tracking-wide uppercase text-zinc-100">
            Autonomous Loop
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold bg-[#18181b] text-cyan-400 border border-[#27272a]">
            REV: #{loopState.revision ?? 1}
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
          const isCompleteTerminal = item.phase === "COMPLETE" && (loopState.status === "succeeded" || displayPhase === "COMPLETE");
          const isCompleted = item.status === "completed" || isCompleteTerminal;
          const isCurrent = item.status === "current" && !isCompleteTerminal;
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

      {/* Architectural Quality Compliance (AQI) Score Card */}
      {loopState.architecturalCompliance && (
        <div className="px-3 py-2.5 border-t border-[#1f1f1f] bg-[#0c0c0c] space-y-1.5 font-mono">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Architecture Score
              </span>
              {loopState.architecturalCompliance.taskType && (
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase bg-zinc-800/90 text-zinc-300 border border-zinc-700/80">
                  {loopState.architecturalCompliance.taskType}
                </span>
              )}
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold border ${
                loopState.architecturalCompliance.passed
                  ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/60"
                  : "bg-amber-950/40 text-amber-400 border-amber-800/60"
              }`}
            >
              {loopState.architecturalCompliance.passed ? "PASSED" : "NEEDS WORK"}
            </span>
          </div>

          {/* Interactive Score Row Button - Clicking toggles details */}
          <button
            type="button"
            onClick={() => setScoreExpanded(!scoreExpanded)}
            aria-expanded={scoreExpanded}
            className="w-full bg-[#141414] hover:bg-[#1a1a1e] p-2 rounded border border-[#27272a] hover:border-zinc-700 transition-colors flex items-center justify-between text-xs text-left"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-zinc-400 text-[11px]">AQI:</span>
              <span
                className={`text-sm font-bold ${
                  loopState.architecturalCompliance.passed
                    ? "text-emerald-400"
                    : loopState.architecturalCompliance.aqi >= 3.0
                    ? "text-amber-400"
                    : "text-rose-400"
                }`}
              >
                {loopState.architecturalCompliance.aqi.toFixed(1)}
              </span>
              <span className="text-zinc-600 text-xs">/ 5.0</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-zinc-500">
              <span>{scoreExpanded ? "Hide Details" : "Show Details"}</span>
              {scoreExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
              )}
            </div>
          </button>

          {/* Expanded Sub-scores & Feedback */}
          {scoreExpanded && (
            <div className="p-2.5 rounded bg-[#101013] border border-[#222226] space-y-2 animate-fadeIn text-[11px]">
              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-[#16161a] p-1.5 rounded border border-[#27272a]">
                  <div className="text-[10px] text-zinc-500 uppercase">Surgical Diff</div>
                  <div className="text-zinc-200 font-bold mt-0.5">
                    {loopState.architecturalCompliance.criteriaScores.surgicalDiff.toFixed(1)} / 5.0
                  </div>
                </div>
                <div className="bg-[#16161a] p-1.5 rounded border border-[#27272a]">
                  <div className="text-[10px] text-zinc-500 uppercase">Simplicity</div>
                  <div className="text-zinc-200 font-bold mt-0.5">
                    {loopState.architecturalCompliance.criteriaScores.simplicity.toFixed(1)} / 5.0
                  </div>
                </div>
                <div className="bg-[#16161a] p-1.5 rounded border border-[#27272a]">
                  <div className="text-[10px] text-zinc-500 uppercase">Modularity</div>
                  <div className="text-zinc-200 font-bold mt-0.5">
                    {loopState.architecturalCompliance.criteriaScores.modularity.toFixed(1)} / 5.0
                  </div>
                </div>
                <div className="bg-[#16161a] p-1.5 rounded border border-[#27272a]">
                  <div className="text-[10px] text-zinc-500 uppercase">Maintainability</div>
                  <div className="text-zinc-200 font-bold mt-0.5">
                    {loopState.architecturalCompliance.criteriaScores.maintainability.toFixed(1)} / 5.0
                  </div>
                </div>
              </div>

              {loopState.architecturalCompliance.hardFailures && loopState.architecturalCompliance.hardFailures.length > 0 && (
                <div className="space-y-1 pt-1 border-t border-rose-900/40">
                  <div className="text-[10px] text-rose-400 uppercase font-bold">Hard Failures:</div>
                  <ul className="space-y-1 list-none pl-0">
                    {loopState.architecturalCompliance.hardFailures.map((hf, idx) => (
                      <li key={idx} className="text-[10px] text-rose-300 bg-rose-950/40 px-1.5 py-1 rounded border border-rose-800/50">
                        {hf}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {loopState.architecturalCompliance.feedback && loopState.architecturalCompliance.feedback.length > 0 && (
                <div className="space-y-1 pt-1 border-t border-[#1f1f23]">
                  <div className="text-[10px] text-zinc-500 uppercase font-semibold">Feedback / Warnings:</div>
                  <ul className="space-y-1 list-none pl-0">
                    {loopState.architecturalCompliance.feedback.map((item, idx) => (
                      <li key={idx} className="text-[10px] text-amber-300/90 bg-amber-950/20 px-1.5 py-1 rounded border border-amber-900/30">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Adversarial Audit (GPT QA) Card */}
      {loopState.audit && (
        <div className="px-3 py-2.5 border-t border-[#1f1f1f] bg-[#0c0c0c] space-y-1.5 font-mono">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Adversarial Audit
              </span>
              {loopState.audit.remediationCount > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase bg-amber-950/60 text-amber-300 border border-amber-800/40">
                  Fix #{loopState.audit.remediationCount}
                </span>
              )}
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold border ${
                loopState.audit.status === "accepted" || loopState.audit.status === "closed"
                  ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/60"
                  : loopState.audit.status === "remediation_required"
                  ? "bg-rose-950/40 text-rose-400 border-rose-800/60"
                  : loopState.audit.status === "running"
                  ? "bg-cyan-950/40 text-cyan-400 border-cyan-800/60"
                  : "bg-[#141414] text-zinc-400 border-[#27272a]"
              }`}
            >
              {loopState.audit.status.replace("_", " ").toUpperCase()}
            </span>
          </div>

          <div className="bg-[#141414] p-2 rounded border border-[#27272a] flex items-center justify-between text-xs font-mono">
            <span className="text-zinc-300">
              {loopState.audit.findings?.length ?? 0} Finding{(loopState.audit.findings?.length ?? 0) === 1 ? "" : "s"}
            </span>
            {loopState.audit.auditedTreeHash && (
              <span className="text-zinc-500 text-[10px]">
                Tree: {loopState.audit.auditedTreeHash.slice(0, 7)}
              </span>
            )}
          </div>
        </div>
      )}

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

        {/* Resource Token Telemetry */}
        <div className="bg-[#141414] p-2 rounded border border-[#27272a] text-xs font-mono flex items-center justify-between">
          <span className="text-xs text-zinc-500 font-medium">TOKENS:</span>
          <span
            className={`text-xs font-bold ${
              effectiveTokens >= maxTokens
                ? "text-rose-400"
                : effectiveTokens > 0
                ? "text-cyan-300"
                : "text-zinc-100"
            }`}
            title={`LoopState: ${(loopState.resourceUsage?.totalTokens ?? 0).toLocaleString("en-US")} | Live Telemetry: ${telemetryTotalTokens.toLocaleString("en-US")}`}
          >
            {(effectiveTokens > 0 ? effectiveTokens : (loopState.resourceUsage?.totalTokens ?? 0)).toLocaleString("en-US")} / {(loopState.resourceBudget?.maxTokens ?? 120_000).toLocaleString("en-US")}
          </span>
        </div>

        {/* Action Controls: Step Forward, Rollback, Reset */}
        <div className="space-y-1.5">
          {/* Gate Decision Trigger Button (FEAT-1) */}
          {isGate && (
            <button
              type="button"
              onClick={() => setShowGateModal(true)}
              className="w-full py-2 px-2.5 rounded text-xs font-bold flex items-center justify-center space-x-1.5 transition-all bg-emerald-600 hover:bg-emerald-500 text-white shadow-md animate-pulse"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Review Gate Decision ({loopState.currentPhase})</span>
            </button>
          )}

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

      {/* Gate Decision Confirmation Modal (FEAT-1) */}
      {showGateModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#111114] border border-[#27272a] rounded-lg max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1f1f1f] pb-3">
              <div className="flex items-center space-x-2 text-emerald-400 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5" />
                <span>Gate Decision: {loopState.currentPhase}</span>
              </div>
              <button
                type="button"
                onClick={() => { setShowGateModal(false); setGateDecisionError(null); }}
                className="text-zinc-400 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-zinc-300">
              <div className="bg-[#18181b] p-3 rounded border border-[#27272a] space-y-1 font-mono">
                <div><span className="text-zinc-500">Run ID:</span> {loopState.runId}</div>
                <div><span className="text-zinc-500">Target Gate:</span> {loopState.currentPhase}</div>
                <div>
                  <span className="text-zinc-500">Test Verification:</span>{" "}
                  <span className="text-emerald-400 font-semibold">{loopState.testSummary?.passCount ?? 0} Passed</span> /{" "}
                  <span className={(loopState.testSummary?.failCount ?? 0) > 0 ? "text-rose-400 font-bold" : "text-zinc-400"}>
                    {loopState.testSummary?.failCount ?? 0} Failed
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-1">
                  Rejection Reason (required if rejecting):
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="State the invariant or criteria that failed verification..."
                  className="w-full h-20 bg-[#0c0c0e] border border-[#27272a] rounded p-2 text-zinc-200 text-xs focus:outline-none focus:border-cyan-500 resize-none font-mono"
                />
              </div>

              {gateDecisionError && (
                <div className="text-rose-400 text-xs bg-rose-950/30 p-2 rounded border border-rose-800/40">
                  {gateDecisionError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[#1f1f1f]">
              <button
                type="button"
                onClick={() => { setShowGateModal(false); setGateDecisionError(null); }}
                className="px-3 py-1.5 rounded text-xs text-zinc-400 hover:text-white bg-[#18181b] border border-[#27272a]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isOperating}
                onClick={() => handleGateAction("reject")}
                className="px-3 py-1.5 rounded text-xs font-semibold text-rose-300 bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/60 disabled:opacity-50"
              >
                Reject Gate
              </button>
              <button
                type="button"
                disabled={isOperating}
                onClick={() => handleGateAction("approve")}
                className="px-4 py-1.5 rounded text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow-md"
              >
                Approve Gate
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export const PhaseTracker = React.memo(PhaseTrackerComponent);
