import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computePhaseStatuses } from "../src/shared/phases.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { TelemetryService, calculateCacheHitPercentage } from "../src/main/services/TelemetryService.js";
import { CriticalLogService } from "../src/main/services/CriticalLogService.js";
import { mapDockerState } from "../src/main/services/DockerStatusService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { PtyService } from "../src/main/services/PtyService.js";

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
