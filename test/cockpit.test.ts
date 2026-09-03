import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computePhaseStatuses } from "../src/shared/phases.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { calculateCacheHitPercentage } from "../src/main/services/TelemetryService.js";
import { CriticalLogService } from "../src/main/services/CriticalLogService.js";
import { mapDockerState } from "../src/main/services/DockerStatusService.js";

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
