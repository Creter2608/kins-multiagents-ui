import React, { useState, useEffect } from "react";
import type { SubagentActivity } from "../../shared/contracts.js";
import { Bot, Clock, X, Copy, Check } from "lucide-react";

export interface SubagentSidebarProps {
  readonly activities: readonly SubagentActivity[];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export const SubagentSidebar: React.FC<SubagentSidebarProps> = ({ activities }) => {
  const [now, setNow] = useState<number>(Date.now());
  const [selectedActivity, setSelectedActivity] = useState<SubagentActivity | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Single component timer to refresh running/idle elapsed durations every second
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedActivity(null);
      }
    };
    if (selectedActivity) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedActivity]);

  const activeCount = activities.filter(
    (a) => a.status === "running" || a.status === "idle"
  ).length;

  return (
    <div className="flex flex-col h-full overflow-hidden text-zinc-300 font-sans select-none">
      {/* Sub-header inside tab panel */}
      <div className="p-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/80 shrink-0">
        <div className="flex items-center space-x-2">
          <Bot className="w-4 h-4 text-blue-400" />
          <span className="font-bold text-xs tracking-wider uppercase text-zinc-100">
            Subagents Queue
          </span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded border font-mono font-medium ${
            activeCount > 0
              ? "bg-blue-950/50 text-blue-300 border-blue-800/70"
              : "bg-zinc-800 text-zinc-400 border-zinc-700"
          }`}
        >
          {activeCount} Active
        </span>
      </div>

      {/* Activities list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
        {activities.length === 0 ? (
          <div className="text-center py-8 px-3 text-zinc-400 space-y-2">
            <Bot className="w-8 h-8 mx-auto text-zinc-500 opacity-80" />
            <div className="text-xs font-semibold text-zinc-300">No subagent activity</div>
            <div className="text-[11px] leading-relaxed text-zinc-400">
              Run <code className="text-zinc-200 bg-zinc-800 px-1 py-0.5 rounded border border-zinc-700 font-mono">/teamwork-preview</code> or dispatch parallel subagents to see live activity here.
            </div>
          </div>
        ) : (
          activities.map((act) => {
            const isTerminal = act.status === "completed" || act.status === "error";
            const effectiveElapsed = isTerminal
              ? act.elapsedMs
              : Math.max(0, now - act.startedAt);

            return (
              <div
                key={act.id}
                onClick={() => setSelectedActivity(act)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedActivity(act);
                  }
                }}
                className="p-3 rounded-lg bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 cursor-pointer transition-colors space-y-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center space-x-1.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        act.status === "running"
                          ? "bg-blue-400 animate-pulse motion-reduce:animate-none"
                          : act.status === "idle"
                          ? "bg-amber-400"
                          : act.status === "completed"
                          ? "bg-emerald-400"
                          : "bg-rose-500"
                      }`}
                    />
                    <span className="text-xs font-semibold text-zinc-100 truncate font-mono">
                      {act.role}
                    </span>
                  </div>

                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase shrink-0 font-medium ${
                      act.status === "running"
                        ? "bg-blue-950/50 text-blue-300 border-blue-800/70"
                        : act.status === "idle"
                        ? "bg-amber-950/50 text-amber-300 border-amber-800/70"
                        : act.status === "completed"
                        ? "bg-emerald-950/50 text-emerald-300 border-emerald-800/70"
                        : "bg-rose-950/50 text-rose-300 border-rose-800/70"
                    }`}
                  >
                    {act.status}
                  </span>
                </div>

                {(act.fullPrompt || act.promptSummary) && (
                  <div
                    tabIndex={0}
                    onClick={(e) => e.stopPropagation()}
                    className="text-[11px] text-zinc-300 max-h-24 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words select-text font-mono leading-relaxed bg-zinc-950 p-2 rounded-md border border-zinc-800/80"
                    title="Scroll or select text to inspect prompt"
                  >
                    {act.fullPrompt || act.promptSummary}
                  </div>
                )}

                <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-1 border-t border-zinc-800/80 font-mono">
                  <span className="text-zinc-400 truncate max-w-[110px]">
                    {act.model}
                  </span>
                  <div className="flex items-center space-x-1 text-zinc-300">
                    <Clock className="w-3 h-3 text-zinc-400" />
                    <span>{formatDuration(effectiveElapsed)}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Selected Activity Detail Modal */}
      {selectedActivity && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subagent-modal-title"
          onClick={() => setSelectedActivity(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full shadow-2xl overflow-hidden text-zinc-200 flex flex-col max-h-[85vh] font-sans"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900">
              <div className="flex items-center space-x-2">
                <Bot className="w-4 h-4 text-blue-400" />
                <span id="subagent-modal-title" className="text-xs font-bold text-zinc-100 uppercase tracking-wide">
                  Subagent Details
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedActivity(null)}
                aria-label="Close subagent details"
                className="p-1 hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto text-xs custom-scrollbar">
              <div>
                <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">Role</div>
                <div className="text-zinc-100 font-semibold">{selectedActivity.role}</div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">ID</div>
                <div className="text-zinc-200 break-all bg-zinc-950 p-2 rounded-lg border border-zinc-800 font-mono text-[11px]">{selectedActivity.id}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">Model</div>
                  <div className="text-zinc-200 font-mono">{selectedActivity.model}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">Status</div>
                  <div className="capitalize text-zinc-200 font-medium">{selectedActivity.status}</div>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">
                  <span>Prompt / Task Details</span>
                  {(selectedActivity.fullPrompt || selectedActivity.promptSummary) && (
                    <button
                      type="button"
                      onClick={() => {
                        const text = selectedActivity.fullPrompt || selectedActivity.promptSummary;
                        if (text) {
                          navigator.clipboard.writeText(text);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }
                      }}
                      className="text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1 font-mono text-[10px] lowercase cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 rounded px-1"
                      title="Copy full prompt to clipboard"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>copy</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div
                  tabIndex={0}
                  className="text-zinc-200 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800 text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-56 overflow-y-auto custom-scrollbar select-text font-mono"
                >
                  {selectedActivity.fullPrompt || selectedActivity.promptSummary || "(No prompt summary recorded)"}
                </div>
              </div>
              {selectedActivity.errorMessage && (
                <div>
                  <div className="text-[10px] text-rose-400 uppercase font-bold tracking-wider mb-0.5">Error Details</div>
                  <div className="text-rose-300 bg-rose-950/30 border border-rose-800/60 p-2 rounded-lg text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                    {selectedActivity.errorMessage}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800 text-[11px] text-zinc-400 font-mono">
                <div>Started: {new Date(selectedActivity.startedAt).toLocaleTimeString()}</div>
                <div>Elapsed: {formatDuration(selectedActivity.completedAt ? selectedActivity.elapsedMs : Math.max(0, now - selectedActivity.startedAt))}</div>
              </div>
            </div>

            <div className="p-3 border-t border-zinc-800 bg-zinc-900 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedActivity(null)}
                className="min-h-[32px] px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700/80 text-zinc-200 text-xs font-semibold border border-zinc-700/70 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
