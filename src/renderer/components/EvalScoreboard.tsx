import React, { useState } from "react";
import type { EvalHarnessSnapshot } from "../../shared/contracts.js";
import {
  FlaskConical,
  Play,
  RotateCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldAlert,
  Clock,
  Check,
  X
} from "lucide-react";

export interface EvalScoreboardProps {
  readonly snapshot: EvalHarnessSnapshot;
  readonly onRunBenchmark: () => Promise<void>;
}

export const EvalScoreboard: React.FC<EvalScoreboardProps> = ({ snapshot, onRunBenchmark }) => {
  const [inFlight, setInFlight] = useState(false);
  const isRunning = snapshot.status === "running" || inFlight;
  const report = snapshot.report;
  const hasEvaluatedTasks = Boolean(report && report.results && report.results.length > 0);
  const hasNoTasks = Boolean(report && (!report.results || report.results.length === 0));

  const handleRun = async () => {
    if (isRunning) return;
    setInFlight(true);
    try {
      await onRunBenchmark();
    } finally {
      setInFlight(false);
    }
  };

  const getStatusBadge = () => {
    if (isRunning) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-pulse">
          <RotateCw className="w-3.5 h-3.5 animate-spin" />
          BENCHMARK RUNNING
        </span>
      );
    }
    if (snapshot.status === "malformed") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <AlertTriangle className="w-3.5 h-3.5" />
          MALFORMED REPORT
        </span>
      );
    }
    if (snapshot.status === "failed") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <XCircle className="w-3.5 h-3.5" />
          RUN FAILED
        </span>
      );
    }
    if (report) {
      if (report.violations && report.violations.length > 0) {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <ShieldAlert className="w-3.5 h-3.5" />
            DISQUALIFIED (TAMPERING)
          </span>
        );
      }
      if (hasNoTasks) {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
            <Clock className="w-3.5 h-3.5" />
            NO TASKS FOUND
          </span>
        );
      }
      if (report.passed) {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" />
            PASSED 100%
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <XCircle className="w-3.5 h-3.5" />
          BENCHMARK FAILED
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
        <Clock className="w-3.5 h-3.5" />
        IDLE (NO RUN)
      </span>
    );
  };

  const f2pCount = report?.results.filter((r) => r.kind === "f2p").length ?? 0;
  const p2pCount = report?.results.filter((r) => r.kind === "p2p").length ?? 0;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] text-zinc-200 border-l border-zinc-800/80 overflow-y-auto">
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-[#0d0d0d]">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <FlaskConical className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-100 flex items-center gap-2">
              Deep Evaluation Benchmark Harness
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                ADR-005
              </span>
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Empirical Pass@1 &amp; Anti-Gaming Verification Engine (Hermetic Worktree Execution)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {getStatusBadge()}
          <button
            onClick={() => void handleRun()}
            disabled={isRunning}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              isRunning
                ? "bg-zinc-800 text-zinc-500 border border-zinc-700/50 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-900/30 active:scale-95"
            }`}
          >
            {isRunning ? (
              <>
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Run Benchmark
              </>
            )}
          </button>
        </div>
      </div>

      <div className="p-6 space-y-6 flex-1">
        {/* Anti-Gaming Violations Warning Banner */}
        {report && report.violations && report.violations.length > 0 && (
          <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-500/40 text-rose-300">
            <div className="flex items-center gap-2 font-semibold text-rose-400 text-sm">
              <ShieldAlert className="w-5 h-5" />
              SPECIFICATION INTEGRITY VIOLATION ({report.violations.length})
            </div>
            <p className="text-xs text-rose-300/80 mt-1">
              Submission disqualified: Agent attempted unauthorized modification of protected ground truth or assertion relaxation.
            </p>
            <div className="mt-3 space-y-1.5">
              {report.violations.map((v, idx) => (
                <div key={idx} className="text-xs font-mono bg-black/40 p-2 rounded border border-rose-500/20 text-rose-200">
                  <span className="text-rose-400 font-bold">[{v.code}]</span> {v.path}
                  {v.line ? `:${v.line}` : ""}: {v.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error banner if any */}
        {snapshot.error && (
          <div className="p-3.5 rounded-lg bg-amber-950/20 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="font-mono whitespace-pre-wrap break-all">{snapshot.error}</div>
          </div>
        )}

        {/* Metric Cards Grid */}
        <div className="grid grid-cols-4 gap-4">
          {/* Card 1: Pass@1 */}
          <div className="p-4 rounded-xl bg-[#0f0f10] border border-zinc-800/80 shadow-sm">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-medium">Pass@1 (First-Shot)</div>
            <div
              className={`text-2xl font-bold font-mono mt-1 ${
                hasEvaluatedTasks && report
                  ? report.metrics.passAt1 === 1
                    ? "text-emerald-400"
                    : report.metrics.passAt1 > 0
                    ? "text-amber-400"
                    : "text-rose-400"
                  : "text-zinc-600"
              }`}
            >
              {hasEvaluatedTasks && report ? `${(report.metrics.passAt1 * 100).toFixed(0)}%` : "--%"}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">Zero-shot 0-retry success rate</div>
          </div>

          {/* Card 2: Pass@k */}
          <div className="p-4 rounded-xl bg-[#0f0f10] border border-zinc-800/80 shadow-sm">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-medium">Pass@k (k=1)</div>
            <div
              className={`text-2xl font-bold font-mono mt-1 ${
                hasEvaluatedTasks && report
                  ? report.metrics.passAtK === 1
                    ? "text-emerald-400"
                    : report.metrics.passAtK > 0
                    ? "text-amber-400"
                    : "text-rose-400"
                  : "text-zinc-600"
              }`}
            >
              {hasEvaluatedTasks && report ? `${(report.metrics.passAtK * 100).toFixed(0)}%` : "--%"}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">Bounded retry resolution</div>
          </div>

          {/* Card 3: SSI */}
          <div className="p-4 rounded-xl bg-[#0f0f10] border border-zinc-800/80 shadow-sm">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-medium">Semantic Stability (SSI)</div>
            <div
              className={`text-2xl font-bold font-mono mt-1 ${
                hasEvaluatedTasks && report
                  ? report.metrics.ssi === 1
                    ? "text-emerald-400"
                    : "text-rose-400"
                  : "text-zinc-600"
              }`}
            >
              {hasEvaluatedTasks && report ? `${(report.metrics.ssi * 100).toFixed(0)}%` : "--%"}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">Regression-free P2P preservation</div>
          </div>

          {/* Card 4: Task Counts */}
          <div className="p-4 rounded-xl bg-[#0f0f10] border border-zinc-800/80 shadow-sm">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-medium">Tasks Evaluated</div>
            <div className="text-2xl font-bold font-mono mt-1 text-zinc-100">
              {report ? report.results.length : 0}
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">
              F2P: <span className="text-cyan-400 font-mono font-medium">{f2pCount}</span> | P2P:{" "}
              <span className="text-purple-400 font-mono font-medium">{p2pCount}</span>
            </div>
          </div>
        </div>

        {/* Task Details Table */}
        {hasEvaluatedTasks && report ? (
          <div className="rounded-xl border border-zinc-800/80 bg-[#0d0d0e] overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800/80 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Evaluation Task Breakdown
              </span>
              <span className="text-[11px] text-zinc-400 font-mono">
                Base Commit: {report.baseCommit.slice(0, 10)}
              </span>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {report.results.map((task) => (
                <div key={task.id} className="px-4 py-3 flex items-center justify-between text-xs hover:bg-zinc-800/20">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        task.passed ? "bg-emerald-400 shadow-sm shadow-emerald-500/50" : "bg-rose-500"
                      }`}
                    />
                    <span className="font-mono font-semibold text-zinc-200">{task.id}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${
                        task.kind === "f2p"
                          ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                          : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                      }`}
                    >
                      {task.kind}
                    </span>
                  </div>

                  <div className="flex items-center gap-6 text-zinc-400 font-mono text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400">Base:</span>
                      {task.base.passed ? (
                        <span className="text-emerald-400 inline-flex items-center gap-0.5">
                          <Check className="w-3 h-3" /> PASS
                        </span>
                      ) : (
                        <span className="text-rose-400 inline-flex items-center gap-0.5">
                          <X className="w-3 h-3" /> FAIL
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400">Current:</span>
                      {task.current.passed ? (
                        <span className="text-emerald-400 inline-flex items-center gap-0.5">
                          <Check className="w-3 h-3" /> PASS
                        </span>
                      ) : (
                        <span className="text-rose-400 inline-flex items-center gap-0.5">
                          <X className="w-3 h-3" /> FAIL
                        </span>
                      )}
                    </div>

                    <div className="w-16 text-right">
                      {task.passed ? (
                        <span className="font-bold text-emerald-400">RESOLVED</span>
                      ) : (
                        <span className="font-bold text-rose-400">UNRESOLVED</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : hasNoTasks ? (
          <div className="p-12 text-center rounded-xl border border-dashed border-zinc-800/80 bg-[#0d0d0e]/50">
            <FlaskConical className="w-10 h-10 text-zinc-500 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-zinc-300">No Benchmark Tasks Found</h3>
            <p className="text-xs text-zinc-400 mt-1.5 max-w-md mx-auto leading-relaxed">
              The benchmark harness executed successfully, but no task definitions were found in{" "}
              <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[11px] border border-zinc-700/60">
                .eval/harness/tasks
              </code>.
            </p>
            <p className="text-xs text-zinc-500 mt-2 max-w-md mx-auto">
              Add task JSON files with <code className="text-zinc-400 font-mono">f2p</code> (Fail-to-Pass) or{" "}
              <code className="text-zinc-400 font-mono">p2p</code> (Pass-to-Pass) kind to evaluate model performance, then click &ldquo;Run Benchmark&rdquo; again.
            </p>
          </div>
        ) : (
          <div className="p-12 text-center rounded-xl border border-dashed border-zinc-800/80 bg-[#0d0d0e]/50">
            <FlaskConical className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-zinc-300">No Evaluation Report Loaded</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
              Click &ldquo;Run Benchmark&rdquo; above to execute the zero-dependency test harness against baseline git worktrees.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
