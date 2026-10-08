import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import type { UsageEvent } from "../src/shared/usage.js";

function makeEvent(id: string): UsageEvent {
  return {
    id,
    sourceId: "immutable-ledger-test",
    sourceEventId: id,
    occurredAt: "2026-01-01T00:00:00.000Z",
    provider: "openai",
    tool: "gpt_architect",
    model: "gpt-6.1-sol",
    runId: "run-1",
    agentId: null,
    sessionId: "session-1",
    tokens: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40
    },
    estimatedCostUsd: 0.004,
    pricingVersion: "1.0",
    attribution: {
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
      branch: "feature/original",
      commit: "abc1234",
      provenance: "transcript"
    }
  };
}

test("caller mutation cannot rewrite an ingested historical event", () => {
  const telemetry = new TelemetryService(null);
  const event = makeEvent("caller-owned");
  const expected = structuredClone(event);

  assert.equal(telemetry.recordUsageEvent(event), true);
  assert.ok(event.attribution);

  // Reflect.set supports both detached-copy and frozen-record remedies.
  Reflect.set(event.attribution, "branch", "feature/rewritten");
  Reflect.set(event.tokens, "inputTokens", 999);
  Reflect.set(event, "estimatedCostUsd", 9);

  // Force recalculation so stale summaries cannot conceal ledger corruption.
  assert.equal(telemetry.recordUsageEvent(makeEvent("recalculate")), true);

  const stored = telemetry.getUsageEvents()
    .find((entry) => entry.id === expected.id);
  assert.deepEqual(stored, expected);

  const summaries = telemetry.getBranchUsageSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.branch, "feature/original");
  assert.equal(summaries[0]?.tokens.inputTokens, 200);
  assert.equal(summaries[0]?.knownEstimatedCostUsd, 0.008);

  assert.equal(telemetry.recordUsageEvent(expected), false);
  assert.equal(telemetry.getUsageEvents().length, 2);
});

test("getUsageEvents cannot expose writable historical records", () => {
  const telemetry = new TelemetryService(null);
  const event = makeEvent("getter-owned");
  const expected = structuredClone(event);

  assert.equal(telemetry.recordUsageEvent(event), true);

  const exposed = telemetry.getUsageEvents()[0];
  assert.ok(exposed);
  assert.ok(exposed.attribution);

  Reflect.set(exposed.attribution, "branch", "feature/getter-tamper");
  Reflect.set(exposed.tokens, "outputTokens", 777);
  Reflect.set(exposed, "estimatedCostUsd", 12);

  assert.equal(telemetry.recordUsageEvent(makeEvent("recalculate")), true);

  const stored = telemetry.getUsageEvents()
    .find((entry) => entry.id === expected.id);
  assert.deepEqual(stored, expected);

  const summaries = telemetry.getBranchUsageSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.branch, "feature/original");
  assert.equal(summaries[0]?.tokens.outputTokens, 40);
  assert.equal(summaries[0]?.knownEstimatedCostUsd, 0.008);
});

test("branch summary mutation cannot corrupt published telemetry", () => {
  const telemetry = new TelemetryService(null);
  assert.equal(telemetry.recordUsageEvent(makeEvent("summary-owned")), true);

  const expected = structuredClone(telemetry.getBranchUsageSummaries());
  const exposed = telemetry.getBranchUsageSummaries();
  const summary = exposed[0];
  assert.ok(summary);

  Reflect.set(summary, "branch", "feature/summary-tamper");
  Reflect.set(summary.tokens, "inputTokens", 999);
  Reflect.set(summary, "knownEstimatedCostUsd", 99);

  assert.deepEqual(telemetry.getBranchUsageSummaries(), expected);
  assert.deepEqual(telemetry.getSnapshot().branchUsage, expected);

  // Also test runtime collection protection, independent of TS readonly.
  Reflect.set(exposed, "length", 0);

  assert.deepEqual(telemetry.getBranchUsageSummaries(), expected);
  assert.deepEqual(telemetry.getSnapshot().branchUsage, expected);
  assert.equal(telemetry.getUsageEvents().length, 1);
});
