import test from "node:test";
import * as assert from "node:assert/strict";
import { createDiagnosticsSnapshot, evaluateCeilingStatus, formatTokens } from "../src/renderer/components/TelemetryHud.js";
import type { TelemetrySnapshot, TelemetryMetrics } from "../src/shared/contracts.js";

test("FEAT-2: createDiagnosticsSnapshot creates structured diagnostics payload", () => {
  const dummyMetrics: TelemetryMetrics = {
    gpt: {
      inputTokens: 12000,
      outputTokens: 3500,
      cachedInputTokens: 4000
    },
    gemini: {
      inputTokens: 50000,
      outputTokens: 8000,
      cachedInputTokens: 0
    },
    estimatedCostUsd: 0.125
  };

  const dummySnapshot: TelemetrySnapshot = {
    budgetLimitUsd: 1.0,
    estimatedCostUsd: 0.125,
    gptPromptTokens: 12000,
    gptCompletionTokens: 3500,
    gptCacheHitTokens: 4000,
    gptCacheMissTokens: 8000,
    gptCacheHitPercentage: 33,
    geminiPromptTokens: 50000,
    geminiCompletionTokens: 8000,
    geminiCacheStatus: "Active",
    dockerStatus: "Active",
    lastUpdated: Date.now(),
    currentSession: dummyMetrics,
    allTime: dummyMetrics
  };

  const diagnostics = createDiagnosticsSnapshot(dummySnapshot, "session", dummyMetrics);

  assert.equal(diagnostics.scope, "session");
  assert.equal(diagnostics.telemetry.dockerStatus, "Active");
  assert.equal(diagnostics.telemetry.budgetLimitUsd, 1.0);
  assert.equal(diagnostics.metrics.gpt.inputTokens, 12000);
  assert.equal(diagnostics.ceilingStatus, "normal");
  assert.equal(typeof diagnostics.exportedAt, "string");
  assert.ok(Date.parse(diagnostics.exportedAt) > 0);
});

test("FEAT-2: evaluateCeilingStatus accurately evaluates normal, approaching, and exceeded thresholds", () => {
  // Normal
  assert.equal(evaluateCeilingStatus(10000, 2000, 0.10), "normal");

  // Approaching: >= 50k tokens or >= $0.40
  assert.equal(evaluateCeilingStatus(45000, 6000, 0.10), "approaching");
  assert.equal(evaluateCeilingStatus(10000, 2000, 0.42), "approaching");

  // Exceeded: >= 60k tokens or >= $0.50
  assert.equal(evaluateCeilingStatus(55000, 6000, 0.10), "exceeded");
  assert.equal(evaluateCeilingStatus(10000, 2000, 0.52), "exceeded");
});

test("FEAT-2: formatTokens formats numeric counts cleanly", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(2500000), "2.5M");
});
