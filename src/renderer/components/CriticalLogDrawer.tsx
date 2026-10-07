import React, { useState, useMemo, useRef, useEffect } from "react";
import type { CriticalLogEntry } from "../../shared/contracts.js";
import { ChevronUp, ChevronDown, AlertTriangle, AlertOctagon, Flag, Copy, Check, Search, Trash2 } from "lucide-react";

interface CriticalLogDrawerProps {
  readonly logs: readonly CriticalLogEntry[];
}

export const CriticalLogDrawer: React.FC<CriticalLogDrawerProps> = ({ logs }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const handleClearLogs = async () => {
    if (window.cockpitApi?.logs.clear) {
      await window.cockpitApi.logs.clear();
    }
  };

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
    <div className="border-t border-zinc-800 bg-zinc-900 flex flex-col transition-all duration-150 select-none font-sans">
      {/* Drawer Header Toggle Bar */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="critical-log-drawer-content"
        className="w-full h-10 px-4 flex items-center justify-between cursor-pointer hover:bg-zinc-850 transition-colors bg-zinc-900 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
      >
        <div className="flex items-center space-x-3.5 text-xs">
          <div className="flex items-center space-x-2 font-bold text-sm text-zinc-100">
            {isOpen ? (
              <ChevronDown className="w-4 h-4 text-zinc-400" />
            ) : (
              <ChevronUp className="w-4 h-4 text-zinc-400" />
            )}
            <span>Critical Logs &amp; Events</span>
          </div>

          <div className="flex items-center space-x-2">
            {errorCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded font-mono font-bold flex items-center space-x-1.5 bg-rose-950/50 text-rose-300 border border-rose-800/70">
                <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />
                <span>{errorCount} ERRORS</span>
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded font-mono font-bold flex items-center space-x-1.5 bg-amber-950/50 text-amber-300 border border-amber-800/70">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>{warnCount} WARNS</span>
              </span>
            )}
          </div>
        </div>

        {/* Right side summary when closed */}
        {!isOpen && latestError && (
          <div className="text-xs text-rose-300 font-mono font-medium truncate max-w-md hidden md:block bg-rose-950/50 px-2 py-0.5 rounded border border-rose-800/70">
            Latest: {latestError.message}
          </div>
        )}
      </button>

      {/* Drawer Content */}
      {isOpen && (
        <div id="critical-log-drawer-content" className="h-48 border-t border-zinc-800 flex flex-col bg-zinc-950 font-sans">
          {/* Filter & Toolbar */}
          <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center justify-between gap-2 text-xs bg-zinc-900/80">
            <div className="flex items-center space-x-1.5" role="tablist" aria-label="Log severity filter">
              {(["ALL", "ERROR", "WARNING", "MILESTONE"] as const).map((sev) => (
                <button
                  type="button"
                  key={sev}
                  role="tab"
                  aria-selected={filterSeverity === sev}
                  onClick={() => setFilterSeverity(sev)}
                  className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors min-h-[26px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                    filterSeverity === sev
                      ? "bg-zinc-800 text-zinc-100 font-semibold border border-zinc-700 shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>

            {/* Search Input & Clear Button */}
            <div className="flex items-center space-x-2">
              <div className="relative w-56">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2" />
                <input
                  type="text"
                  placeholder="Search log messages..."
                  aria-label="Search log messages"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-md pl-8 pr-2.5 py-1 text-xs text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 focus:border-zinc-400 font-mono"
                />
              </div>

              <button
                type="button"
                onClick={handleClearLogs}
                disabled={logs.length === 0}
                title="Clear in-memory session logs"
                aria-label="Clear in-memory session logs"
                className={`min-h-[26px] px-2.5 py-0.5 rounded-md text-[11px] font-mono flex items-center space-x-1.5 transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                  logs.length === 0
                    ? "border-transparent text-zinc-600 cursor-not-allowed"
                    : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:text-white hover:bg-zinc-700"
                }`}
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear</span>
              </button>
            </div>
          </div>

          {/* Logs Stream */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-xs custom-scrollbar bg-zinc-950">
            {filteredLogs.length === 0 ? (
              <div className="text-zinc-400 italic p-4 text-center font-sans">
                No logs matching current filter
              </div>
            ) : (
              filteredLogs.map((entry) => {
                const isError = entry.severity === "ERROR";
                const isWarning = entry.severity === "WARNING";

                return (
                  <div
                    key={entry.id}
                    className={`p-1.5 rounded-md flex items-start justify-between group hover:bg-zinc-900 transition-colors ${
                      isError
                        ? "bg-rose-950/25 text-rose-200 border-l-2 border-rose-500"
                        : isWarning
                        ? "bg-amber-950/25 text-amber-200 border-l-2 border-amber-500"
                        : "bg-zinc-900/70 text-zinc-200 border-l-2 border-cyan-500"
                    }`}
                  >
                    <div className="flex items-start space-x-2 truncate">
                      <span className="text-[10px] text-zinc-400 shrink-0 mt-0.5">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded font-bold shrink-0 ${
                          isError
                            ? "bg-rose-900/60 text-rose-300"
                            : isWarning
                            ? "bg-amber-900/60 text-amber-300"
                            : "bg-cyan-900/60 text-cyan-300"
                        }`}
                      >
                        {entry.severity}
                      </span>
                      <span className="truncate">{entry.message}</span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCopyTrace(entry)}
                      title="Copy error trace"
                      aria-label="Copy error trace"
                      className="opacity-0 group-hover:opacity-100 p-1 text-zinc-400 hover:text-white shrink-0 ml-2 rounded hover:bg-zinc-800 transition-opacity focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer"
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
