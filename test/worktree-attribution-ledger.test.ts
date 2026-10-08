import { test } from "node:test";
import * as assert from "node:assert/strict";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { WorktreeAttributionService } from "../src/main/services/WorktreeAttributionService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { calculateTotalTokens } from "../src/shared/usage.js";
import type { UsageEvent, WorktreeAttribution } from "../src/shared/usage.js";
import { createDiagnosticsSnapshot } from "../src/renderer/components/TelemetryHud.js";

test("Golden Assertion 1: Replay one usage event twice -> one ledger entry and totals unchanged", () => {
  const telemetry = new TelemetryService(null);

  const event: UsageEvent = {
    id: "evt-unique-101",
    sourceId: "transcript-session-1",
    sourceEventId: "step-1",
    occurredAt: new Date().toISOString(),
    provider: "openai",
    tool: "gpt_architect",
    model: "gpt-6.1-sol",
    runId: "run-abc",
    agentId: null,
    sessionId: "sess-1",
    tokens: {
      inputTokens: 1000,
      outputTokens: 250,
      cachedInputTokens: 200
    },
    estimatedCostUsd: 0.004,
    pricingVersion: "1.0",
    attribution: {
      repositoryId: "repo-1",
      worktreeId: "wt-1",
      branch: "feat-auth",
      commit: "abc1234",
      provenance: "transcript"
    }
  };

  // First ingestion
  const recordedFirst = telemetry.recordUsageEvent(event);
  assert.equal(recordedFirst, true);
  assert.equal(telemetry.getUsageEvents().length, 1);
  const initialSummaries = telemetry.getBranchUsageSummaries();
  assert.equal(initialSummaries.length, 1);
  assert.equal(initialSummaries[0]?.branch, "feat-auth");
  assert.equal(initialSummaries[0]?.tokens.inputTokens, 1000);
  assert.equal(initialSummaries[0]?.tokens.outputTokens, 250);
  assert.equal(initialSummaries[0]?.tokens.cachedInputTokens, 200);
  assert.equal(initialSummaries[0]?.knownEstimatedCostUsd, 0.004);

  // Second ingestion (replay of identical event ID)
  const recordedSecond = telemetry.recordUsageEvent(event);
  assert.equal(recordedSecond, false); // Rejected as duplicate!
  assert.equal(telemetry.getUsageEvents().length, 1); // Ledger size unchanged

  const replayedSummaries = telemetry.getBranchUsageSummaries();
  assert.equal(replayedSummaries.length, 1);
  assert.equal(replayedSummaries[0]?.tokens.inputTokens, 1000); // Not doubled to 2000!
  assert.equal(replayedSummaries[0]?.knownEstimatedCostUsd, 0.004); // Not doubled to 0.008!
});

test("Golden Assertion 2: Branch switches after ingestion -> historical attribution remains immutable", () => {
  const telemetry = new TelemetryService(null);

  const eventBranchA: UsageEvent = {
    id: "evt-branch-a",
    sourceId: "session-1",
    sourceEventId: "step-1",
    occurredAt: new Date().toISOString(),
    provider: "openai",
    tool: "gpt_architect",
    model: "gpt-6.1-sol",
    runId: "run-1",
    agentId: null,
    sessionId: "sess-1",
    tokens: {
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 0
    },
    estimatedCostUsd: 0.002,
    pricingVersion: "1.0",
    attribution: {
      repositoryId: "repo-root",
      worktreeId: "wt-main",
      branch: "feature/branch-a",
      commit: "aaa1111",
      provenance: "transcript"
    }
  };

  telemetry.recordUsageEvent(eventBranchA);

  // Developer switches branch to feature/branch-b and runs another operation
  const eventBranchB: UsageEvent = {
    id: "evt-branch-b",
    sourceId: "session-1",
    sourceEventId: "step-2",
    occurredAt: new Date().toISOString(),
    provider: "openai",
    tool: "gpt_architect",
    model: "gpt-6.1-sol",
    runId: "run-1",
    agentId: null,
    sessionId: "sess-1",
    tokens: {
      inputTokens: 800,
      outputTokens: 200,
      cachedInputTokens: 100
    },
    estimatedCostUsd: 0.0035,
    pricingVersion: "1.0",
    attribution: {
      repositoryId: "repo-root",
      worktreeId: "wt-main",
      branch: "feature/branch-b",
      commit: "bbb2222",
      provenance: "transcript"
    }
  };

  telemetry.recordUsageEvent(eventBranchB);

  // Verify historical attribution of eventBranchA was not mutated
  const events = telemetry.getUsageEvents();
  assert.equal(events.length, 2);
  const foundA = events.find((e) => e.id === "evt-branch-a");
  const foundB = events.find((e) => e.id === "evt-branch-b");

  assert.equal(foundA?.attribution?.branch, "feature/branch-a");
  assert.equal(foundB?.attribution?.branch, "feature/branch-b");

  // Verify branch usage summaries contain distinct entries for each branch
  const summaries = telemetry.getBranchUsageSummaries();
  assert.equal(summaries.length, 2);
  const summaryA = summaries.find((s) => s.branch === "feature/branch-a");
  const summaryB = summaries.find((s) => s.branch === "feature/branch-b");

  assert.ok(summaryA);
  assert.ok(summaryB);
  assert.equal(summaryA.tokens.inputTokens, 500);
  assert.equal(summaryB.tokens.inputTokens, 800);
});

test("Golden Assertion 5: Input=100, cached=40, output=20 -> total tokens=120 without double-counting", () => {
  const tokens = {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20
  };

  const total = calculateTotalTokens(tokens);
  assert.equal(total, 120); // 100 input + 20 output; cached 40 is a subset and not double-counted
});

test("WorktreeAttributionService: safely resolves git worktree attribution and hashes paths", async () => {
  const service = new WorktreeAttributionService();
  const attribution = await service.resolve(process.cwd(), "launch");

  assert.ok(attribution);
  assert.ok(attribution.repositoryId.length > 0);
  assert.ok(attribution.worktreeId.length > 0);
  assert.equal(attribution.provenance, "launch");
  // Opaque hash invariant: must not be a raw windows drive path like D:\
  assert.equal(attribution.repositoryId.includes(":\\"), false);
  assert.equal(attribution.worktreeId.includes(":\\"), false);
});

test("TranscriptIngestionService: integrates worktree attribution and records canonical usage events", () => {
  const telemetry = new TelemetryService(null);
  const mcp = new McpMonitorService(process.cwd());
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  const attribution: WorktreeAttribution = {
    repositoryId: "repo-test",
    worktreeId: "wt-test",
    branch: "feat/telemetry-ledger",
    commit: "c0ffee1",
    provenance: "transcript"
  };

  ingestion.setWorktreeAttribution(attribution);

  // Ingest a step containing GPT Token Usage
  const step = {
    step_index: 42,
    type: "PLANNER_RESPONSE",
    content: "Here is the plan.\n📊 [GPT Token Usage]: Input: 500 | Output: Content: 150 | Thinking: 50 | Total: 700 | Cost: $0.0031",
    created_at: new Date().toISOString()
  };

  ingestion.processLine(JSON.stringify(step));

  const snapshot = telemetry.getSnapshot();
  assert.ok(snapshot.branchUsage);
  assert.equal(snapshot.branchUsage.length, 1);
  assert.equal(snapshot.branchUsage[0]?.branch, "feat/telemetry-ledger");
  assert.equal(snapshot.branchUsage[0]?.tokens.inputTokens, 500);
  assert.equal(snapshot.branchUsage[0]?.tokens.outputTokens, 200);

  // Verify DiagnosticsPayload contains branchUsage
  const diagnostics = createDiagnosticsSnapshot(snapshot, "session", snapshot.currentSession);
  assert.ok(diagnostics.telemetry.branchUsage);
  assert.equal(diagnostics.telemetry.branchUsage.length, 1);
  assert.equal(diagnostics.telemetry.branchUsage[0]?.branch, "feat/telemetry-ledger");
});
