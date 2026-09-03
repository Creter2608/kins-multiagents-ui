import React from "react";
import type { McpSnapshot } from "../../shared/contracts.js";
import { Server, Wrench, Activity, CheckCircle, Clock } from "lucide-react";

interface McpSidebarProps {
  readonly mcpState: McpSnapshot;
}

export const McpSidebar: React.FC<McpSidebarProps> = ({ mcpState }) => {
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
          <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider px-1 mb-2 flex items-center space-x-1.5">
            <Activity className="w-3.5 h-3.5 text-zinc-400" />
            <span>Recent Tool Calls</span>
          </div>
          {mcpState.recentCalls.length === 0 ? (
            <div className="text-xs text-zinc-600 px-1 italic">No tool calls recorded yet</div>
          ) : (
            <div className="space-y-1.5">
              {mcpState.recentCalls.slice(0, 8).map((call) => (
                <div
                  key={call.id}
                  className="p-2 rounded bg-[#141414] border border-[#27272a] text-xs font-mono"
                >
                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span>{new Date(call.timestamp).toLocaleTimeString()}</span>
                    <span
                      className={`font-semibold ${
                        call.status === "success" ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {call.status}
                    </span>
                  </div>
                  <div className="text-zinc-300 truncate mt-0.5">
                    {call.serverName} / {call.toolName}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
