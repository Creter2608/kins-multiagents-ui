import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import type { UsageEvent } from "../src/shared/usage.js";

function makeAuditEvent(id: string): UsageEvent {
  return {
    id,
    sourceId: "adversarial-audit",
    sourceEventId: id,
    occurredAt: "2026-01-01T00:00:00.000Z",
    provider: "openai",
    tool: "gpt_architect",
    model: "gpt-6.1-sol",
    runId: "audit-run",
    agentId: null,
    sessionId: "audit-session",
    tokens: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40
    },
    estimatedCostUsd: 0.004,
    pricingVersion: "1.0",
    attribution: {
      repositoryId: "audit-repo",
      worktreeId: "audit-worktree",
      branch: "feature/original",
      commit: "abc1234",
      provenance: "transcript"
    }
  };
}

test("duplicate event cannot rewrite attribution or double-count metrics", () => {
  const telemetry = new TelemetryService(null);
  const original = makeAuditEvent("duplicate");
  const expectedEvent = structuredClone(original);

  assert.equal(telemetry.recordUsageEvent(original), true);

  const before = structuredClone(telemetry.getSnapshot());
  const expectedSummaries = structuredClone(telemetry.getBranchUsageSummaries());

  const replay = makeAuditEvent("duplicate");
  assert.ok(replay.attribution);
  (replay.attribution as any).branch = "feature/replayed";
  (replay.tokens as any).inputTokens = 900;
  (replay.tokens as any).outputTokens = 700;
  (replay.tokens as any).cachedInputTokens = 600;
  (replay as any).estimatedCostUsd = 99;

  assert.equal(telemetry.recordUsageEvent(replay), false);

  const after = telemetry.getSnapshot();
  assert.deepEqual(telemetry.getUsageEvents(), [expectedEvent]);
  assert.deepEqual(telemetry.getBranchUsageSummaries(), expectedSummaries);
  assert.deepEqual(after.branchUsage, before.branchUsage);
  assert.deepEqual(after.currentSession, before.currentSession);
  assert.deepEqual(after.allTime, before.allTime);
});

test("snapshot mutation cannot corrupt metrics or branch summaries", () => {
  const telemetry = new TelemetryService(null);
  assert.equal(
    telemetry.recordUsageEvent(makeAuditEvent("snapshot-isolation")),
    true
  );

  const exposed = telemetry.getSnapshot();
  const expected = structuredClone(exposed);

  for (const metrics of [exposed.currentSession, exposed.allTime]) {
    if (metrics) {
      Reflect.set(metrics.gpt, "inputTokens", 999999);
      Reflect.set(metrics.gpt, "outputTokens", 999999);
      Reflect.set(metrics.gpt, "cachedInputTokens", 999999);
      Reflect.set(metrics.gemini, "inputTokens", 999999);
      Reflect.set(metrics.gemini, "outputTokens", 999999);
      Reflect.set(metrics.gemini, "cachedInputTokens", 999999);
      Reflect.set(metrics, "estimatedCostUsd", 999999);
    }
  }

  assert.ok(exposed.branchUsage);
  const summary = exposed.branchUsage[0];
  assert.ok(summary);

  Reflect.set(summary, "branch", "feature/snapshot-tamper");
  Reflect.set(summary.tokens, "inputTokens", 999999);
  Reflect.set(summary.tokens, "cachedInputTokens", 999999);
  Reflect.set(summary, "knownEstimatedCostUsd", 999999);
  Reflect.set(exposed.branchUsage, "length", 0);

  const fresh = telemetry.getSnapshot();
  assert.deepEqual(fresh.currentSession, expected.currentSession);
  assert.deepEqual(fresh.allTime, expected.allTime);
  assert.deepEqual(fresh.branchUsage, expected.branchUsage);
  assert.deepEqual(telemetry.getBranchUsageSummaries(), expected.branchUsage);
});
