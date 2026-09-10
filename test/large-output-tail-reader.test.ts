import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  readAntigravityOutputTail,
  TranscriptIngestionService
} from "../src/main/services/TranscriptIngestionService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

test("Golden Assertion 1: valid output.txt with usage in final 8KiB -> parsed successfully", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tail-read-"));
  try {
    const outputDir = path.join(tmpDir, "steps", "101");
    await fs.mkdir(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, "output.txt");

    // Write a file larger than 8KiB with usage at the end
    const header = "X".repeat(12000);
    const usageLine = "\n\n---\n?? [GPT Token Usage]: Input: 3,500 (Cached: 1,000) | Output: Content: 1,200 | Thinking: 800 | Total: 5,500 | Cost: $0.0350 (35000 ?USD)\n";
    await fs.writeFile(outputFile, header + usageLine, "utf-8");

    const marker = `The output was large and was saved to: file:///${outputFile.replace(/\\/g, "/")}`;
    const tail = readAntigravityOutputTail(marker, [tmpDir]);

    assert.ok(tail !== null, "Tail must not be null");
    assert.ok(tail.length <= 8192, `Tail length (${tail.length}) must not exceed 8192 bytes`);
    assert.ok(tail.includes("?? [GPT Token Usage]:"), "Tail must contain the token usage line");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 2: file URL escaping allowed run root -> rejected safely", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tail-sec-"));
  try {
    const allowedDir = path.join(tmpDir, "allowed-root");
    const forbiddenDir = path.join(tmpDir, "forbidden-root");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(forbiddenDir, { recursive: true });

    const forbiddenFile = path.join(forbiddenDir, "secret.txt");
    await fs.writeFile(forbiddenFile, "?? [GPT Token Usage]: Input: 9999 | Output: 9999 | Total: 19998", "utf-8");

    const marker = `The output was large and was saved to: file:///${forbiddenFile.replace(/\\/g, "/")}`;
    const tail = readAntigravityOutputTail(marker, [allowedDir]);

    assert.equal(tail, null, "Dereferencing outside allowed roots must be rejected and return null");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 3: TranscriptIngestionService dereferences large output directly and updates TelemetryService", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tail-ingest-"));
  try {
    const brainDir = path.join(tmpDir, "brain");
    const stepDir = path.join(brainDir, "conv-1", ".system_generated", "steps", "162");
    await fs.mkdir(stepDir, { recursive: true });

    const outputFile = path.join(stepDir, "output.txt");
    const header = "Blueprint Architecture Plan\n" + "Z".repeat(10000);
    const usageLine = "\n\n---\n?? [GPT Token Usage]: Input: 3,109 (Cached: 500) | Output: Content: 2,500 | Thinking: 1,500 | Total: 7,109 | Cost: $0.0520 (52000 ?USD)\n";
    await fs.writeFile(outputFile, header + usageLine, "utf-8");

    const telemetryService = new TelemetryService(null);
    const mcpService = new McpMonitorService();
    const loopService = new LoopStateService(path.join(tmpDir, "state.json"), tmpDir, tmpDir);

    // Pass brainDir as allowedOutputRoots to verify production dereferencing pipeline directly
    const ingestion = new TranscriptIngestionService(telemetryService, mcpService, loopService, null, null, [brainDir]);

    // Feed a step that contains the large output marker directly to processLine
    const transcriptStep = {
      step_index: 42,
      source: "TOOL_OUTPUT",
      content: `Created At: 2026-09-10T11:50:34+07:00\nCompleted At: 2026-09-10T11:52:55+07:00\nThe output was large and was saved to: file:///${outputFile.replace(/\\/g, "/")}`
    };

    ingestion.processLine(JSON.stringify(transcriptStep));

    const metrics = telemetryService.getSnapshot();
    assert.equal(metrics.gptPromptTokens, 3109);
    assert.equal(metrics.gptCompletionTokens, 4000); // 2500 + 1500
    assert.equal(metrics.gptCacheHitTokens, 500);

    loopService.dispose();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Test 3: TranscriptIngestionService dereferences an allowlisted output marker under ~/.gemini default root", async () => {
  const conversationId = `audit-${process.pid}-${Date.now()}`;
  const brainRoot = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "brain"
  );
  const conversationRoot = path.join(brainRoot, conversationId);
  const outputDir = path.join(
    conversationRoot,
    ".system_generated",
    "steps",
    "162"
  );
  const outputFile = path.join(outputDir, "output.txt");

  const telemetryService = new TelemetryService(null);
  const mcpService = new McpMonitorService();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tail-real-ingest-"));
  const loopService = new LoopStateService(
    path.join(tmpDir, "state.json"),
    tmpDir,
    tmpDir
  );

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      outputFile,
      "X".repeat(12000) +
        "\n?? [GPT Token Usage]: Input: 3,109 (Cached: 500) | " +
        "Output: Content: 2,500 | Thinking: 1,500 | Total: 7,109 | " +
        "Cost: $0.0520 (52000 ?USD)\n",
      "utf-8"
    );

    const ingestion = new TranscriptIngestionService(
      telemetryService,
      mcpService,
      loopService
    );

    ingestion.processLine(
      JSON.stringify({
        step_index: 42,
        source: "TOOL_OUTPUT",
        content:
          "The output was large and was saved to: " +
          `file:///${outputFile.replace(/\\/g, "/")}`
      })
    );

    const metrics = telemetryService.getSnapshot();
    assert.equal(metrics.gptPromptTokens, 3109);
    assert.equal(metrics.gptCompletionTokens, 4000);
    assert.equal(metrics.gptCacheHitTokens, 500);
  } finally {
    loopService.dispose();
    await fs.rm(conversationRoot, { recursive: true, force: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
