import React, { useState, useMemo, useRef, useEffect } from "react";
import type { CriticalLogEntry } from "../../shared/contracts.js";
import { ChevronUp, ChevronDown, AlertTriangle, AlertOctagon, Flag, Copy, Check, Search } from "lucide-react";

interface CriticalLogDrawerProps {
  readonly logs: readonly CriticalLogEntry[];
}

export const CriticalLogDrawer: React.FC<CriticalLogDrawerProps> = ({ logs }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const errorCount = useMemo(
    () => logs.filter((l) => l.severity === "ERROR").length,
    [logs]
  );
  const warnCount = useMemo(
    () => logs.filter((l) => l.severity === "WARNING").length,
    [logs]
  );

  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (filterSeverity !== "ALL" && entry.severity !== filterSeverity) {
        return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          entry.message.toLowerCase().includes(q) ||
          entry.source.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [logs, filterSeverity, searchQuery]);

  useEffect(() => {
    if (isOpen && listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs.length, isOpen]);

  const handleCopyTrace = (entry: CriticalLogEntry) => {
    const text = entry.stackTrace ? `${entry.message}\n${entry.stackTrace}` : entry.message;
    void navigator.clipboard.writeText(text);
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const latestError = useMemo(() => {
    return logs.slice().reverse().find((l) => l.severity === "ERROR");
  }, [logs]);

  return (
    <div className="border-t border-[#1f1f1f] bg-[#0c0c0c] flex flex-col transition-all duration-200 select-none font-mono">
      {/* Drawer Header Toggle Bar */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="h-10 px-4 flex items-center justify-between cursor-pointer hover:bg-[#141414] transition-colors bg-[#0c0c0c]"
      >
        <div className="flex items-center space-x-3.5 text-xs">
          <div className="flex items-center space-x-2 font-bold text-sm text-zinc-100">
            {isOpen ? (
              <ChevronDown className="w-4 h-4 text-zinc-400" />
            ) : (
              <ChevronUp className="w-4 h-4 text-zinc-400" />
            )}
            <span>Critical Logs & Events</span>
          </div>

          <div className="flex items-center space-x-2">
            {errorCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded font-mono font-bold flex items-center space-x-1.5 bg-rose-950/40 text-rose-300 border border-rose-800/60">
                <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />
                <span>{errorCount} ERRORS</span>
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded font-mono font-bold flex items-center space-x-1.5 bg-amber-950/40 text-amber-300 border border-amber-800/60">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>{warnCount} WARNS</span>
              </span>
            )}
          </div>
        </div>

        {/* Right side summary when closed */}
        {!isOpen && latestError && (
          <div className="text-xs text-rose-300 font-mono font-medium truncate max-w-md hidden md:block bg-rose-950/40 px-2 py-0.5 rounded border border-rose-800/60">
            Latest: {latestError.message}
          </div>
        )}
      </div>

      {/* Drawer Content */}
      {isOpen && (
        <div className="h-44 border-t border-[#1f1f1f] flex flex-col bg-[#000000]">
          {/* Filter & Toolbar */}
          <div className="px-3 py-1.5 border-b border-[#1f1f1f] flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center space-x-1.5">
              {(["ALL", "ERROR", "WARNING", "MILESTONE"] as const).map((sev) => (
                <button
                  key={sev}
                  onClick={() => setFilterSeverity(sev)}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    filterSeverity === sev
                      ? "bg-[#1f1f1f] text-zinc-100 font-medium border border-[#27272a]"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative w-52">
              <Search className="w-3 h-3 text-slate-500 absolute left-2 top-2" />
              <input
                type="text"
                placeholder="Search log messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#121212] border border-[#262626] rounded pl-7 pr-2 py-0.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[#404040] font-mono"
              />
            </div>
          </div>

          {/* Logs Stream */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-xs custom-scrollbar">
            {filteredLogs.length === 0 ? (
              <div className="text-slate-500 italic p-2 text-center">
                No logs matching current filter
              </div>
            ) : (
              filteredLogs.map((entry) => {
                const isError = entry.severity === "ERROR";
                const isWarning = entry.severity === "WARNING";
                const isMilestone = entry.severity === "MILESTONE";

                return (
                  <div
                    key={entry.id}
                    className={`p-1.5 rounded flex items-start justify-between group hover:bg-[#121212] ${
                      isError
                        ? "bg-rose-950/20 text-rose-300/90 border-l-2 border-rose-500"
                        : isWarning
                        ? "bg-amber-950/20 text-amber-300/90 border-l-2 border-amber-500"
                        : "bg-[#121212] text-slate-300 border-l-2 border-cyan-600"
                    }`}
                  >
                    <div className="flex items-start space-x-2 truncate">
                      <span className="text-[10px] text-slate-500 shrink-0 mt-0.5">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className={`text-[10px] px-1 py-0.2 rounded font-bold shrink-0 ${
                          isError
                            ? "bg-rose-900/40 text-rose-400"
                            : isWarning
                            ? "bg-amber-900/40 text-amber-400"
                            : "bg-cyan-900/40 text-cyan-400"
                        }`}
                      >
                        {entry.severity}
                      </span>
                      <span className="truncate">{entry.message}</span>
                    </div>

                    <button
                      onClick={() => handleCopyTrace(entry)}
                      title="Copy error trace"
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-200 shrink-0 ml-2"
                    >
                      {copiedId === entry.id ? (
                        <Check className="w-3 h-3 text-emerald-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                );
              })
            )}
            <div ref={listEndRef} />
          </div>
        </div>
      )}
    </div>
  );
};
