import React from "react";
import type { McpSnapshot } from "../../shared/contracts.js";
import { Server, Wrench, Activity, CheckCircle, Clock } from "lucide-react";

interface McpSidebarProps {
  readonly mcpState: McpSnapshot;
}

export const McpSidebar: React.FC<McpSidebarProps> = ({ mcpState }) => {
  return (
    <aside className="w-72 bg-slate-950/80 border-l border-slate-800/80 flex flex-col h-full text-slate-300 select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-800/60 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Server className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-xs tracking-wider uppercase text-slate-200">
            Active MCP Servers
          </span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono">
          {mcpState.servers.length} Connected
        </span>
      </div>

      {/* MCP Servers List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider px-1">
          Registered Servers
        </div>
        {mcpState.servers.length === 0 ? (
          <div className="text-xs text-slate-500 px-1 italic">No MCP servers detected</div>
        ) : (
          mcpState.servers.map((server) => (
            <div
              key={server.name}
              className="p-2.5 rounded-md bg-slate-900/60 border border-slate-800/60 hover:border-slate-700 transition-colors"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center space-x-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                  <span className="text-xs font-medium text-slate-200 font-mono">
                    {server.name}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono uppercase">
                  {server.source}
                </span>
              </div>

              {server.tools.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-800/40 space-y-1">
                  <div className="text-[10px] text-slate-400 flex items-center space-x-1">
                    <Wrench className="w-3 h-3 text-slate-500" />
                    <span>Tools ({server.tools.length}):</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {server.tools.map((tool) => (
                      <span
                        key={tool}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800 font-mono truncate max-w-full"
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
