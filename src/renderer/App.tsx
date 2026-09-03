import React, { useEffect, useState } from "react";
import type {
  LoopStateSnapshot,
  McpSnapshot,
  CriticalLogEntry,
  TelemetrySnapshot
} from "../shared/contracts.js";
import { LOOP_PHASES, computePhaseStatuses } from "../shared/phases.js";
import { PhaseTracker } from "./components/PhaseTracker.js";
import { TerminalStage } from "./components/TerminalStage.js";
import { McpSidebar } from "./components/McpSidebar.js";
import { CriticalLogDrawer } from "./components/CriticalLogDrawer.js";
import { TelemetryHud } from "./components/TelemetryHud.js";

const DEFAULT_LOOP_STATE: LoopStateSnapshot = {
  runId: "init",
  schemaVersion: 1,
  currentPhase: LOOP_PHASES[0],
  status: "ready",
  usage: { transitions: 0, retries: 0, operations: 0 },
  budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
  phases: computePhaseStatuses(LOOP_PHASES[0]),
  lastUpdated: Date.now()
};

const DEFAULT_MCP_STATE: McpSnapshot = {
  servers: [],
  recentCalls: [],
  lastUpdated: Date.now()
};

const DEFAULT_TELEMETRY: TelemetrySnapshot = {
  gptPromptTokens: null,
  gptCompletionTokens: null,
  gptCacheHitTokens: null,
  gptCacheMissTokens: null,
  gptCacheHitPercentage: null,
  geminiPromptTokens: null,
  geminiCompletionTokens: null,
  geminiCacheStatus: "Unavailable",
  estimatedCostUsd: null,
  budgetLimitUsd: 0.50,
  dockerStatus: "Unavailable",
  lastUpdated: Date.now()
};

export const App: React.FC = () => {
  const [loopState, setLoopState] = useState<LoopStateSnapshot>(DEFAULT_LOOP_STATE);
  const [mcpState, setMcpState] = useState<McpSnapshot>(DEFAULT_MCP_STATE);
  const [logs, setLogs] = useState<readonly CriticalLogEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api) return;

    // Initialize snapshots
    void api.loop.getSnapshot().then(setLoopState);
    void api.mcp.getSnapshot().then(setMcpState);
    void api.logs.getSnapshot().then((s) => setLogs(s.entries));
    void api.telemetry.getSnapshot().then(setTelemetry);

    // Subscribe to live events
    const unsubLoop = api.loop.onSnapshot(setLoopState);
    const unsubMcp = api.mcp.onSnapshot(setMcpState);
    const unsubLogs = api.logs.onEntries(setLogs);
    const unsubTelemetry = api.telemetry.onSnapshot(setTelemetry);

    return () => {
      unsubLoop();
      unsubMcp();
      unsubLogs();
      unsubTelemetry();
    };
  }, []);

  const handleRollback = async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.rollback();
      if (!res.success) {
        alert(res.message);
      }
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#090d16] text-slate-100 overflow-hidden">
      {/* Top Cockpit Bar */}
      <header className="h-8 bg-slate-950 border-b border-slate-800/80 px-4 flex items-center justify-between select-none shrink-0">
        <div className="flex items-center space-x-2">
          <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400/50" />
          <span className="font-semibold text-xs tracking-wider text-slate-200">
            KINS COCKPIT
          </span>
          <span className="text-[10px] text-slate-500 font-mono">v1.0.0</span>
        </div>

        <div className="text-xs text-slate-400 font-mono truncate max-w-sm">
          Run: <span className="text-cyan-300 font-medium">{loopState.runId}</span>
        </div>
      </header>

      {/* Main 3-Column Cockpit Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Autonomous Loop Tracker */}
        <PhaseTracker loopState={loopState} onRollback={handleRollback} />

        {/* Center: Interactive Terminal Stage */}
        <TerminalStage />

        {/* Right: MCP Servers & Tool Activity */}
        <McpSidebar mcpState={mcpState} />
      </div>

      {/* Bottom Area: Collapsible Log Drawer */}
      <CriticalLogDrawer logs={logs} />

      {/* Bottom Area: Telemetry HUD */}
      <TelemetryHud telemetry={telemetry} />
    </div>
  );
};
