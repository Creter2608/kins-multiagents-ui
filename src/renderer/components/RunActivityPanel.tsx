import React, { useState, useMemo } from "react";
import type { SessionEvent } from "../../shared/harnessContracts.js";

export interface RunActivityPanelProps {
  readonly events: readonly SessionEvent[];
  readonly onRefresh?: () => void;
}

export const RunActivityPanel: React.FC<RunActivityPanelProps> = ({ events, onRefresh }) => {
  const [filterSource, setFilterSource] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (filterSource !== "all" && ev.source !== filterSource) {
        return false;
      }
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const text = `${ev.kind} ${ev.source} ${ev.stepId ?? ""} ${JSON.stringify(ev.data)}`.toLowerCase();
        return text.includes(q);
      }
      return true;
    });
  }, [events, filterSource, searchQuery]);

  const selectedEvent = useMemo(() => {
    return events.find((e) => e.sequence === selectedEventSeq) ?? null;
  }, [events, selectedEventSeq]);

  const getSourceBadgeClass = (source: SessionEvent["source"]) => {
    switch (source) {
      case "guard":
        return "bg-rose-950/80 text-rose-300 border-rose-800/80";
      case "tool":
        return "bg-blue-950/80 text-blue-300 border-blue-800/80";
      case "hook":
        return "bg-purple-950/80 text-purple-300 border-purple-800/80";
      case "loop":
        return "bg-emerald-950/80 text-emerald-300 border-emerald-800/80";
      default:
        return "bg-zinc-800 text-zinc-300 border-zinc-700";
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 text-zinc-100 font-sans overflow-hidden select-none">
      {/* Panel Header */}
      <div className="h-10 bg-zinc-900/90 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <span className="font-bold text-xs tracking-wider uppercase text-zinc-200 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400/50" />
            HARNESS ACTIVITY JOURNAL
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono font-medium border border-zinc-700">
            {events.length} Events
          </span>
        </div>

        {/* Filter controls */}
        <div className="flex items-center space-x-2">
          <input
            type="text"
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-2.5 py-1 text-xs bg-zinc-950 border border-zinc-800 rounded text-zinc-200 placeholder-zinc-500 font-mono focus:outline-none focus:border-zinc-600 w-44"
          />
          <div className="flex rounded bg-zinc-900 border border-zinc-800 p-0.5 gap-0.5">
            {["all", "guard", "tool", "hook", "loop"].map((src) => (
              <button
                key={src}
                type="button"
                onClick={() => setFilterSource(src)}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors uppercase font-mono ${
                  filterSource === src
                    ? "bg-zinc-800 text-zinc-100 font-bold border border-zinc-700/60"
                    : "text-zinc-400 hover:text-zinc-200 border border-transparent"
                }`}
              >
                {src}
              </button>
            ))}
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-200 transition-colors"
            >
              Refresh
            </button>
          )}
        </div>
      </div>

      {/* Main Content: Split List and Inspector */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Event Stream */}
        <div className="flex-1 overflow-y-auto divide-y divide-zinc-900 font-mono text-xs">
          {filteredEvents.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-500 italic">
              No journal events recorded for this session.
            </div>
          ) : (
            filteredEvents.map((ev) => (
              <div
                key={ev.sequence}
                onClick={() => setSelectedEventSeq(ev.sequence)}
                className={`px-4 py-2 flex items-center justify-between hover:bg-zinc-900/60 transition-colors cursor-pointer ${
                  selectedEventSeq === ev.sequence ? "bg-zinc-900 border-l-2 border-cyan-400" : ""
                }`}
              >
                <div className="flex items-center space-x-3 truncate">
                  <span className="text-zinc-500 text-[11px] w-8">#{ev.sequence}</span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded border uppercase font-bold tracking-wider ${getSourceBadgeClass(
                      ev.source
                    )}`}
                  >
                    {ev.source}
                  </span>
                  <span className="font-semibold text-zinc-200">{ev.kind}</span>
                  {ev.stepId && (
                    <span className="text-zinc-400 bg-zinc-800/80 px-1.5 py-0.2 rounded text-[11px]">
                      step: {ev.stepId}
                    </span>
                  )}
                  {ev.kind === "tool_blocked" && (
                    <span className="text-rose-400 font-semibold text-[11px]">
                      [BLOCKED: {String(ev.data["reasonCode"] ?? "")}]
                    </span>
                  )}
                </div>

                <span className="text-zinc-500 text-[10px] shrink-0">
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Right: Selected Event Inspector Drawer */}
        <div className="w-96 border-l border-zinc-800 bg-zinc-900/40 p-4 flex flex-col overflow-hidden font-mono text-xs">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
            <span className="text-zinc-400 font-semibold uppercase text-[11px]">Event Inspector</span>
            {selectedEvent && (
              <span className="text-cyan-400 font-bold">Seq #{selectedEvent.sequence}</span>
            )}
          </div>

          {selectedEvent ? (
            <div className="flex-1 overflow-y-auto mt-3 space-y-3">
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase">Kind</span>
                <span className="text-zinc-200 font-bold">{selectedEvent.kind}</span>
              </div>
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase">Source / Run ID</span>
                <span className="text-zinc-300">
                  {selectedEvent.source} (Run: {selectedEvent.runId})
                </span>
              </div>
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase">Timestamp</span>
                <span className="text-zinc-300">{selectedEvent.timestamp}</span>
              </div>
              {selectedEvent.stepId && (
                <div>
                  <span className="text-zinc-500 block text-[10px] uppercase">Step ID</span>
                  <span className="text-zinc-300">{selectedEvent.stepId}</span>
                </div>
              )}
              <div>
                <span className="text-zinc-500 block text-[10px] uppercase">Event Payload Data</span>
                <pre className="mt-1 p-2.5 rounded bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-300 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(selectedEvent.data, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-center italic text-xs">
              Select an event from the stream to view full payload details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
