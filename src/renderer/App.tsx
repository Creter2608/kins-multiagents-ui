import React, { useEffect, useState } from "react";
import type {
  LoopStateSnapshot,
  McpSnapshot,
  CriticalLogEntry,
  TelemetrySnapshot,
  EvalHarnessSnapshot
} from "../shared/contracts.js";
import { LOOP_PHASES, computePhaseStatuses } from "../shared/phases.js";
import { PhaseTracker } from "./components/PhaseTracker.js";
import { TerminalStage } from "./components/TerminalStage.js";
import { McpSidebar } from "./components/McpSidebar.js";
import { CriticalLogDrawer } from "./components/CriticalLogDrawer.js";
import { TelemetryHud } from "./components/TelemetryHud.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import { EvalScoreboard } from "./components/EvalScoreboard.js";

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

const DEFAULT_EVAL_STATE: EvalHarnessSnapshot = {
  status: "idle",
  report: null,
  updatedAt: null,
  error: null
};

export const App: React.FC = () => {
  const [loopState, setLoopState] = useState<LoopStateSnapshot>(DEFAULT_LOOP_STATE);
  const [mcpState, setMcpState] = useState<McpSnapshot>(DEFAULT_MCP_STATE);
  const [logs, setLogs] = useState<readonly CriticalLogEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);
  const [evalSnapshot, setEvalSnapshot] = useState<EvalHarnessSnapshot>(DEFAULT_EVAL_STATE);
  const [activeTab, setActiveTab] = useState<"terminal" | "eval">("terminal");

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
    const unsubEval = api.eval?.onSnapshot?.((state) => {
      setEvalSnapshot(state);
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
    void api.eval?.getSnapshot?.().then((snap) => {
      if (snap) setEvalSnapshot(snap);
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch eval snapshot:", err);
    });

    return () => {
      unsubLoop();
      unsubMcp();
      unsubLogs();
      unsubTelemetry();
      unsubEval?.();
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

  const handleRunBenchmark = async () => {
    const api = window.cockpitApi;
    if (api?.eval) {
      try {
        const snap = await api.eval.runBenchmark();
        setEvalSnapshot(snap);
      } catch (err: unknown) {
        console.error("[Cockpit] Benchmark run failed:", err);
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

          {/* Navigation Tabs */}
          <div className="flex items-center bg-[#141414] rounded p-0.5 border border-[#27272a] ml-2">
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors ${
                activeTab === "terminal"
                  ? "bg-[#27272a] text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Terminal
            </button>
            <button
              onClick={() => setActiveTab("eval")}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors flex items-center gap-1.5 ${
                activeTab === "eval"
                  ? "bg-[#27272a] text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <span>Eval HUD</span>
              {evalSnapshot.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              )}
              {evalSnapshot.status === "malformed" && (
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              )}
            </button>
          </div>
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

        {/* Center: Interactive Terminal Stage & Eval Scoreboard */}
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "terminal" ? "" : "hidden"}`}>
          <TerminalStage />
        </div>
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "eval" ? "" : "hidden"}`}>
          <EvalScoreboard snapshot={evalSnapshot} onRunBenchmark={handleRunBenchmark} />
        </div>

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
