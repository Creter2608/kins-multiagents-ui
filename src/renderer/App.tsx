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
import { ProjectSelector } from "./components/ProjectSelector.js";

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

const DEFAULT_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const DEFAULT_METRICS = { gpt: DEFAULT_USAGE, gemini: DEFAULT_USAGE, estimatedCostUsd: 0 };

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
  lastUpdated: Date.now(),
  currentSession: DEFAULT_METRICS,
  allTime: DEFAULT_METRICS
};

export const App: React.FC = () => {
  const [loopState, setLoopState] = useState<LoopStateSnapshot>(DEFAULT_LOOP_STATE);
  const [mcpState, setMcpState] = useState<McpSnapshot>(DEFAULT_MCP_STATE);
  const [logs, setLogs] = useState<readonly CriticalLogEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);

  const [bridgeConnected, setBridgeConnected] = useState<boolean>(true);

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api) {
      setBridgeConnected(false);
      return;
    }

    setBridgeConnected(true);

    // 1. Subscribe to live push events first to prevent race conditions
    const unsubLoop = api.loop.onSnapshot((state) => {
      setLoopState(state);
    });
    const unsubMcp = api.mcp.onSnapshot((state) => {
      setMcpState(state);
    });
    const unsubLogs = api.logs.onEntries((entries) => {
      setLogs(entries);
    });
    const unsubTelemetry = api.telemetry.onSnapshot((state) => {
      setTelemetry(state);
    });

    // 2. Fetch initial snapshots independently so one failure does not block the rest
    void api.loop.getSnapshot().then(setLoopState).catch((err) => {
      console.error("[Cockpit] Failed to fetch loop snapshot:", err);
    });
    void api.mcp.getSnapshot().then(setMcpState).catch((err) => {
      console.error("[Cockpit] Failed to fetch MCP snapshot:", err);
    });
    void api.logs.getSnapshot().then((s) => setLogs(s.entries)).catch((err) => {
      console.error("[Cockpit] Failed to fetch logs snapshot:", err);
    });
    void api.telemetry.getSnapshot().then(setTelemetry).catch((err) => {
      console.error("[Cockpit] Failed to fetch telemetry snapshot:", err);
    });

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
      const res = await api.loop.stepBack();
      if (!res.success) {
        alert(res.message);
      }
    }
  };

  const handleStepForward = async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.stepForward();
      if (!res.success) {
        alert(res.message);
      }
    }
  };

  const handleReset = async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.reset();
      if (!res.success) {
        alert(res.message);
      }
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#000000] text-[#e2e8f0] overflow-hidden">
      {/* Top Cockpit Bar */}
      <header className="h-10 bg-[#0c0c0c] border-b border-[#1f1f1f] px-4 flex items-center justify-between select-none shrink-0">
        <div className="flex items-center space-x-2.5">
          <span className="w-2 h-2 rounded-sm bg-emerald-500 shadow-sm shadow-emerald-500/30" />
          <span className="font-bold text-sm tracking-wide text-zinc-100 font-mono">
            KINS COCKPIT
          </span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-[#18181b] text-zinc-400 font-mono font-medium border border-[#27272a]">
            v2.2.0
          </span>
          <ProjectSelector />
        </div>

        <div className="flex items-center space-x-2.5">
          {!bridgeConnected && (
            <span className="text-xs px-2 py-0.5 rounded bg-rose-950/40 text-rose-300 border border-rose-800/60 font-mono font-bold">
              IPC BRIDGE OFFLINE
            </span>
          )}
          <div className="text-xs text-zinc-400 font-mono bg-[#141414] px-3 py-1 rounded border border-[#27272a]">
            Run ID: <span className="text-zinc-200 font-semibold">{loopState.runId}</span>
          </div>
        </div>
      </header>

      {/* Main 3-Column Cockpit Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Autonomous Loop Tracker */}
        <PhaseTracker
          loopState={loopState}
          onRollback={handleRollback}
          onStepForward={handleStepForward}
          onReset={handleReset}
        />

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
