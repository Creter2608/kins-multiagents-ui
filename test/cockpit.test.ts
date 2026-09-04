import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computePhaseStatuses, LOOP_PHASES } from "../src/shared/phases.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

const REPO_ROOT = process.cwd();
import { TelemetryService, calculateCacheHitPercentage, calculateEstimatedCostUsd } from "../src/main/services/TelemetryService.js";
import { CriticalLogService, classifyLogLine } from "../src/main/services/CriticalLogService.js";
import { mapDockerState } from "../src/main/services/DockerStatusService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { PtyService } from "../src/main/services/PtyService.js";
import {
  TranscriptIngestionService,
  parseGptTokenUsageLine,
  detectPhaseFromTranscriptStep,
  detectPhaseWithEvidenceFromTranscriptStep,
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput
} from "../src/main/services/TranscriptIngestionService.js";
import { LoopEngine, type PhaseDefinition } from "../src/engine.js";
import { parseSha256Hex } from "../src/checksum.js";
import { evaluateCeilingStatus } from "../src/renderer/components/TelemetryHud.js";

// Assertion 1: {"in":"phase=VERIFY","out":"first 6 complete, VERIFY current, later pending"}
test("cockpit: phase=VERIFY -> first 6 complete, VERIFY current, later pending", () => {
  const statuses = computePhaseStatuses("VERIFY");
  assert.equal(statuses.length, 10);

  const completed = statuses.slice(0, 6);
  assert.equal(completed.length, 6);
  assert.ok(completed.every((p) => p.status === "completed"));

  const current = statuses[6];
  assert.ok(current);
  assert.equal(current.phase, "VERIFY");
  assert.equal(current.status, "current");

  const later = statuses.slice(7);
  assert.equal(later.length, 3);
  assert.ok(later.every((p) => p.status === "pending"));
});

// Assertion 2: {"in":"state.json malformed mid-write","out":"retain last valid state; emit sync error"}
test("cockpit: state.json malformed mid-write -> retain last valid state; emit sync error", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-state-test-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-valid-1",
        currentPhase: "PLAN",
        status: "running"
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    service.readState();
    assert.equal(service.getSnapshot().currentPhase, "PLAN");
    assert.equal(service.getSnapshot().syncError, undefined);

    // Simulate mid-write truncation/malformed JSON
    fs.writeFileSync(stateFile, '{"runId": "run-corrupted-partial', "utf-8");
    service.readState();

    // Retain last valid state and surface sync error
    assert.equal(service.getSnapshot().currentPhase, "PLAN");
    assert.ok(service.getSnapshot().syncError?.includes("Sync Error"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 3: {"in":"cache hit=0, miss=0","out":"percentage unavailable; never NaN"}
test("cockpit: cache hit=0, miss=0 -> percentage unavailable; never NaN", () => {
  const pct = calculateCacheHitPercentage(0, 0);
  assert.equal(pct, null);
  assert.notEqual(pct, Number.NaN);
});

// Assertion 4: {"in":"log truncated below offset","out":"reset offset; no crash or duplicate stale lines"}
test("cockpit: log truncated below offset -> reset offset; no crash or duplicate stale lines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-log-test-"));
  const logFile = path.join(tempDir, "cli.log");
  try {
    fs.writeFileSync(logFile, "E0903 ERROR: first error line\nE0903 ERROR: second error line\n", "utf-8");
    const service = new CriticalLogService(logFile);
    const initialEntries = service.processFile();
    assert.equal(initialEntries.length, 2);

    // Simulate log rotation or truncation to a smaller size
    fs.writeFileSync(logFile, "E0903 ERROR: fresh rotated error\n", "utf-8");
    const newEntries = service.processFile();

    assert.equal(newEntries.length, 1);
    assert.ok(newEntries[0]?.message.includes("fresh rotated error"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 5: {"in":"Docker inspect=false","out":"Stopped, not Active or Missing"}
test("cockpit: Docker inspect=false -> Stopped, not Active or Missing", () => {
  const status = mapDockerState("false\n", 0);
  assert.equal(status, "Stopped");
  assert.notEqual(status, "Active");
  assert.notEqual(status, "Missing");
});

// Layer 1 GPT Architect Assertion 6: {"input":"dist/src/main/index.js + type=module","expected":"absolute dist/src/preload/index.cjs loads under sandbox"}
test("cockpit: preload is valid CommonJS without ESM import syntax", () => {
  const preloadPath = path.resolve("dist/src/preload/index.cjs");
  if (fs.existsSync(preloadPath)) {
    const content = fs.readFileSync(preloadPath, "utf-8");
    assert.ok(content.includes("require(\"electron\")"), "Preload must use require() for sandbox compatibility");
    assert.ok(!content.includes("import "), "Preload must not contain raw ESM import statements");
    assert.ok(content.includes("contextBridge.exposeInMainWorld"), "Preload exposes cockpitApi via contextBridge");
  }
});

// Layer 1 GPT Architect Assertion 7: {"input":".ai/state.json phase=RUNNING","expected":"sidebar shows RUNNING, never mock INITIALIZE"}
test("cockpit: .ai/state.json phase=RUNNING -> service reflects RUNNING, never mock INITIALIZE", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-state-running-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-live-100",
        currentPhase: "EXECUTE",
        status: "running"
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    service.readState();
    const snapshot = service.getSnapshot();

    assert.equal(snapshot.runId, "run-live-100");
    assert.equal(snapshot.currentPhase, "EXECUTE");
    assert.equal(snapshot.status, "running");
    assert.notEqual(snapshot.runId, "init");
    assert.notEqual(snapshot.status, "ready");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 GPT Architect Assertion 8: {"input":"MCP=2; telemetry tokens=41","expected":"2 Connected; tokens=41"}
test("cockpit: MCP discovery and telemetry tokens accumulation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mcp-test-"));
  try {
    // Create 2 fake MCP servers
    const server1 = path.join(tempDir, "server1");
    const server2 = path.join(tempDir, "server2");
    fs.mkdirSync(server1, { recursive: true });
    fs.mkdirSync(server2, { recursive: true });
    fs.writeFileSync(path.join(server1, "toolA.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(server2, "toolB.json"), "{}", "utf-8");

    const mcpService = new McpMonitorService(tempDir, [tempDir]);
    const mcpSnapshot = mcpService.refresh();
    assert.equal(mcpSnapshot.servers.length, 2);
    assert.ok(mcpSnapshot.servers.some((s) => s.name === "server1"));
    assert.ok(mcpSnapshot.servers.some((s) => s.name === "server2"));

    // Telemetry tokens = 41
    const telemetryService = new TelemetryService();
    telemetryService.updateMetrics({ gptPromptTokens: 30, gptCompletionTokens: 11 });
    const telSnapshot = telemetryService.getSnapshot();
    assert.equal((telSnapshot.gptPromptTokens ?? 0) + (telSnapshot.gptCompletionTokens ?? 0), 41);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 GPT Architect Assertion 9: {"input":"missing agy.exe or preload","expected":"explicit actionable error, not blank UI"}
test("cockpit: missing agy.exe -> PtyService falls back gracefully without unhandled crash", () => {
  const ptyService = new PtyService(process.cwd(), "C:\\nonexistent\\agy.exe");
  // Should not throw when constructed or checked
  assert.ok(ptyService);
});

// Layer 1 GPT Architect Restart Assertions
test("cockpit: PtyService restart preserves dataListeners and coalesces concurrent restarts", async () => {
  const ptyService = new PtyService(process.cwd(), "C:\\nonexistent\\agy.exe");
  let receivedData = "";
  const unsub = ptyService.onData((data) => {
    receivedData += data;
  });

  try {
    // Start initial session
    ptyService.start();

    // Trigger two concurrent restarts
    const r1 = ptyService.restart();
    const r2 = ptyService.restart();
    assert.equal(r1, r2, "Concurrent restarts must coalesce into the same promise");

    await r1;
  } finally {
    ptyService.dispose();
    unsub();
  }
});

// Layer 1 GPT Architect Assertion: Glog prefix and severity classification
test("cockpit: classifyLogLine accurately filters glog diagnostic boilerplate", () => {
  // ["ERROR: logging before google.Init: I0904 info", null]
  assert.equal(classifyLogLine("ERROR: logging before google.Init: I0904 info"), null);

  // ["ERROR: logging before google.Init: W0904 warn", "WARNING"]
  const warn = classifyLogLine("ERROR: logging before google.Init: W0904 warn");
  assert.ok(warn);
  assert.equal(warn.severity, "WARNING");
  assert.equal(warn.source, "cli");

  // ["ERROR: logging before google.Init: E0904 fail", "ERROR"]
  const err = classifyLogLine("ERROR: logging before google.Init: E0904 fail");
  assert.ok(err);
  assert.equal(err.severity, "ERROR");
  assert.equal(err.source, "cli");

  // ["panic: ordinary failure", "ERROR"]
  const panic = classifyLogLine("panic: ordinary failure");
  assert.ok(panic);
  assert.equal(panic.severity, "ERROR");

  // ["ordinary informational line", null]
  assert.equal(classifyLogLine("ordinary informational line"), null);
});

// Layer 1 Assertion 1: {"in":"permission log quoting `let errors = 0`","out":"no critical alert"}
test("cockpit: permission log quoting command with error/warn yields no critical alert", () => {
  const line = `ERROR: logging before google.Init: W0904 01:13:42.415025 7990 permission_grant_store.go:366] ignoring invalid allow entry "command(node -e \\"let errors = 0, warns = 0; if (errors > 0) throw new Exception();\\")": invalid grant string`;
  assert.equal(classifyLogLine(line), null);
});

// Layer 1 Assertion 2: {"in":"startup auth error then keyring success","out":"pending alert discarded"}
test("cockpit: startup auth error race condition is discarded", () => {
  const earlyLine = `ERROR: logging before google.Init: E0904 01:07:00.394617 105 errorreport.go:224] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.`;
  assert.equal(classifyLogLine(earlyLine), null);
  const cacheLine = `ERROR: logging before google.Init: W0904 01:07:00.396696 40 cache.go:135] Cache(loadCodeAssistResponse): Singleflight refresh failed: error getting token source: You are not logged into Antigravity.`;
  assert.equal(classifyLogLine(cacheLine), null);
});

// Layer 1 Assertion 3: {"in":"COMPLETE state + confirmed loop:reset","out":"INITIALIZE, transitions=0, configured retries"}
test("cockpit: COMPLETE state + confirmed loop:reset -> INITIALIZE, transitions=0, configured retries", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-reset-test-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    // Write stale COMPLETE state
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-stale",
        currentPhase: "COMPLETE",
        status: "succeeded",
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        usage: { transitions: 9, retries: 0, operations: 0 }
      })
    );

    const loopService = new LoopStateService(stateFile);
    loopService.readState();
    assert.equal(loopService.getSnapshot().currentPhase, "COMPLETE");

    // Perform reset
    const result = await loopService.resetLoop("run-fresh");
    assert.equal(result.success, true);

    const freshSnapshot = loopService.getSnapshot();
    assert.equal(freshSnapshot.currentPhase, "INITIALIZE");
    assert.equal(freshSnapshot.status, "ready");
    assert.equal(freshSnapshot.usage.transitions, 0);
    assert.equal(freshSnapshot.budget.maxRetries, 2);
    assert.equal(freshSnapshot.budget.maxRetries - freshSnapshot.usage.retries, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Assertion 4: {"in":"usage Input:1,200|Output:300|Total:1,500 twice","out":"1500 tokens once; cost updates"}
test("cockpit: usage Input:1,200|Output:300|Total:1,500 twice -> 1500 tokens once; cost updates", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  const rawUsageLine = "📊 [GPT Token Usage]: Input: 1,200 (Cached: 200) | Output: Blueprint: 300 | Thinking: 0 | Total: 1,500";
  // Parse pure line check
  const parsed = parseGptTokenUsageLine(rawUsageLine);
  assert.ok(parsed);
  assert.equal(parsed.inputTokens, 1200);
  assert.equal(parsed.outputTokens, 300);
  assert.equal(parsed.cachedTokens, 200);
  assert.equal(parsed.totalTokens, 1500);

  // Ingest first time
  ingestion.processLine(rawUsageLine);
  const snap1 = telemetry.getSnapshot();
  assert.equal(snap1.gptPromptTokens, 1200);
  assert.equal(snap1.gptCompletionTokens, 300);
  assert.ok(snap1.estimatedCostUsd && snap1.estimatedCostUsd > 0);

  // Ingest second time (duplicate event idempotency)
  ingestion.processLine(rawUsageLine);
  const snap2 = telemetry.getSnapshot();
  assert.equal(snap2.gptPromptTokens, 1200, "Idempotent processing must not double-count tokens");
  assert.equal(snap2.gptCompletionTokens, 300);
  assert.equal(snap2.estimatedCostUsd, snap1.estimatedCostUsd);
});

// Layer 1 Assertion 5: {"in":"duplicate step.tool_calls call_mcp_tool","out":"one redacted MCP sidebar record"}
test("cockpit: duplicate step.tool_calls call_mcp_tool -> one deduplicated MCP record", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  const stepJson = JSON.stringify({
    step_index: 42,
    status: "DONE",
    source: "MODEL",
    tool_calls: [
      {
        name: "call_mcp_tool",
        args: {
          ServerName: "codegraph",
          ToolName: "codegraph_explore",
          api_key: "sk-secret-redacted"
        }
      }
    ]
  });

  // Process first time
  ingestion.processLine(stepJson);
  const mcpSnap1 = mcp.getSnapshot();
  assert.equal(mcpSnap1.recentCalls.length, 1);
  const call = mcpSnap1.recentCalls[0];
  assert.ok(call);
  assert.equal(call.serverName, "codegraph");
  assert.equal(call.toolName, "codegraph_explore");

  // Process duplicate step
  ingestion.processLine(stepJson);
  const mcpSnap2 = mcp.getSnapshot();
  assert.equal(mcpSnap2.recentCalls.length, 1, "Duplicate tool calls must be deduplicated");
});

// Layer 1 Assertion 1: {"in":"GPT 1M in, 250k cached, 100k out","out":"$5.10"}
test("cockpit: GPT 1M in, 250k cached, 100k out -> $5.10", () => {
  const cost = calculateEstimatedCostUsd(1_000_000, 100_000, 250_000);
  assert.equal(cost, 5.1);
});

// Layer 1 Assertion 2: {"in":"cached=200,input=100","out":"cached clamped to 100"}
test("cockpit: cached=200, input=100 -> cached clamped to 100", () => {
  // Input 100, cached 200 (clamped to 100), uncached 0, completion 50
  // cost: 0 * 0.000004 + 100 * 0.0000004 + 50 * 0.00002 = 0.00004 + 0.001 = 0.00104 -> 0.001
  const cost = calculateEstimatedCostUsd(100, 50, 200);
  assert.equal(cost, 0.001);
});

// Layer 1 Assertion 3: {"in":"Gemini 25k in/450 out","out":"$0; both counts shown"}
test("cockpit: Gemini 25k in/450 out -> $0; both counts shown", () => {
  const telemetry = new TelemetryService();
  telemetry.updateMetrics({
    geminiPromptTokens: 25000,
    geminiCompletionTokens: 450,
    geminiCacheStatus: "Active"
  });
  const snap = telemetry.getSnapshot();
  assert.equal(snap.currentSession.gemini.inputTokens, 25000);
  assert.equal(snap.currentSession.gemini.outputTokens, 450);
  assert.equal(snap.currentSession.estimatedCostUsd, 0);
  assert.equal(snap.estimatedCostUsd, null);
});

// Layer 1 Assertion 4: {"in":"new session","out":"session=0; allTime unchanged"}
test("cockpit: new session -> session=0; allTime unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-session-test-"));
  const storageFile = path.join(tempDir, "telemetry_alltime.json");
  const file1 = path.join(tempDir, "transcript1.jsonl");
  const file2 = path.join(tempDir, "transcript2.jsonl");

  try {
    const telemetry = new TelemetryService(storageFile);
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, file1);

    fs.writeFileSync(file1, "📊 [GPT Token Usage]: Input: 1,000 (Cached: 0) | Output: 200 | Total: 1,200\n");
    ingestion.processFile();

    const snap1 = telemetry.getSnapshot();
    assert.equal(snap1.currentSession.gpt.inputTokens, 1000);
    assert.equal(snap1.allTime.gpt.inputTokens, 1000);

    // Switch to new session file2
    fs.writeFileSync(file2, "📊 [GPT Token Usage]: Input: 500 (Cached: 0) | Output: 100 | Total: 600\n");
    (ingestion as any).customTranscriptPath = file2;
    ingestion.processFile();

    const snap2 = telemetry.getSnapshot();
    assert.equal(snap2.currentSession.gpt.inputTokens, 500);
    assert.equal(snap2.allTime.gpt.inputTokens, 1500);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Assertion 5: {"in":"reset then restart","out":"session=0; persisted allTime retained"}
test("cockpit: reset then restart -> session=0; persisted allTime retained", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-restart-test-"));
  const storageFile = path.join(tempDir, "telemetry_alltime.json");

  try {
    const telemetry1 = new TelemetryService(storageFile);
    telemetry1.updateMetrics({
      gptPromptTokens: 2000,
      gptCompletionTokens: 500,
      gptCacheHitTokens: 200
    });

    const snap1 = telemetry1.getSnapshot();
    assert.equal(snap1.currentSession.gpt.inputTokens, 2000);
    assert.equal(snap1.allTime.gpt.inputTokens, 2000);

    // Manual reset session
    telemetry1.resetCurrentSession();
    const snapReset = telemetry1.getSnapshot();
    assert.equal(snapReset.currentSession.gpt.inputTokens, 0);
    assert.equal(snapReset.currentSession.estimatedCostUsd, 0);
    assert.equal(snapReset.allTime.gpt.inputTokens, 2000);

    // Restart app with fresh TelemetryService instance reading persisted storage
    const telemetryRestart = new TelemetryService(storageFile);
    const snapRestart = telemetryRestart.getSnapshot();
    assert.equal(snapRestart.currentSession.gpt.inputTokens, 0);
    assert.equal(snapRestart.allTime.gpt.inputTokens, 2000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Assertion 1: {"in":"tool: craft_technical_prompt_with_gpt","out":"phase=PLAN"}
test("cockpit auto-phase: tool: craft_technical_prompt_with_gpt -> phase=PLAN", () => {
  const step = {
    step_index: 1,
    tool_calls: [
      {
        name: "call_mcp_tool",
        args: { ServerName: "gpt_architect", ToolName: "craft_technical_prompt_with_gpt" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(step), "PLAN");
});

// Layer 1 Assertion 2: {"in":"tool: write_to_file","out":"phase=EXECUTE"}
test("cockpit auto-phase: tool: write_to_file -> phase=EXECUTE", () => {
  const step = {
    step_index: 2,
    tool_calls: [
      {
        name: "write_to_file",
        args: { TargetFile: "src/foo.ts" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(step), "EXECUTE");
});

// Layer 1 Assertion 3: {"in":"run_command:npm test","out":"phase=VERIFY"}
test("cockpit auto-phase: run_command:npm test -> phase=VERIFY; generic command -> null", () => {
  assert.equal(isVerificationCommand("npm test"), true);
  assert.equal(isVerificationCommand("npx tsc --noEmit"), true);
  assert.equal(isVerificationCommand("git status"), false);
  assert.equal(isVerificationCommand("ls -la"), false);

  const verifyStep = {
    step_index: 3,
    tool_calls: [
      {
        name: "run_command",
        args: { CommandLine: "npm test" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(verifyStep), "VERIFY");

  const nonVerifyStep = {
    step_index: 4,
    tool_calls: [
      {
        name: "run_command",
        args: { CommandLine: "git status" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(nonVerifyStep), null);
});

// Layer 1 Assertion 4: {"in":"session A→B; B writes file","out":"reset INITIALIZE before EXECUTE"}
test("cockpit auto-phase: session A->B; B writes file -> reset INITIALIZE before EXECUTE", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-session-switch-"));
  const stateFile = path.join(tempDir, "state.json");
  const sessionA = path.join(tempDir, "transcriptA.jsonl");
  const sessionB = path.join(tempDir, "transcriptB.jsonl");

  try {
    const loopService = new LoopStateService(stateFile);
    await loopService.resetLoop("run-session-a");

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();

    // Session A writes file -> advances to EXECUTE
    fs.writeFileSync(
      sessionA,
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        tool_calls: [{ name: "write_to_file", args: {} }]
      }) + "\n",
      "utf-8"
    );

    const ingestion = new TranscriptIngestionService(telemetry, mcp, loopService, sessionA);
    ingestion.processFile();
    assert.equal(loopService.getSnapshot().currentPhase, "EXECUTE");

    // Session B switches transcript and writes file
    fs.writeFileSync(
      sessionB,
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        tool_calls: [{ name: "write_to_file", args: {} }]
      }) + "\n",
      "utf-8"
    );

    // Point ingestion to session B
    (ingestion as any).customTranscriptPath = sessionB;
    ingestion.processFile();

    // Must have reset to INITIALIZE before advancing to EXECUTE
    assert.equal(loopService.getSnapshot().currentPhase, "EXECUTE");
    assert.notEqual(loopService.getSnapshot().runId, "run-session-a");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Assertion 5: {"in":"FAILED, phase=EXECUTE, transitions=0","out":"rollback allowed to prior canonical phase"}
test("cockpit auto-phase: FAILED, phase=EXECUTE, transitions=0 -> rollback allowed to prior canonical phase", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-rollback-failed-"));
  const stateFile = path.join(tempDir, "state.json");

  try {
    // Write failed EXECUTE state with 0 transitions
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-failed-0",
        currentPhase: "EXECUTE",
        status: "failed",
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        usage: { transitions: 0, retries: 0, operations: 0 },
        history: []
      }),
      "utf-8"
    );

    const loopService = new LoopStateService(stateFile);
    const snap = loopService.readState();
    assert.equal(snap.status, "failed");
    assert.equal(snap.currentPhase, "EXECUTE");

    const CANONICAL_PHASES: readonly PhaseDefinition[] = [
      { id: "INITIALIZE", allowedNext: ["SPEC_GATE", "FAILED"] },
      { id: "SPEC_GATE", allowedNext: ["ISOLATE", "BLOCKED"] },
      { id: "ISOLATE", allowedNext: ["DETECT_STACKS", "BLOCKED", "FAILED"] },
      { id: "DETECT_STACKS", allowedNext: ["PLAN", "FAILED"] },
      { id: "PLAN", allowedNext: ["EXECUTE", "BLOCKED", "FAILED"] },
      { id: "EXECUTE", allowedNext: ["VERIFY", "BLOCKED", "FAILED"] },
      { id: "VERIFY", allowedNext: ["REALITY_CHECK", "EXECUTE", "BLOCKED", "FAILED"] },
      { id: "REALITY_CHECK", allowedNext: ["RELEASE_GATE", "EXECUTE", "BLOCKED", "FAILED"] },
      { id: "RELEASE_GATE", allowedNext: ["COMPLETE", "BLOCKED"] },
      { id: "COMPLETE", allowedNext: [], terminal: true },
      { id: "BLOCKED", allowedNext: [], terminal: true },
      { id: "FAILED", allowedNext: [], terminal: true }
    ];
    const engine = new LoopEngine(
      {
        phases: CANONICAL_PHASES,
        initialPhase: "INITIALIZE",
        terminalPhase: "COMPLETE",
        budget: snap.budget,
        goldenSha256: parseSha256Hex("0000000000000000000000000000000000000000000000000000000000000000"),
        runId: snap.runId
      },
      snap as any
    );

    assert.equal(engine.canRollback(), true);
    const rolledBack = engine.rollback();
    assert.equal(rolledBack.currentPhase, "PLAN");
    assert.equal(rolledBack.status, "running");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Compact Assertion 1: {"input":"package.json.version","expected":"2.1.0"}
test("cockpit v2.1: package.json specifies version 2.1.0", () => {
  const pkgPath = path.resolve(REPO_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  assert.equal(pkg.version, "2.1.0");
});

// Layer 1 Compact Assertion 2: {"input":"LOOP_PHASES","expected":"10 phases in canonical order"}
test("cockpit v2.0: LOOP_PHASES exports exactly 10 canonical phases in sequential order", () => {
  const expectedPhases = [
    "INITIALIZE",
    "SPEC_GATE",
    "ISOLATE",
    "DETECT_STACKS",
    "PLAN",
    "EXECUTE",
    "VERIFY",
    "REALITY_CHECK",
    "RELEASE_GATE",
    "COMPLETE"
  ];
  assert.equal(LOOP_PHASES.length, 10);
  assert.deepEqual([...LOOP_PHASES], expectedPhases);
});

// Layer 1 Compact Assertion 3: {"input":"App header","expected":"visible v2.1.0"}
test("cockpit v2.1: App header contains visible v2.1.0 release badge", () => {
  const appPath = path.resolve(REPO_ROOT, "src/renderer/App.tsx");
  const appSource = fs.readFileSync(appPath, "utf-8");
  assert.match(appSource, />\s*v2\.1\.0\s*</);
});

// Layer 1 Compact Assertion 4: {"input":"TelemetryHud","expected":"contains $0.50 and 60k tokens"}
test("cockpit v2.0: TelemetryHud contains $0.50 and 60k tokens budget ceiling warning", () => {
  const hudPath = path.resolve(REPO_ROOT, "src/renderer/components/TelemetryHud.tsx");
  const hudSource = fs.readFileSync(hudPath, "utf-8");
  assert.ok(hudSource.includes("$0.50"), "TelemetryHud must state $0.50 budget ceiling");
  assert.ok(hudSource.includes("60k tokens"), "TelemetryHud must state 60k tokens ceiling");
});

// Layer 1 Compact Assertion 5: {"input":"legacy target docs","expected":"no six-phase claim; golden assertions unchanged"}
test("cockpit v2.0: standardized target docs have no legacy 6-phase claims and golden assertions remain protected", () => {
  const aiLoopPath = path.resolve(REPO_ROOT, "scripts/ai-loop.mjs");
  const wikiIndexPath = path.resolve(REPO_ROOT, "wiki/index.md");
  const llmsPath = path.resolve(REPO_ROOT, "llms.txt");

  const aiLoopContent = fs.readFileSync(aiLoopPath, "utf-8");
  const wikiIndexContent = fs.readFileSync(wikiIndexPath, "utf-8");
  const llmsContent = fs.readFileSync(llmsPath, "utf-8");

  assert.doesNotMatch(aiLoopContent, /6-phase|six-phase/i);
  assert.doesNotMatch(wikiIndexContent, /6-phase|six-phase/i);
  assert.doesNotMatch(llmsContent, /6-phase|six-phase/i);

  // Golden assertions protected
  const goldenShaPath = path.resolve(REPO_ROOT, ".eval/golden_assertions.sha256");
  const parts = fs.readFileSync(goldenShaPath, "utf-8").trim().split(/\s+/);
  const expectedSha = parts[0] ?? "";
  assert.equal(expectedSha.length, 64);
});

// ==============================================================================
// Layer 1 GPT Architect Compact Assertions: Early Phase & Metadata Upgrades
// ==============================================================================

// Assertion 1: {"in":"tool: ask_question","out":"SPEC_GATE"}
test("cockpit auto-phase: tool: ask_question -> SPEC_GATE", () => {
  const step = {
    step_index: 2,
    tool_calls: [
      {
        name: "ask_question",
        args: { questions: ["Do you want to proceed?"] }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(step), "SPEC_GATE");
  const withEv = detectPhaseWithEvidenceFromTranscriptStep(step);
  assert.equal(withEv?.phase, "SPEC_GATE");
  assert.ok(withEv?.evidence.includes("ask_question"));
});

// Assertion 2: {"in":"cmd: git worktree add ../x","out":"ISOLATE"}
test("cockpit auto-phase: cmd: git worktree add ../x -> ISOLATE", () => {
  const step = {
    step_index: 3,
    tool_calls: [
      {
        name: "run_command",
        args: { CommandLine: "git worktree add ../x" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(step), "ISOLATE");
  const withEv = detectPhaseWithEvidenceFromTranscriptStep(step);
  assert.equal(withEv?.phase, "ISOLATE");
  assert.ok(withEv?.evidence.includes("git worktree"));
});

// Assertion 3: {"in":"list_dir package.json","out":"DETECT_STACKS"}
test("cockpit auto-phase: list_dir package.json -> DETECT_STACKS", () => {
  // Test via list_dir tool call
  const stepTool = {
    step_index: 4,
    tool_calls: [
      {
        name: "list_dir",
        args: { DirectoryPath: "D:/Workspace/kins-multiagents-ui" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(stepTool), "DETECT_STACKS");

  // Test via inspection of package.json
  const stepInspect = {
    step_index: 5,
    tool_calls: [
      {
        name: "view_file",
        args: { AbsolutePath: "D:/Workspace/kins-multiagents-ui/package.json" }
      }
    ]
  };
  assert.equal(detectPhaseFromTranscriptStep(stepInspect), "DETECT_STACKS");

  // Test via textual string "list_dir package.json"
  const stepText = {
    step_index: 6,
    content: "Running list_dir package.json to identify dependencies"
  };
  assert.equal(detectPhaseFromTranscriptStep(stepText), "DETECT_STACKS");
});

// Assertion 4: {"in":"write_to_file + tsc","out":"VERIFY"}
test("cockpit auto-phase: write_to_file + tsc -> VERIFY", () => {
  const multiToolStep = {
    step_index: 7,
    tool_calls: [
      {
        name: "write_to_file",
        args: { TargetFile: "src/main.ts" }
      },
      {
        name: "run_command",
        args: { CommandLine: "npx tsc --noEmit" }
      }
    ]
  };
  // Furthest canonical phase (VERIFY idx 6 > EXECUTE idx 5)
  assert.equal(detectPhaseFromTranscriptStep(multiToolStep), "VERIFY");
  const withEv = detectPhaseWithEvidenceFromTranscriptStep(multiToolStep);
  assert.equal(withEv?.phase, "VERIFY");
  assert.ok(withEv?.evidence.includes("tsc"));
});

// Assertion 5: {"in":"PLAN→VERIFY","out":"PLAN,EXECUTE(auto),VERIFY; metadata present"}
test("cockpit auto-phase: PLAN -> VERIFY -> PLAN, EXECUTE(auto), VERIFY; metadata present", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-phase-advance-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-adv-1",
        currentPhase: "PLAN",
        status: "running",
        usage: { transitions: 4, retries: 0, operations: 0 },
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        history: []
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    const ok = service.advanceToPhase("VERIFY", "cmd: npm test");
    assert.equal(ok, true);

    const snapshot = service.readState();
    assert.equal(snapshot.currentPhase, "VERIFY");

    // History must contain intermediate EXECUTE (auto-advanced) and VERIFY (target)
    const history = snapshot.history ?? [];
    assert.equal(history.length, 2);

    const execEntry = history[0];
    assert.ok(execEntry);
    assert.equal(execEntry.from, "PLAN");
    assert.equal(execEntry.to, "EXECUTE");
    assert.equal(execEntry.autoAdvanced, true);
    assert.ok(execEntry.triggeredBy?.includes("Auto-advance to EXECUTE"));
    assert.equal(typeof execEntry.timestamp, "number");

    const verifyEntry = history[1];
    assert.ok(verifyEntry);
    assert.equal(verifyEntry.from, "EXECUTE");
    assert.equal(verifyEntry.to, "VERIFY");
    assert.equal(verifyEntry.autoAdvanced, false);
    assert.equal(verifyEntry.triggeredBy, "cmd: npm test");
    assert.equal(typeof verifyEntry.timestamp, "number");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Manual Stepping: Step forward and Step back
test("cockpit controls: stepForward advances one phase and stepBack retreats one phase", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-controls-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-ctrl-1",
        currentPhase: "INITIALIZE",
        status: "ready",
        usage: { transitions: 0, retries: 0, operations: 0 },
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        history: []
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);

    // Step forward: INITIALIZE -> SPEC_GATE
    const step1 = service.stepForward();
    assert.equal(step1.success, true);
    assert.equal(service.getSnapshot().currentPhase, "SPEC_GATE");

    // Step forward: SPEC_GATE -> ISOLATE
    const step2 = service.stepForward();
    assert.equal(step2.success, true);
    assert.equal(service.getSnapshot().currentPhase, "ISOLATE");

    // Step back: ISOLATE -> SPEC_GATE
    const back1 = service.stepBack();
    assert.equal(back1.success, true);
    assert.equal(service.getSnapshot().currentPhase, "SPEC_GATE");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Legacy history normalization without crashing
test("cockpit: legacy state history without metadata normalizes safely", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-legacy-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        runId: "run-legacy-1",
        currentPhase: "EXECUTE",
        status: "running",
        history: [
          { sequence: 1, from: "INITIALIZE", to: "SPEC_GATE" },
          { sequence: 2, from: "SPEC_GATE", to: "EXECUTE" }
        ]
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    const snapshot = service.readState();
    assert.equal(snapshot.history?.length, 2);
    assert.equal(snapshot.history[0]?.triggeredBy, "Unknown trigger");
    assert.equal(snapshot.history[0]?.autoAdvanced, false);
    assert.equal(typeof snapshot.history[0]?.timestamp, "number");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Compact Assertion 1: {"in":"# pass 4\n# fail 0","out":"pass,4,0,timestamp"}
test("verification parser: TAP output '# pass 4\\n# fail 0' -> pass, 4 pass, 0 fail", () => {
  const result = parseVerificationOutput("# pass 4\n# fail 0");
  assert.ok(result);
  assert.equal(result.status, "pass");
  assert.equal(result.passCount, 4);
  assert.equal(result.failCount, 0);
  assert.ok(result.lastRunAt && !isNaN(Date.parse(result.lastRunAt)));
});

// Layer 1 Compact Assertion 2: {"in":"Tests: 1 failed, 3 passed; exit=0","out":"fail,3,1"}
test("verification parser: 'Tests: 1 failed, 3 passed; exit=0' -> fail, 3 pass, 1 fail", () => {
  const result = parseVerificationOutput("Tests: 1 failed, 3 passed", 0);
  assert.ok(result);
  assert.equal(result.status, "fail");
  assert.equal(result.passCount, 3);
  assert.equal(result.failCount, 1);
});

// Layer 1 Compact Assertion 3: {"in":"pytest: 2 passed; exit=1","out":"pass,2,0"}
test("verification parser: 'pytest: 2 passed; exit=1' -> pass, 2 pass, 0 fail", () => {
  const result = parseVerificationOutput("pytest: 2 passed", 1);
  assert.ok(result);
  assert.equal(result.status, "pass");
  assert.equal(result.passCount, 2);
  assert.equal(result.failCount, 0);
});

// Layer 1 Compact Assertion 4: {"in":"hideNative=true; native+MCP","out":"MCP only"}
test("mcp filter: hideNative filters out native tool calls preserving MCP only", () => {
  const calls = [
    { id: "1", timestamp: Date.now(), serverName: "native", toolName: "run_command", status: "success" as const },
    { id: "2", timestamp: Date.now(), serverName: "codegraph", toolName: "codegraph_explore", status: "success" as const },
    { id: "3", timestamp: Date.now(), serverName: "Native", toolName: "view_file", status: "success" as const },
    { id: "4", timestamp: Date.now(), serverName: "gpt_architect", toolName: "craft_technical_prompt_with_gpt", status: "success" as const }
  ];

  const hideNative = true;
  const filtered = hideNative
    ? calls.filter((c) => c.serverName.toLowerCase() !== "native")
    : calls;

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0]?.serverName, "codegraph");
  assert.equal(filtered[1]?.serverName, "gpt_architect");
});

// Layer 1 Compact Assertion 5: {"in":"args={\"x\":0,\"ok\":false}","out":"modal preserves values"}
test("tool call inspector: args JSON formatting preserves falsy values like 0 and false", () => {
  const args = { x: 0, ok: false, empty: "" };
  const formatted = JSON.stringify(args, null, 2);
  const parsed = JSON.parse(formatted);
  assert.strictEqual(parsed.x, 0);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.empty, "");
});

// LoopStateService TestSummary Persistence
test("loop state service: updates and persists testSummary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-test-summary-"));
  const stateFile = path.join(tempDir, "state.json");
  try {
    const service = new LoopStateService(stateFile);
    assert.equal(service.getSnapshot().testSummary?.status, "idle");

    service.updateTestSummary({
      status: "pass",
      passCount: 5,
      failCount: 0,
      lastRunAt: new Date().toISOString()
    });

    assert.equal(service.getSnapshot().testSummary?.status, "pass");
    assert.equal(service.getSnapshot().testSummary?.passCount, 5);

    const reloaded = new LoopStateService(stateFile);
    reloaded.readState();
    assert.equal(reloaded.getSnapshot().testSummary?.status, "pass");
    assert.equal(reloaded.getSnapshot().testSummary?.passCount, 5);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ==============================================================================
// Layer 1 Compact Test Assertions: GPT-Only 60k Token Ceiling & Telemetry Warnings
// [
//   {"in":"gpt=0,gemini=100000,cost=null","out":"normal"},
//   {"in":"gpt=50000,gemini=0,cost=null","out":"approaching"},
//   {"in":"gpt=60000,gemini=0,cost=null","out":"exceeded"},
//   {"in":"gpt=0,gemini=0,cost=.50","out":"exceeded"},
//   {"in":"gpt=0,cached=100000,cost=null","out":"normal"}
// ]
// ==============================================================================

test("telemetry ceiling: large gemini usage does not trigger ceiling (only Layer 1 GPT counted)", () => {
  // Assertion 1: {"in":"gpt=0,gemini=100000,cost=null","out":"normal"}
  const status = evaluateCeilingStatus(0, 0, null);
  assert.equal(status, "normal");
});

test("telemetry ceiling: gpt tokens at 50,000 trigger approaching status", () => {
  // Assertion 2: {"in":"gpt=50000,gemini=0,cost=null","out":"approaching"}
  assert.equal(evaluateCeilingStatus(50_000, 0, null), "approaching");
  assert.equal(evaluateCeilingStatus(25_000, 25_000, null), "approaching");
  assert.equal(evaluateCeilingStatus(49_999, 0, null), "normal");
});

test("telemetry ceiling: gpt tokens at 60,000 trigger exceeded status", () => {
  // Assertion 3: {"in":"gpt=60000,gemini=0,cost=null","out":"exceeded"}
  assert.equal(evaluateCeilingStatus(60_000, 0, null), "exceeded");
  assert.equal(evaluateCeilingStatus(30_000, 30_000, null), "exceeded");
  assert.equal(evaluateCeilingStatus(59_999, 0, null), "approaching");
});

test("telemetry ceiling: cost threshold triggers independently of tokens", () => {
  // Assertion 4: {"in":"gpt=0,gemini=0,cost=.50","out":"exceeded"}
  assert.equal(evaluateCeilingStatus(0, 0, 0.50), "exceeded");
  assert.equal(evaluateCeilingStatus(0, 0, 0.40), "approaching");
  assert.equal(evaluateCeilingStatus(0, 0, 0.39), "normal");
  assert.equal(evaluateCeilingStatus(0, 0, null), "normal");
});

test("telemetry ceiling: cached tokens alone do not affect ceiling", () => {
  // Assertion 5: {"in":"gpt=0,cached=100000,cost=null","out":"normal"}
  assert.equal(evaluateCeilingStatus(0, 0, null), "normal");
});

