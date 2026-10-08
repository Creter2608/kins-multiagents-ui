import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HarnessService } from "../src/main/services/HarnessService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import type { SessionEvent } from "../src/shared/harnessContracts.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("HarnessService: event recording, monotonic sequences, and live subscriptions", async () => {
  const tmpDir = createTempDir("kins-harness-test-");
  try {
    const harness = new HarnessService(tmpDir, "run-alpha");
    const receivedEvents: SessionEvent[] = [];

    const unsubscribe = harness.subscribe((ev) => {
      receivedEvents.push(ev);
    });

    const ev1 = await harness.recordEvent({
      source: "tool",
      kind: "tool_dispatch",
      data: { tool: "fetch_repo", args: { repo: "deepseek-ai/deepseek-harness" } }
    });

    const ev2 = await harness.recordEvent({
      source: "tool",
      kind: "tool_result",
      data: { status: "succeeded", output: "Cloned successfully" }
    });

    assert.equal(ev1.sequence, 1);
    assert.equal(ev2.sequence, 2);
    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[0]?.sequence, 1);
    assert.equal(receivedEvents[1]?.sequence, 2);

    const storedEvents = await harness.getEvents();
    assert.equal(storedEvents.length, 2);
    assert.equal(storedEvents[0]?.kind, "tool_dispatch");
    assert.equal(storedEvents[1]?.kind, "tool_result");

    unsubscribe();

    // After unsubscribe, no new notifications
    await harness.recordEvent({
      source: "loop",
      kind: "milestone",
      data: { message: "Test done" }
    });

    assert.equal(receivedEvents.length, 2);
    const finalStored = await harness.getEvents();
    assert.equal(finalStored.length, 3);

    await harness.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessService: loop guard detection and reset behavior", async () => {
  const tmpDir = createTempDir("kins-harness-guard-test-");
  try {
    const harness = new HarnessService(tmpDir, "run-guard");

    const tool = "run_command";
    const args = { CommandLine: "pytest test_core.py" };

    // 1st call -> allowed
    const d1 = harness.checkToolCall(tool, args);
    assert.equal(d1.allowed, true);
    harness.recordToolDispatch(tool, args);

    // 2nd call -> allowed
    const d2 = harness.checkToolCall(tool, args);
    assert.equal(d2.allowed, true);
    harness.recordToolDispatch(tool, args);

    // 3rd identical call -> blocked
    const d3 = harness.checkToolCall(tool, args);
    assert.equal(d3.allowed, false);
    assert.equal(d3.reasonCode, "REPEAT_TOOL_DETECTED");

    // Reset guard -> allowed again
    harness.resetGuard();
    const d4 = harness.checkToolCall(tool, args);
    assert.equal(d4.allowed, true);

    await harness.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessService: seamless run switching", async () => {
  const tmpDir = createTempDir("kins-harness-switch-test-");
  try {
    const harness = new HarnessService(tmpDir, "run-1");

    await harness.recordEvent({
      source: "loop",
      kind: "init",
      data: { run: "1" }
    });

    let eventsRun1 = await harness.getEvents();
    assert.equal(eventsRun1.length, 1);
    assert.equal(eventsRun1[0]?.runId, "run-1");

    // Switch to run-2
    await harness.switchRun("run-2");
    assert.equal(harness.getRunId(), "run-2");

    await harness.recordEvent({
      source: "loop",
      kind: "init",
      data: { run: "2" }
    });

    let eventsRun2 = await harness.getEvents();
    assert.equal(eventsRun2.length, 1);
    assert.equal(eventsRun2[0]?.runId, "run-2");

    // Switch back to run-1 -> recovers previous events
    await harness.switchRun("run-1");
    eventsRun1 = await harness.getEvents();
    assert.equal(eventsRun1.length, 1);
    assert.equal(eventsRun1[0]?.runId, "run-1");

    await harness.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TranscriptIngestionService + HarnessService: intercepts repeating tools and records loop events", async () => {
  const tmpDir = createTempDir("kins-transcript-harness-");
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  const aiStatePath = path.join(tmpDir, "state.json");

  try {
    fs.writeFileSync(aiStatePath, JSON.stringify({
      schemaVersion: "3.0",
      runId: "run-harness-integration",
      currentPhase: "INITIALIZE",
      phaseIndex: 0,
      phaseHistory: [],
      gateDecisions: [],
      qualityScores: {},
      evidenceLedger: [],
      architecturalCompliance: { verified: false, score: 0, details: [] },
      usage: { transitions: 0, retries: 0, operations: 0 },
      budget: { maxTransitions: 50, maxRetries: 3, maxOperations: 200 },
      resourceUsage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, oracleCalls: 0 },
      resourceBudget: { maxCostMicroUsd: 500000, maxTotalTokens: 60000, maxGptCalls: 2 },
      updatedAt: new Date().toISOString()
    }));

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService(tmpDir);
    const loop = new LoopStateService(aiStatePath, tmpDir);
    const harness = new HarnessService(tmpDir, "run-harness-integration");

    const transcriptService = new TranscriptIngestionService(
      telemetry,
      mcp,
      loop,
      transcriptPath
    );
    transcriptService.setHarnessService(harness);

    // Step 1: Tool call 1
    const step1 = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [{
        id: "call-1",
        name: "run_command",
        args: { CommandLine: "npm test" }
      }]
    }) + "\n";
    fs.appendFileSync(transcriptPath, step1);
    transcriptService.processFile();

    // Step 2: Tool call 2 (same)
    const step2 = JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [{
        id: "call-2",
        name: "run_command",
        args: { CommandLine: "npm test" }
      }]
    }) + "\n";
    fs.appendFileSync(transcriptPath, step2);
    transcriptService.processFile();

    // Step 3: Tool call 3 (identical 3rd call -> should be blocked by guard)
    const step3 = JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [{
        id: "call-3",
        name: "run_command",
        args: { CommandLine: "npm test" }
      }]
    }) + "\n";
    fs.appendFileSync(transcriptPath, step3);
    transcriptService.processFile();
    await harness.flush();

    const events = await harness.getEvents();
    assert.equal(events.length, 4);

    const loopEvents = events.filter((e) => e.source === "loop");
    const toolEvents = events.filter((e) => e.source === "tool");
    const guardEvents = events.filter((e) => e.source === "guard");

    assert.equal(loopEvents.length, 1);
    assert.equal(loopEvents[0]?.kind, "phase_transition");

    assert.equal(toolEvents.length, 2);
    assert.equal(toolEvents[0]?.kind, "tool_dispatch");
    assert.equal(toolEvents[1]?.kind, "tool_dispatch");

    // 3rd call was caught by guard
    assert.equal(guardEvents.length, 1);
    assert.equal(guardEvents[0]?.kind, "tool_blocked");
    assert.equal(guardEvents[0]?.data["reasonCode"], "REPEAT_TOOL_DETECTED");

    await harness.dispose();
    loop.dispose();
    mcp.dispose();
    telemetry.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
