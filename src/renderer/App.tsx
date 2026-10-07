import React, { useEffect, useState } from "react";
import type {
  LoopStateSnapshot,
  McpSnapshot,
  CriticalLogEntry,
  TelemetrySnapshot,
  EvalHarnessSnapshot,
  SubagentActivity
} from "../shared/contracts.js";
import { LOOP_PHASES, computePhaseStatuses } from "../shared/phases.js";
import { PhaseTracker } from "./components/PhaseTracker.js";
import { TerminalStage } from "./components/TerminalStage.js";
import { McpSidebar } from "./components/McpSidebar.js";
import { SubagentSidebar } from "./components/SubagentSidebar.js";
import { CriticalLogDrawer } from "./components/CriticalLogDrawer.js";
import { TelemetryHud } from "./components/TelemetryHud.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import { EvalScoreboard } from "./components/EvalScoreboard.js";
import "./styles/cockpit.css";

const DEFAULT_LOOP_STATE: LoopStateSnapshot = {
  runId: "init",
  schemaVersion: 1,
  revision: 1,
  currentPhase: LOOP_PHASES[0],
  status: "ready",
  usage: { transitions: 0, retries: 0, operations: 0 },
  budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
  resourceBudget: {
    maxCostMicroUsd: 1_000_000,
    maxTokens: 120_000,
    maxOracleCalls: 2,
    maxGlobalCycles: 2,
    maxVerificationRetries: 1,
    maxQualityRemediations: 1
  },
  resourceUsage: {
    costMicroUsd: 0,
    promptTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    oracleCalls: 0,
    globalCycles: 0,
    verificationRetries: 0,
    qualityRemediations: 0
  },
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
  const [subagents, setSubagents] = useState<readonly SubagentActivity[]>([]);
  const [activeTab, setActiveTab] = useState<"terminal" | "eval">("terminal");
  const [rightSidebarTab, setRightSidebarTab] = useState<"mcp" | "subagents">("mcp");

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
    const unsubSubagents = api.subagents?.onSubagentsChanged?.((activities) => {
      setSubagents(activities);
      if (activities.some((a) => a.status === "running")) {
        setRightSidebarTab("subagents");
      }
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
    void api.subagents?.getSubagents?.().then((activities) => {
      if (activities && activities.length > 0) {
        setSubagents(activities);
      }
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch subagents snapshot:", err);
    });

    return () => {
      unsubLoop();
      unsubMcp();
      unsubLogs();
      unsubTelemetry();
      unsubEval?.();
      unsubSubagents?.();
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

  const activeSubagentsCount = subagents.filter(
    (a) => a.status === "running" || a.status === "idle"
  ).length;

  return (
    <div className="kins-cockpit h-screen w-screen flex flex-col bg-zinc-950 text-zinc-100 font-sans antialiased overflow-hidden select-none">
      {/* Top Cockpit Bar */}
      <header className="h-10 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 px-4 flex items-center justify-between select-none shrink-0 font-sans">
        <div className="flex items-center space-x-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/40 motion-reduce:animate-none" />
          <span className="font-bold text-sm tracking-wide text-zinc-100">
            KINS COCKPIT
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-300 font-mono font-medium border border-zinc-700/60">
            v{__APP_VERSION__}
          </span>
          <ProjectSelector />

          {/* Navigation Tabs */}
          <nav className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 ml-2 gap-0.5" aria-label="Cockpit views">
            <button
              type="button"
              onClick={() => setActiveTab("terminal")}
              aria-current={activeTab === "terminal" ? "page" : undefined}
              className={`px-3 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                activeTab === "terminal"
                  ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              Terminal
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("eval")}
              aria-current={activeTab === "eval" ? "page" : undefined}
              className={`px-3 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                activeTab === "eval"
                  ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>Eval HUD</span>
              {evalSnapshot.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none" />
              )}
              {evalSnapshot.status === "malformed" && (
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              )}
            </button>
          </nav>
        </div>

        <div className="flex items-center space-x-2.5">
          {!bridgeConnected && (
            <span className="text-xs px-2.5 py-0.5 rounded-md bg-rose-950/60 text-rose-300 border border-rose-800/80 font-mono font-bold">
              IPC BRIDGE OFFLINE
            </span>
          )}
          <div className="text-xs text-zinc-300 font-mono bg-zinc-900 px-3 py-1 rounded-md border border-zinc-800">
            Run ID: <span className="text-zinc-100 font-semibold">{loopState.runId}</span>
          </div>
        </div>
      </header>

      {/* Main 3-Column Cockpit Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Autonomous Loop Tracker */}
        <PhaseTracker
          loopState={loopState}
          telemetry={telemetry}
          onRollback={handleRollback}
          onStepForward={handleStepForward}
          onReset={handleReset}
        />

        {/* Center: Interactive Terminal Stage & Eval Scoreboard */}
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "terminal" ? "" : "hidden"}`}>
          <TerminalStage />
        </div>
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "eval" ? "" : "hidden"}`}>
          <EvalScoreboard snapshot={evalSnapshot} loopState={loopState} onRunBenchmark={handleRunBenchmark} />
        </div>

        {/* Right: Tabbed MCP & Subagents Sidebar */}
        <aside className="w-80 bg-zinc-900/60 border-l border-zinc-800 flex flex-col h-full overflow-hidden shrink-0 select-none font-sans">
          <div className="flex items-center bg-zinc-900 border-b border-zinc-800 p-1.5 gap-1.5 shrink-0" role="tablist" aria-label="Sidebar sections">
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarTab === "mcp"}
              onClick={() => setRightSidebarTab("mcp")}
              className={`flex-1 py-1 px-2.5 text-xs font-sans font-medium rounded-md transition-colors min-h-[30px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                rightSidebarTab === "mcp"
                  ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs border border-zinc-700/60"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>MCP Tools</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                {mcpState.servers.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarTab === "subagents"}
              onClick={() => setRightSidebarTab("subagents")}
              className={`flex-1 py-1 px-2.5 text-xs font-sans font-medium rounded-md transition-colors min-h-[30px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                rightSidebarTab === "subagents"
                  ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs border border-zinc-700/60"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>Subagents</span>
              {activeSubagentsCount > 0 ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-950/70 text-blue-300 font-bold border border-blue-700/70 font-mono">
                  {activeSubagentsCount}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                  {subagents.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex-1 overflow-hidden">
            {rightSidebarTab === "mcp" ? (
              <div className="h-full flex flex-col [&>aside]:border-l-0 [&>aside]:w-full">
                <McpSidebar mcpState={mcpState} />
              </div>
            ) : (
              <SubagentSidebar activities={subagents} />
            )}
          </div>
        </aside>
      </div>

      {/* Bottom Area: Collapsible Log Drawer */}
      <CriticalLogDrawer logs={logs} />

      {/* Bottom Area: Telemetry HUD */}
      <TelemetryHud telemetry={telemetry} />
    </div>
  );
};
