import React from "react";
import type { McpSnapshot } from "../../shared/contracts.js";
import { Server, Wrench, Activity, CheckCircle, Clock } from "lucide-react";

interface McpSidebarProps {
  readonly mcpState: McpSnapshot;
}

export const McpSidebar: React.FC<McpSidebarProps> = ({ mcpState }) => {
  return (
    <aside className="w-80 bg-slate-900 border-l border-slate-700 flex flex-col h-full text-slate-200 select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-700 flex items-center justify-between bg-slate-950/40">
        <div className="flex items-center space-x-2">
          <Server className="w-4 h-4 text-emerald-400" />
          <span className="font-bold text-sm tracking-wide uppercase text-white">
            Active MCP Servers
          </span>
        </div>
        <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono font-bold">
          {mcpState.servers.length} Connected
        </span>
      </div>

      {/* MCP Servers List */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3 custom-scrollbar">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1">
          Registered Servers
        </div>
        {mcpState.servers.length === 0 ? (
          <div className="text-xs text-slate-400 px-1 italic">No MCP servers detected</div>
        ) : (
          mcpState.servers.map((server) => (
            <div
              key={server.name}
              className="p-3 rounded-lg bg-slate-950/70 border border-slate-700/80 hover:border-slate-600 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/80 animate-pulse" />
                  <span className="text-sm font-semibold text-white font-mono">
                    {server.name}
                  </span>
                </div>
                <span className="text-xs text-slate-400 font-mono uppercase bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                  {server.source}
                </span>
              </div>

              {server.tools.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-slate-800 space-y-1.5">
                  <div className="text-xs font-medium text-slate-300 flex items-center space-x-1.5">
                    <Wrench className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Tools ({server.tools.length}):</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {server.tools.map((tool) => (
                      <span
                        key={tool}
                        className="text-xs px-2 py-0.5 rounded bg-slate-900 text-cyan-300 border border-slate-700 font-mono truncate max-w-full font-medium"
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
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider px-1 mb-2 flex items-center space-x-1.5">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Recent Tool Calls</span>
          </div>
          {mcpState.recentCalls.length === 0 ? (
            <div className="text-xs text-slate-500 px-1 italic">No tool calls recorded yet</div>
          ) : (
            <div className="space-y-1.5">
              {mcpState.recentCalls.slice(0, 8).map((call) => (
                <div
                  key={call.id}
                  className="p-2 rounded bg-slate-950/60 border border-slate-800/40 text-xs font-mono"
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>{new Date(call.timestamp).toLocaleTimeString()}</span>
                    <span
                      className={`font-semibold ${
                        call.status === "success" ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {call.status}
                    </span>
                  </div>
                  <div className="text-slate-300 truncate mt-0.5">
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
