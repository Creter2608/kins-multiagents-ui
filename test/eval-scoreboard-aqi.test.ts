import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EvalHarnessService } from "../src/main/services/EvalHarnessService.js";
import type { EvaluationReport, ArchitecturalCompliance } from "../src/shared/harness.js";

const REPO_ROOT = process.cwd();
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "runner.mjs")).href;
const { computeMetrics } = await import(RUNNER_URL) as typeof import("../scripts/harness/runner.d.mts");

test("harness: computeMetrics populates dei and costMicroUsd with deterministic defaults", () => {
  const results = [
    {
      id: "task-001",
      kind: "f2p" as const,
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    }
  ];

  const defaultMetrics = computeMetrics(results);
  assert.equal(defaultMetrics.passAt1, 1);
  assert.equal(defaultMetrics.ssi, 1);
  assert.equal(defaultMetrics.dei, 1.0);
  assert.equal(defaultMetrics.costMicroUsd, 0);

  const customMetrics = computeMetrics(results, { dei: 0.92, costMicroUsd: 125 });
  assert.equal(customMetrics.dei, 0.92);
  assert.equal(customMetrics.costMicroUsd, 125);
});

test("harness: cost normalization from USD to micro-USD", () => {
  const costUsd = 0.000125;
  const costMicroUsd = Math.round(costUsd * 1_000_000);
  assert.equal(costMicroUsd, 125);
});

test("EvalHarnessService: handles report with architecturalCompliance and DEI telemetry", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-aqi-test-"));
  const reportDir = path.join(tempDir, ".ai", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(path.join(tempDir, "scripts", "harness"), { recursive: true });

  const mockCompliance: ArchitecturalCompliance = {
    aqi: 4.74,
    passed: true,
    criteriaScores: {
      surgicalDiff: 5.0,
      simplicity: 4.5,
      modularity: 5.0,
      maintainability: 4.5
    },
    feedback: ["Surgical diff compliant."]
  };

  const sampleReport: EvaluationReport = {
    schemaVersion: 1,
    baseCommit: "abc1234",
    passed: true,
    metrics: {
      passAt1: 1.0,
      passAtK: 1.0,
      ssi: 1.0,
      k: 1,
      dei: 0.92,
      costMicroUsd: 125
    },
    violations: [],
    results: [
      {
        id: "task-001",
        kind: "f2p",
        base: { exitCode: 1, passed: false, signal: null, timedOut: false },
        current: { exitCode: 0, passed: true, signal: null, timedOut: false },
        passed: true
      }
    ],
    architecturalCompliance: mockCompliance
  };

  const reportPath = path.join(reportDir, "eval-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(sampleReport, null, 2), "utf-8");

  const service = new EvalHarnessService(tempDir);
  try {
    await service.start();
    const snapshot = service.getSnapshot();
    assert.equal(snapshot.status, "ready");
    assert.ok(snapshot.report);
    assert.equal(snapshot.report?.architecturalCompliance?.aqi, 4.74);
    assert.equal(snapshot.report?.architecturalCompliance?.passed, true);
    assert.equal(snapshot.report?.metrics.dei, 0.92);
    assert.equal(snapshot.report?.metrics.costMicroUsd, 125);
  } finally {
    await service.dispose();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
