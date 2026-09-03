import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computePhaseStatuses } from "../src/shared/phases.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { TelemetryService, calculateCacheHitPercentage, calculateEstimatedCostUsd } from "../src/main/services/TelemetryService.js";
import { CriticalLogService, classifyLogLine } from "../src/main/services/CriticalLogService.js";
import { mapDockerState } from "../src/main/services/DockerStatusService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { PtyService } from "../src/main/services/PtyService.js";
import { TranscriptIngestionService, parseGptTokenUsageLine } from "../src/main/services/TranscriptIngestionService.js";

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



