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
    <div className="border-t border-slate-800 bg-slate-950/95 flex flex-col transition-all duration-200 select-none">
      {/* Drawer Header Toggle Bar */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="h-8 px-3.5 flex items-center justify-between cursor-pointer hover:bg-slate-900/60 transition-colors"
      >
        <div className="flex items-center space-x-3 text-xs">
          <div className="flex items-center space-x-1.5 font-medium text-slate-300">
            {isOpen ? (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            )}
            <span>Critical Logs & Events</span>
          </div>

          <div className="flex items-center space-x-1.5">
            {errorCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono font-medium flex items-center space-x-1">
                <AlertOctagon className="w-3 h-3 text-rose-400" />
                <span>{errorCount} ERRORS</span>
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-medium flex items-center space-x-1">
                <AlertTriangle className="w-3 h-3 text-amber-400" />
                <span>{warnCount} WARNS</span>
              </span>
            )}
          </div>
        </div>

        {/* Right side summary when closed */}
        {!isOpen && latestError && (
          <div className="text-[11px] text-rose-400/90 font-mono truncate max-w-md hidden md:block">
            Latest: {latestError.message}
          </div>
        )}
      </div>

      {/* Drawer Content */}
      {isOpen && (
        <div className="h-44 border-t border-slate-800/80 flex flex-col bg-slate-950">
          {/* Filter & Toolbar */}
          <div className="px-3 py-1.5 border-b border-slate-800/60 flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center space-x-1.5">
              {(["ALL", "ERROR", "WARNING", "MILESTONE"] as const).map((sev) => (
                <button
                  key={sev}
                  onClick={() => setFilterSeverity(sev)}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    filterSeverity === sev
                      ? "bg-slate-800 text-slate-100 font-medium border border-slate-700"
                      : "text-slate-400 hover:text-slate-200"
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
                className="w-full bg-slate-900 border border-slate-800 rounded pl-7 pr-2 py-0.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-600 font-mono"
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
                    className={`p-1.5 rounded flex items-start justify-between group hover:bg-slate-900/60 ${
                      isError
                        ? "bg-rose-950/20 text-rose-300/90 border-l-2 border-rose-500"
                        : isWarning
                        ? "bg-amber-950/20 text-amber-300/90 border-l-2 border-amber-500"
                        : "bg-slate-900/40 text-slate-300 border-l-2 border-cyan-500"
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
                        <Check className="w-3 h-3 text-emerald-400" />
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
