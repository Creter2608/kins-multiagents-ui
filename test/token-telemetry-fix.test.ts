import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";

test("Token Telemetry Fix: 50 MODEL steps do not accumulate Gemini prompt tokens into millions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-fix-test-"));
  const transcriptPath = path.join(tempDir, "transcript.jsonl");
  const statePath = path.join(tempDir, "state.json");
  const telemetryPath = path.join(tempDir, "telemetry.json");

  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-token-fix-1",
        currentPhase: "EXECUTE",
        status: "running",
        resourceBudget: {
          maxCostMicroUsd: 1000000,
          maxTokens: 120000,
          maxOracleCalls: 2,
          maxGlobalCycles: 2,
          maxVerificationRetries: 1,
          maxQualityRemediations: 1
        },
        resourceUsage: {
          costMicroUsd: 0,
          promptTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          oracleCalls: 0,
          globalCycles: 0,
          verificationRetries: 0,
          qualityRemediations: 0
        }
      }),
      "utf-8"
    );

    const telemetry = new TelemetryService(telemetryPath);
    const mcp = new McpMonitorService();
    const loopService = new LoopStateService(statePath);
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loopService, transcriptPath);

    // Simulate 50 sequential MODEL steps in transcript
    const lines: string[] = [];
    for (let i = 1; i <= 50; i++) {
      lines.push(
        JSON.stringify({
          step_index: i,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          thinking: "Thinking step analysis and code inspection ".repeat(20),
          content: "Executed plan step " + i + " successfully with code verification."
        })
      );
    }
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf-8");

    ingestion.processFile();

    const telSnap = telemetry.getSnapshot();
    const loopSnap = loopService.getSnapshot();

    // 1. Gemini prompt tokens must reflect the current active context window, NOT an O(N^2) sum
    // Active context for 50 steps is ~30k initial + ~50k added chars ≈ 80k chars / 4 ≈ 20,000 tokens
    assert.ok(
      telSnap.geminiPromptTokens !== null && telSnap.geminiPromptTokens < 100000,
      `geminiPromptTokens (${telSnap.geminiPromptTokens}) must be < 100k tokens (active context), never millions`
    );

    // 2. Loop resource usage MUST NOT contain the static Gemini prompt context window
    // Total tokens in loopState must be bounded to completion tokens + GPT tokens (< 50,000 tokens)
    assert.ok(
      loopSnap.resourceUsage.totalTokens < 120000,
      `loopState.resourceUsage.totalTokens (${loopSnap.resourceUsage.totalTokens}) must not exceed budget of 120,000 tokens`
    );
    assert.equal(loopSnap.resourceUsage.promptTokens, 0, "Loop prompt tokens should only track Oracle calls");

    // 3. Now append a GPT token usage event (e.g. Stage 2 Blueprint or Stage 4 Audit)
    const gptStep = {
      step_index: 51,
      source: "TOOL_OUTPUT",
      content:
        "Here is the blueprint.\n\n---\n📊 [GPT Token Usage]: Input: 5,000 (Cached: 2,000) | Output: Content: 1,500 | Total: 6,500 | Cost: $0.0250 (25000 µUSD)"
    };
    fs.appendFileSync(transcriptPath, JSON.stringify(gptStep) + "\n", "utf-8");
    ingestion.processFile();

    const loopSnapAfterGpt = loopService.getSnapshot();
    assert.equal(loopSnapAfterGpt.resourceUsage.promptTokens, 5000);
    assert.equal(loopSnapAfterGpt.resourceUsage.cachedTokens, 2000);
    // totalTokens should equal GPT total (6500) + Gemini completion tokens
    assert.ok(
      loopSnapAfterGpt.resourceUsage.totalTokens >= 6500 &&
        loopSnapAfterGpt.resourceUsage.totalTokens < 25000,
      `totalTokens (${loopSnapAfterGpt.resourceUsage.totalTokens}) must be reasonably bounded (~6.5k + gen)`
    );

    loopService.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Token Telemetry Fix: run boundary change resets counters and usage to 0", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-reset-test-"));
  const transcriptPath = path.join(tempDir, "transcript.jsonl");
  const statePath = path.join(tempDir, "state.json");
  const telemetryPath = path.join(tempDir, "telemetry.json");

  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-A",
        currentPhase: "EXECUTE",
        status: "running",
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        usage: { transitions: 1, retries: 0, operations: 0 },
        resourceBudget: { maxCostMicroUsd: 1000000, maxTokens: 120000, maxOracleCalls: 2, maxGlobalCycles: 2, maxVerificationRetries: 1, maxQualityRemediations: 1 },
        resourceUsage: { costMicroUsd: 0, promptTokens: 5000, cachedTokens: 2000, reasoningTokens: 0, completionTokens: 1500, totalTokens: 6500, oracleCalls: 1, globalCycles: 0, verificationRetries: 0, qualityRemediations: 0 }
      }),
      "utf-8"
    );

    const telemetry = new TelemetryService(telemetryPath);
    const mcp = new McpMonitorService();
    const loopService = new LoopStateService(statePath);
    loopService.readState();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loopService, transcriptPath);

    // Initial check - usage has 6500 tokens
    assert.equal(loopService.getSnapshot().resourceUsage.totalTokens, 6500);

    // 1. Calling resetRunCounters directly resets usage and telemetry
    ingestion.resetRunCounters();
    assert.equal(loopService.getSnapshot().resourceUsage.totalTokens, 0);
    assert.equal(telemetry.getSnapshot().gptPromptTokens, 0);

    // 2. Loop reset via resetLoop resets loop state and triggers onRunReset callback
    loopService.resetLoop("run-B");
    assert.equal(loopService.getSnapshot().runId, "run-B");
    assert.equal(loopService.getSnapshot().resourceUsage.totalTokens, 0);

    loopService.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
