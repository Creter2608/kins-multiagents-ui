import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EvalHarnessService } from "../src/main/services/EvalHarnessService.js";
import type { EvaluationReport } from "../src/shared/harness.js";
import type { EvalHarnessSnapshot } from "../src/shared/contracts.js";

function createTempProject(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-harness-svc-test-"));
  fs.mkdirSync(path.join(tmp, ".ai", "reports"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "scripts", "harness"), { recursive: true });
  return tmp;
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures on Windows locks
  }
}

const SAMPLE_VALID_REPORT: EvaluationReport = {
  schemaVersion: 1,
  baseCommit: "abc1234",
  passed: true,
  metrics: {
    passAt1: 1.0,
    passAtK: 1.0,
    ssi: 1.0,
    k: 1
  },
  violations: [],
  results: [
    {
      id: "task-001",
      kind: "f2p",
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    },
    {
      id: "task-002",
      kind: "p2p",
      base: { exitCode: 0, passed: true, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    }
  ]
};

test("EvalHarnessService: initializes with idle state when report does not exist", async () => {
  const tempDir = createTempProject();
  const service = new EvalHarnessService(tempDir);

  try {
    await service.start();
    const snapshot = service.getSnapshot();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.report, null);
    assert.equal(snapshot.error, null);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: reads existing valid report on startup and transitions to ready", async () => {
  const tempDir = createTempProject();
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(SAMPLE_VALID_REPORT, null, 2), "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    const snapshot = service.getSnapshot();
    assert.equal(snapshot.status, "ready");
    assert.ok(snapshot.report);
    assert.equal(snapshot.report?.schemaVersion, 1);
    assert.equal(snapshot.report?.metrics.passAt1, 1.0);
    assert.equal(snapshot.report?.metrics.ssi, 1.0);
    assert.equal(snapshot.error, null);
    assert.ok(snapshot.updatedAt);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: handles malformed JSON without crashing and preserves prior valid report", async () => {
  const tempDir = createTempProject();
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(SAMPLE_VALID_REPORT), "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    assert.equal(service.getSnapshot().status, "ready");

    // Write malformed JSON
    fs.writeFileSync(reportPath, "{ invalid json corrupt content ...", "utf-8");
    service.readReport();

    const malformedSnap = service.getSnapshot();
    assert.equal(malformedSnap.status, "malformed");
    assert.ok(malformedSnap.error?.includes("Malformed report JSON"));
    // Crucial anti-crash invariant: preserves prior valid report in memory
    assert.ok(malformedSnap.report !== null);
    assert.equal(malformedSnap.report?.schemaVersion, 1);

    // Recover with valid report
    const updatedReport: EvaluationReport = {
      ...SAMPLE_VALID_REPORT,
      passed: false,
      metrics: {
        ...SAMPLE_VALID_REPORT.metrics,
        passAt1: 0.5,
        passAtK: 0.5,
        ssi: 0.5
      },
      results: [
        SAMPLE_VALID_REPORT.results[0]!,
        {
          id: "task-002",
          kind: "p2p",
          base: { exitCode: 0, passed: true, signal: null, timedOut: false },
          current: { exitCode: 1, passed: false, signal: null, timedOut: false },
          passed: false
        }
      ]
    };
    fs.writeFileSync(reportPath, JSON.stringify(updatedReport), "utf-8");
    service.readReport();

    const recoveredSnap = service.getSnapshot();
    assert.equal(recoveredSnap.status, "ready");
    assert.equal(recoveredSnap.error, null);
    assert.equal(recoveredSnap.report?.metrics.passAt1, 0.5);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: rejects schema-invalid report and flags as malformed", async () => {
  const tempDir = createTempProject();
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");
  // Missing metrics.passAt1 and results array
  fs.writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, baseCommit: "abc" }), "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    const snap = service.getSnapshot();
    assert.equal(snap.status, "malformed");
    assert.ok(snap.error?.includes("schema validation"));
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: onSnapshot notifies subscriber on updates", async () => {
  const tempDir = createTempProject();
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");

  const service = new EvalHarnessService(tempDir);
  const snapshots: EvalHarnessSnapshot[] = [];
  const unsubscribe = service.onSnapshot((s) => {
    snapshots.push(s);
  });

  try {
    await service.start();
    fs.writeFileSync(reportPath, JSON.stringify(SAMPLE_VALID_REPORT), "utf-8");
    service.readReport();

    assert.ok(snapshots.length >= 1);
    const last = snapshots[snapshots.length - 1];
    assert.equal(last?.status, "ready");
    assert.equal(last?.report?.results.length, 2);

    unsubscribe();
    // After unsubscribe, further updates do not push to listener
    fs.writeFileSync(reportPath, JSON.stringify({ ...SAMPLE_VALID_REPORT, results: [] }), "utf-8");
    service.readReport();
    assert.equal(snapshots[snapshots.length - 1]?.report?.results.length, 2);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: runBenchmark executes runner script and returns updated snapshot", async () => {
  const tempDir = createTempProject();
  const runnerPath = path.join(tempDir, "scripts", "harness", "runner.mjs");
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");

  // Create a minimal mock runner script that writes the sample report to --output
  const mockRunnerCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
const outIdx = args.indexOf("--output");
const outPath = outIdx !== -1 ? args[outIdx + 1] : ".ai/reports/eval-report.json";

const report = ${JSON.stringify(SAMPLE_VALID_REPORT)};
fs.mkdirSync(outPath.substring(0, Math.max(outPath.lastIndexOf("/"), outPath.lastIndexOf("\\\\"))), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
process.exit(0);
`;
  fs.writeFileSync(runnerPath, mockRunnerCode, "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    assert.equal(service.getSnapshot().status, "idle");

    const finalSnap = await service.runBenchmark();
    assert.equal(finalSnap.status, "ready");
    assert.ok(finalSnap.report);
    assert.equal(finalSnap.report?.results.length, 2);
    assert.equal(finalSnap.error, null);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: runBenchmark handles missing runner script gracefully", async () => {
  const tempDir = createTempProject();
  // Do not create runner script
  const service = new EvalHarnessService(tempDir);

  try {
    await service.start();
    await assert.rejects(async () => {
      await service.runBenchmark();
    }, /Harness runner script not found/);

    const snap = service.getSnapshot();
    assert.equal(snap.status, "failed");
    assert.ok(snap.error?.includes("runner script not found"));
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: concurrent runBenchmark calls deduplicate into single execution", async () => {
  const tempDir = createTempProject();
  const runnerPath = path.join(tempDir, "scripts", "harness", "runner.mjs");

  // Mock runner that sleeps 50ms before writing report
  const mockRunnerCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
const outIdx = args.indexOf("--output");
const outPath = outIdx !== -1 ? args[outIdx + 1] : ".ai/reports/eval-report.json";

setTimeout(() => {
  const report = ${JSON.stringify(SAMPLE_VALID_REPORT)};
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  process.exit(0);
}, 50);
`;
  fs.writeFileSync(runnerPath, mockRunnerCode, "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();

    // Call runBenchmark twice concurrently
    const [snap1, snap2] = await Promise.all([
      service.runBenchmark(),
      service.runBenchmark()
    ]);

    assert.equal(snap1.status, "ready");
    assert.equal(snap2.status, "ready");
    assert.deepEqual(snap1.report, snap2.report);
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: runBenchmark passes --base HEAD by default and clears stale report before execution", async () => {
  const tempDir = createTempProject();
  const runnerPath = path.join(tempDir, "scripts", "harness", "runner.mjs");
  const reportPath = path.join(tempDir, ".ai", "reports", "eval-report.json");
  const recordedArgsPath = path.join(tempDir, "recorded_args.json");

  // Pre-seed a stale report
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, baseCommit: "stale", passed: false }), "utf-8");

  // Mock runner that captures args and writes valid report
  const mockRunnerCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordedArgsPath)}, JSON.stringify(args), "utf-8");
const outIdx = args.indexOf("--output");
const outPath = outIdx !== -1 ? args[outIdx + 1] : ".ai/reports/eval-report.json";
const report = ${JSON.stringify(SAMPLE_VALID_REPORT)};
fs.mkdirSync(outPath.substring(0, Math.max(outPath.lastIndexOf("/"), outPath.lastIndexOf("\\\\"))), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
process.exit(0);
`;
  fs.writeFileSync(runnerPath, mockRunnerCode, "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    const finalSnap = await service.runBenchmark();
    assert.equal(finalSnap.status, "ready");

    const recordedArgs = JSON.parse(fs.readFileSync(recordedArgsPath, "utf-8"));
    const baseIdx = recordedArgs.indexOf("--base");
    assert.notEqual(baseIdx, -1);
    assert.equal(recordedArgs[baseIdx + 1], "HEAD");
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});

test("EvalHarnessService: runBenchmark passes customBaseCommit when provided", async () => {
  const tempDir = createTempProject();
  const runnerPath = path.join(tempDir, "scripts", "harness", "runner.mjs");
  const recordedArgsPath = path.join(tempDir, "recorded_args_custom.json");

  const mockRunnerCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordedArgsPath)}, JSON.stringify(args), "utf-8");
const outIdx = args.indexOf("--output");
const outPath = outIdx !== -1 ? args[outIdx + 1] : ".ai/reports/eval-report.json";
const report = ${JSON.stringify(SAMPLE_VALID_REPORT)};
fs.mkdirSync(outPath.substring(0, Math.max(outPath.lastIndexOf("/"), outPath.lastIndexOf("\\\\"))), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
process.exit(0);
`;
  fs.writeFileSync(runnerPath, mockRunnerCode, "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    const finalSnap = await service.runBenchmark("release-base-v2");
    assert.equal(finalSnap.status, "ready");

    const recordedArgs = JSON.parse(fs.readFileSync(recordedArgsPath, "utf-8"));
    const baseIdx = recordedArgs.indexOf("--base");
    assert.notEqual(baseIdx, -1);
    assert.equal(recordedArgs[baseIdx + 1], "release-base-v2");
  } finally {
    await service.dispose();
    cleanupTempDir(tempDir);
  }
});
