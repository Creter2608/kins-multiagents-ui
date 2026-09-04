import React, { useState, useEffect } from "react";
import type { McpSnapshot, ToolCallRecord } from "../../shared/contracts.js";
import { Server, Wrench, Activity, X } from "lucide-react";

interface McpSidebarProps {
  readonly mcpState: McpSnapshot;
}

export const McpSidebar: React.FC<McpSidebarProps> = ({ mcpState }) => {
  const [hideNative, setHideNative] = useState<boolean>(false);
  const [selectedCall, setSelectedCall] = useState<ToolCallRecord | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedCall(null);
      }
    };
    if (selectedCall) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCall]);

  const filteredCalls = hideNative
    ? mcpState.recentCalls.filter((call) => call.serverName.toLowerCase() !== "native")
    : mcpState.recentCalls;

  return (
    <aside className="w-80 bg-[#0c0c0c] border-l border-[#1f1f1f] flex flex-col h-full text-zinc-300 select-none font-mono">
      {/* Header */}
      <div className="p-3.5 border-b border-[#1f1f1f] flex items-center justify-between bg-[#0c0c0c]">
        <div className="flex items-center space-x-2">
          <Server className="w-4 h-4 text-emerald-500" />
          <span className="font-bold text-sm tracking-wide uppercase text-zinc-100">
            Active MCP Servers
          </span>
        </div>
        <span className="text-xs px-2.5 py-0.5 rounded bg-emerald-950/30 text-emerald-400 border border-emerald-800/50 font-mono font-medium">
          {mcpState.servers.length} Connected
        </span>
      </div>

      {/* MCP Servers List */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3 custom-scrollbar">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">
          Registered Servers
        </div>
        {mcpState.servers.length === 0 ? (
          <div className="text-xs text-zinc-500 px-1 italic">No MCP servers detected</div>
        ) : (
          mcpState.servers.map((server) => (
            <div
              key={server.name}
              className="p-3 rounded bg-[#141414] border border-[#27272a] hover:border-zinc-700 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <span className="w-2 h-2 rounded-sm bg-emerald-500" />
                  <span className="text-sm font-semibold text-zinc-100 font-mono">
                    {server.name}
                  </span>
                </div>
                <span className="text-xs text-zinc-400 font-mono uppercase bg-[#18181b] px-1.5 py-0.5 rounded border border-[#27272a]">
                  {server.source}
                </span>
              </div>

              {server.tools.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-[#1f1f1f] space-y-1.5">
                  <div className="text-xs font-medium text-zinc-400 flex items-center space-x-1.5">
                    <Wrench className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Tools ({server.tools.length}):</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {server.tools.map((tool) => (
                      <span
                        key={tool}
                        className="text-xs px-2 py-0.5 rounded bg-[#18181b] text-zinc-300 border border-[#27272a] font-mono truncate max-w-full font-medium"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}

        {/* Recent Tool Call Feed */}
        <div className="pt-2">
          <div className="flex items-center justify-between px-1 mb-2">
            <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center space-x-1.5">
              <Activity className="w-3.5 h-3.5 text-zinc-400" />
              <span>Recent Tool Calls</span>
            </div>
            <button
              type="button"
              onClick={() => setHideNative((prev) => !prev)}
              className={`text-[10px] px-2 py-0.5 rounded font-mono transition-colors border cursor-pointer ${
                hideNative
                  ? "bg-emerald-950/50 text-emerald-400 border-emerald-800/70 font-semibold"
                  : "bg-[#141414] text-zinc-400 border-[#27272a] hover:text-zinc-200"
              }`}
              title={hideNative ? "Showing MCP tools only. Click to show all." : "Click to hide native tool calls."}
            >
              {hideNative ? "MCP Only" : "All Calls"}
            </button>
          </div>
          {filteredCalls.length === 0 ? (
            <div className="text-xs text-zinc-600 px-1 italic">
              {hideNative ? "No MCP tool calls recorded" : "No tool calls recorded yet"}
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredCalls.slice(0, 8).map((call) => (
                <button
                  type="button"
                  key={call.id}
                  onClick={() => setSelectedCall(call)}
                  className="w-full text-left p-2 rounded bg-[#141414] hover:bg-[#18181c] border border-[#27272a] hover:border-zinc-600 transition-colors text-xs font-mono group cursor-pointer"
                >
                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span>{new Date(call.timestamp).toLocaleTimeString()}</span>
                    <span
                      className={`font-semibold uppercase ${
                        call.status === "success"
                          ? "text-emerald-400"
                          : call.status === "error"
                          ? "text-rose-400"
                          : "text-amber-400"
                      }`}
                    >
                      {call.status}
                    </span>
                  </div>
                  <div className="text-zinc-300 truncate mt-0.5 group-hover:text-emerald-300 transition-colors flex items-center justify-between">
                    <span className="truncate">
                      {call.serverName} / {call.toolName}
                    </span>
                    <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400 shrink-0 ml-1">
                      inspect →
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tool Call Details Modal */}
      {selectedCall && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tool-call-inspector-title"
          onClick={() => setSelectedCall(null)}
        >
          <div
            className="bg-[#111114] border border-[#2e2e34] rounded-lg shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col font-mono text-zinc-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-3.5 border-b border-[#27272a] bg-[#0c0c0c] flex items-center justify-between">
              <div className="flex items-center space-x-2 truncate pr-2">
                <Wrench className="w-4 h-4 text-emerald-400 shrink-0" />
                <span id="tool-call-inspector-title" className="font-bold text-sm text-zinc-100 truncate">
                  {selectedCall.serverName} / {selectedCall.toolName}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCall(null)}
                className="text-zinc-400 hover:text-zinc-100 p-1 rounded hover:bg-[#1a1a1a] transition-colors cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-3 overflow-y-auto flex-1 custom-scrollbar text-xs">
              {/* Metadata Badges */}
              <div className="grid grid-cols-2 gap-2 bg-[#161619] p-2.5 rounded border border-[#27272a]">
                <div>
                  <span className="text-zinc-500 text-[10px] uppercase block">Status</span>
                  <span
                    className={`font-semibold uppercase text-xs ${
                      selectedCall.status === "success"
                        ? "text-emerald-400"
                        : selectedCall.status === "error"
                        ? "text-rose-400"
                        : "text-amber-400"
                    }`}
                  >
                    {selectedCall.status}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 text-[10px] uppercase block">Timestamp</span>
                  <span className="text-zinc-300 text-xs">
                    {new Date(selectedCall.timestamp).toLocaleString()}
                  </span>
                </div>
                {typeof selectedCall.durationMs === "number" && (
                  <div>
                    <span className="text-zinc-500 text-[10px] uppercase block">Duration</span>
                    <span className="text-zinc-300 text-xs">{selectedCall.durationMs} ms</span>
                  </div>
                )}
                <div>
                  <span className="text-zinc-500 text-[10px] uppercase block">Server</span>
                  <span className="text-zinc-300 text-xs">{selectedCall.serverName}</span>
                </div>
              </div>

              {/* Error Output if present */}
              {selectedCall.error && (
                <div className="p-2.5 rounded bg-rose-950/30 border border-rose-800/50 text-rose-300 text-xs">
                  <span className="font-semibold block mb-1">Error:</span>
                  <pre className="whitespace-pre-wrap font-mono text-[11px]">{selectedCall.error}</pre>
                </div>
              )}

              {/* Arguments Payload */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  Arguments Payload
                </div>
                <div className="bg-[#09090b] p-3 rounded border border-[#27272a] overflow-x-auto max-h-60 custom-scrollbar">
                  {selectedCall.args !== undefined && selectedCall.args !== null ? (
                    <pre className="text-[11px] text-emerald-300 whitespace-pre-wrap leading-relaxed">
                      {typeof selectedCall.args === "object"
                        ? JSON.stringify(selectedCall.args, null, 2)
                        : String(selectedCall.args)}
                    </pre>
                  ) : (
                    <span className="text-zinc-500 italic text-[11px]">No arguments captured</span>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[#27272a] bg-[#0c0c0c] flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedCall(null)}
                className="px-3 py-1.5 rounded bg-[#1f1f23] hover:bg-[#27272c] text-zinc-300 text-xs font-semibold border border-[#333339] transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
