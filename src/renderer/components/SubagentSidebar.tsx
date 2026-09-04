import React, { useState, useEffect } from "react";
import type { SubagentActivity } from "../../shared/contracts.js";
import { Bot, Clock, X } from "lucide-react";

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
    <div className="flex flex-col h-full overflow-hidden text-zinc-300 font-mono select-none">
      {/* Sub-header inside tab panel */}
      <div className="p-3 border-b border-[#1f1f1f] flex items-center justify-between bg-[#0c0c0c] shrink-0">
        <div className="flex items-center space-x-2">
          <Bot className="w-4 h-4 text-blue-400" />
          <span className="font-bold text-xs tracking-wider uppercase text-zinc-100">
            Subagents Queue
          </span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded border font-mono font-medium ${
            activeCount > 0
              ? "bg-blue-950/40 text-blue-400 border-blue-800/60"
              : "bg-zinc-900 text-zinc-500 border-zinc-800"
          }`}
        >
          {activeCount} Active
        </span>
      </div>

      {/* Activities list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
        {activities.length === 0 ? (
          <div className="text-center py-8 px-3 text-zinc-500 space-y-2">
            <Bot className="w-8 h-8 mx-auto text-zinc-600 opacity-60" />
            <div className="text-xs font-medium text-zinc-400">No subagent activity</div>
            <div className="text-[11px] leading-relaxed text-zinc-600">
              Run <code className="text-zinc-400 bg-zinc-900 px-1 py-0.5 rounded border border-zinc-800">/teamwork-preview</code> or dispatch parallel subagents to see live activity here.
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
                className="p-2.5 rounded bg-[#141414] border border-[#27272a] hover:border-zinc-600 cursor-pointer transition-colors space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center space-x-1.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        act.status === "running"
                          ? "bg-blue-400 animate-pulse"
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
                        ? "bg-blue-950/40 text-blue-300 border-blue-800/60"
                        : act.status === "idle"
                        ? "bg-amber-950/40 text-amber-300 border-amber-800/60"
                        : act.status === "completed"
                        ? "bg-emerald-950/40 text-emerald-300 border-emerald-800/60"
                        : "bg-rose-950/40 text-rose-300 border-rose-800/60"
                    }`}
                  >
                    {act.status}
                  </span>
                </div>

                {act.promptSummary && (
                  <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                    {act.promptSummary}
                  </p>
                )}

                <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1 border-t border-[#1f1f1f]">
                  <span className="text-zinc-500 truncate max-w-[110px]">
                    {act.model}
                  </span>
                  <div className="flex items-center space-x-1 text-zinc-400">
                    <Clock className="w-3 h-3 text-zinc-500" />
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
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-[#121212] border border-[#27272a] rounded-lg max-w-md w-full shadow-2xl overflow-hidden text-zinc-300 flex flex-col max-h-[85vh]">
            <div className="px-4 py-3 border-b border-[#27272a] flex items-center justify-between bg-[#18181b]">
              <div className="flex items-center space-x-2">
                <Bot className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-bold text-zinc-100 uppercase tracking-wide">
                  Subagent Details
                </span>
              </div>
              <button
                onClick={() => setSelectedActivity(null)}
                className="p-1 hover:bg-[#27272a] rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto text-xs">
              <div>
                <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5">Role</div>
                <div className="text-zinc-100 font-semibold">{selectedActivity.role}</div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5">ID</div>
                <div className="text-zinc-300 break-all bg-black/40 p-1.5 rounded border border-[#27272a] font-mono text-[11px]">{selectedActivity.id}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5">Model</div>
                  <div className="text-zinc-300">{selectedActivity.model}</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5">Status</div>
                  <div className="capitalize text-zinc-300">{selectedActivity.status}</div>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-0.5">Prompt Summary</div>
                <div className="text-zinc-300 bg-black/40 p-2 rounded border border-[#27272a] text-[11px] leading-relaxed whitespace-pre-wrap">
                  {selectedActivity.promptSummary || "(No prompt summary recorded)"}
                </div>
              </div>
              {selectedActivity.errorMessage && (
                <div>
                  <div className="text-[10px] text-rose-400 uppercase font-bold tracking-wider mb-0.5">Error Details</div>
                  <div className="text-rose-300 bg-rose-950/20 border border-rose-800/40 p-2 rounded text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                    {selectedActivity.errorMessage}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#27272a] text-[11px] text-zinc-400">
                <div>Started: {new Date(selectedActivity.startedAt).toLocaleTimeString()}</div>
                <div>Elapsed: {formatDuration(selectedActivity.completedAt ? selectedActivity.elapsedMs : Math.max(0, now - selectedActivity.startedAt))}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
