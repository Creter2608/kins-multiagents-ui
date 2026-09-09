import React, { useState } from "react";
import { AlertTriangle, RotateCcw, CheckCircle, XCircle, X, ShieldAlert } from "lucide-react";
import type { LoopStateSnapshot } from "../../shared/contracts.js";

export interface QualityGateDecisionModalProps {
  readonly open: boolean;
  readonly loopState: LoopStateSnapshot;
  readonly onRemediate: (reason: string, feedback: string) => Promise<void>;
  readonly onOverride: (reason: string, ticketReference?: string) => Promise<void>;
  readonly onReject: (reason: string) => Promise<void>;
  readonly onClose: () => void;
}

export const QualityGateDecisionModal: React.FC<QualityGateDecisionModalProps> = ({
  open,
  loopState,
  onRemediate,
  onOverride,
  onReject,
  onClose
}) => {
  const [selectedAction, setSelectedAction] = useState<"remediate" | "override" | "reject">("remediate");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [ticketReference, setTicketReference] = useState("");
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  const aqi = loopState.architecturalCompliance?.aqi ?? 0;
  const minAqi = loopState.architecturalCompliance?.minAqi ?? loopState.architecturalCompliance?.threshold ?? 3.5;
  const currentRemediations = loopState.resourceUsage?.qualityRemediations ?? 0;
  const maxRemediations = loopState.resourceBudget?.maxQualityRemediations ?? 1;
  const canRemediate = currentRemediations < maxRemediations;
  const artifactHash = loopState.qualityGateBlock?.artifactHash || loopState.blueprint?.artifactSha256 || "N/A";
  const findings = loopState.architecturalCompliance?.feedback || [];
  const auditFindings = loopState.qualityGateBlock?.auditFindingIds || [];

  async function handleSubmit() {
    if (!reason.trim()) {
      setErrorMsg("A justification reason is required for any quality gate disposition.");
      return;
    }
    if (selectedAction === "remediate" && !feedback.trim()) {
      setErrorMsg("Actionable feedback is required when choosing to loop again for remediation.");
      return;
    }
    if (selectedAction === "override" && !confirmOverride) {
      setErrorMsg("You must check the confirmation box to authorize overriding the quality gate.");
      return;
    }
    if (selectedAction === "reject" && !confirmReject) {
      setErrorMsg("You must check the confirmation box to confirm discarding changes.");
      return;
    }

    setIsBusy(true);
    setErrorMsg(null);
    try {
      if (selectedAction === "remediate") {
        await onRemediate(reason, feedback);
      } else if (selectedAction === "override") {
        await onOverride(reason, ticketReference);
      } else {
        await onReject(reason);
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qg-dialog-title"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    >
      <div className="bg-[#111114] border border-[#27272a] rounded-xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#27272a] pb-3">
          <div className="flex items-center space-x-2.5 text-amber-400 font-bold text-base" id="qg-dialog-title">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span>Quality Gate Decision Required</span>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={onClose}
            aria-label="Close quality gate modal"
            className="text-zinc-400 hover:text-white p-1 rounded transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quality Findings Summary */}
        <div className="bg-[#18181b] border border-[#27272a] rounded-lg p-3 space-y-1.5 text-xs font-mono">
          <div className="flex justify-between items-center text-zinc-300">
            <span className="text-zinc-500">Run ID:</span>
            <span className="text-zinc-200">{loopState.runId}</span>
          </div>
          <div className="flex justify-between items-center text-zinc-300">
            <span className="text-zinc-500">Artifact Hash:</span>
            <span className="text-zinc-400 font-mono text-[11px]" title={artifactHash}>
              {artifactHash.slice(0, 16)}...
            </span>
          </div>
          <div className="flex justify-between items-center text-zinc-300">
            <span className="text-zinc-500">Architectural AQI:</span>
            <span className={aqi >= minAqi ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
              {aqi.toFixed(1)} / {minAqi.toFixed(1)} ({aqi >= minAqi ? "PASS" : "FAIL"})
            </span>
          </div>
          <div className="flex justify-between items-center text-zinc-300">
            <span className="text-zinc-500">Remediation Quota:</span>
            <span className={canRemediate ? "text-cyan-400" : "text-zinc-500"}>
              {currentRemediations} used / {maxRemediations} allowed
            </span>
          </div>
          {(findings.length > 0 || auditFindings.length > 0) && (
            <div className="pt-2 border-t border-[#27272a]/60 space-y-1">
              <span className="text-zinc-500 block text-[11px]">Findings Summary:</span>
              <ul className="text-rose-300/90 text-[11px] list-disc list-inside space-y-0.5 max-h-20 overflow-y-auto">
                {findings.slice(0, 3).map((f, i) => (
                  <li key={i} className="truncate">{f}</li>
                ))}
                {auditFindings.slice(0, 3).map((id, i) => (
                  <li key={`audit-${i}`} className="truncate">Defect ID: {id}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* 3-Way Choice Radio Cards */}
        <div className="space-y-2">
          <label className="text-zinc-400 text-xs font-semibold uppercase tracking-wider block">
            Select Disposition:
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            {/* Option 1: Remediate */}
            <button
              type="button"
              disabled={!canRemediate || isBusy}
              onClick={() => setSelectedAction("remediate")}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedAction === "remediate"
                  ? "border-cyan-500 bg-cyan-950/30 text-white"
                  : canRemediate
                  ? "border-[#27272a] bg-[#141417] text-zinc-400 hover:border-zinc-700"
                  : "border-[#27272a]/50 bg-[#141417]/40 text-zinc-600 cursor-not-allowed"
              }`}
            >
              <div className="flex items-center space-x-1.5 font-bold text-xs mb-1">
                <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
                <span>Loop Again</span>
              </div>
              <p className="text-[10px] text-zinc-400 leading-snug">
                {canRemediate ? "Targeted fix retry using findings ($0 LLM)." : "Quota exhausted."}
              </p>
            </button>

            {/* Option 2: Override */}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setSelectedAction("override")}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedAction === "override"
                  ? "border-amber-500 bg-amber-950/30 text-white"
                  : "border-[#27272a] bg-[#141417] text-zinc-400 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center space-x-1.5 font-bold text-xs mb-1 text-amber-300">
                <CheckCircle className="w-3.5 h-3.5 text-amber-400" />
                <span>Override Gate</span>
              </div>
              <p className="text-[10px] text-zinc-400 leading-snug">
                Waive quality check & proceed to RELEASE_GATE.
              </p>
            </button>

            {/* Option 3: Reject */}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setSelectedAction("reject")}
              className={`p-3 rounded-lg border text-left transition-all ${
                selectedAction === "reject"
                  ? "border-rose-500 bg-rose-950/30 text-white"
                  : "border-[#27272a] bg-[#141417] text-zinc-400 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center space-x-1.5 font-bold text-xs mb-1 text-rose-300">
                <XCircle className="w-3.5 h-3.5 text-rose-400" />
                <span>Reject & Revert</span>
              </div>
              <p className="text-[10px] text-zinc-400 leading-snug">
                Discard task changes, mark run as FAILED.
              </p>
            </button>
          </div>
        </div>

        {/* Input Form Fields */}
        <div className="space-y-3">
          <div>
            <label className="block text-zinc-400 text-xs font-medium mb-1">
              Operator Justification Reason <span className="text-rose-400">*</span>:
            </label>
            <input
              type="text"
              disabled={isBusy}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Hotfix approved / False-positive churn penalty / Architectural rework needed"
              className="w-full bg-[#0c0c0e] border border-[#27272a] rounded px-3 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-cyan-500 font-mono disabled:opacity-50"
            />
          </div>

          {selectedAction === "remediate" && (
            <div>
              <label className="block text-zinc-400 text-xs font-medium mb-1">
                Remediation Guidance Feedback <span className="text-rose-400">*</span>:
              </label>
              <textarea
                disabled={isBusy}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Specify exact AST findings or files to simplify/refactor..."
                className="w-full h-14 bg-[#0c0c0e] border border-[#27272a] rounded p-2 text-zinc-200 text-xs focus:outline-none focus:border-cyan-500 resize-none font-mono disabled:opacity-50"
              />
            </div>
          )}

          {selectedAction === "override" && (
            <div className="space-y-2">
              <div>
                <label className="block text-zinc-400 text-xs font-medium mb-1">
                  Ticket / Incident Reference (Optional):
                </label>
                <input
                  type="text"
                  disabled={isBusy}
                  value={ticketReference}
                  onChange={(e) => setTicketReference(e.target.value)}
                  placeholder="e.g. INC-10492 / JIRA-881"
                  className="w-full bg-[#0c0c0e] border border-[#27272a] rounded px-3 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-cyan-500 font-mono disabled:opacity-50"
                />
              </div>
              <label className="flex items-center space-x-2 text-xs text-amber-300/90 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  disabled={isBusy}
                  checked={confirmOverride}
                  onChange={(e) => setConfirmOverride(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-amber-500 focus:ring-0"
                />
                <span>I confirm this quality waiver will advance to RELEASE_GATE with an immutable audit record.</span>
              </label>
            </div>
          )}

          {selectedAction === "reject" && (
            <label className="flex items-center space-x-2 text-xs text-rose-300/90 cursor-pointer pt-1">
              <input
                type="checkbox"
                disabled={isBusy}
                checked={confirmReject}
                onChange={(e) => setConfirmReject(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-900 text-rose-500 focus:ring-0"
              />
              <span>I confirm discarding task-owned changes and transitioning the run to FAILED.</span>
            </label>
          )}

          {errorMsg && (
            <div
              role="alert"
              aria-live="assertive"
              className="flex items-center space-x-2 text-rose-400 text-xs bg-rose-950/40 p-2.5 rounded border border-rose-800/40 font-mono"
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end space-x-2.5 pt-3 border-t border-[#27272a]">
          <button
            type="button"
            disabled={isBusy}
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white bg-[#18181b] border border-[#27272a] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={handleSubmit}
            className={`px-5 py-1.5 rounded-lg text-xs font-bold text-white shadow-lg transition-all disabled:opacity-50 ${
              selectedAction === "remediate"
                ? "bg-cyan-600 hover:bg-cyan-500"
                : selectedAction === "override"
                ? "bg-amber-600 hover:bg-amber-500"
                : "bg-rose-600 hover:bg-rose-500"
            }`}
          >
            {isBusy ? "Processing..." : `Confirm ${selectedAction.charAt(0).toUpperCase() + selectedAction.slice(1)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

