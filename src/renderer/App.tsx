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
    <div className="h-screen w-screen flex flex-col bg-[#0b101b] text-slate-100 overflow-hidden">
      {/* Top Cockpit Bar */}
      <header className="h-10 bg-slate-900 border-b border-slate-700 px-4 flex items-center justify-between select-none shrink-0">
        <div className="flex items-center space-x-2.5">
          <span className="w-3 h-3 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400/80 animate-pulse" />
          <span className="font-bold text-sm tracking-wide text-white">
            KINS COCKPIT
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono font-medium border border-slate-700">
            v1.0.0
          </span>
        </div>

        <div className="text-xs text-slate-200 font-mono bg-slate-950/80 px-3 py-1 rounded border border-slate-800">
          Run ID: <span className="text-cyan-400 font-semibold">{loopState.runId}</span>
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
