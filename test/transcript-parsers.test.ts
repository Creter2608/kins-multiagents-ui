import test from "node:test";
import * as assert from "node:assert/strict";
import {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine
} from "../src/main/services/transcriptParsers.js";

import {
  isVerificationCommand as legacyIsVerificationCommand,
  isIsolationCommand as legacyIsIsolationCommand,
  isStackDetectionTarget as legacyIsStackDetectionTarget,
  parseVerificationOutput as legacyParseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep as legacyDetectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep as legacyDetectPhaseFromTranscriptStep,
  parseGptTokenUsageLine as legacyParseGptTokenUsageLine
} from "../src/main/services/TranscriptIngestionService.js";

// Assertion 1: {"in":"known verification command","out":"same classification as legacy parser"}
test("transcriptParsers: known verification commands correctly classified", () => {
  const commands = [
    "npm test",
    "npm run typecheck",
    "pytest tests/",
    "cargo test",
    "vitest run"
  ];

  for (const cmd of commands) {
    assert.equal(isVerificationCommand(cmd), true);
    assert.equal(legacyIsVerificationCommand(cmd), true);
  }
});

// Assertion 2: {"in":"near-match command","out":"not broadened into a match"}
test("transcriptParsers: near-match command not falsely classified", () => {
  const falsePositives = [
    "echo testing",
    "git commit -m 'update tests'",
    "npm run build",
    "node server.js"
  ];

  for (const cmd of falsePositives) {
    assert.equal(isVerificationCommand(cmd), false);
    assert.equal(legacyIsVerificationCommand(cmd), false);
  }

  assert.equal(isIsolationCommand("git status"), false);
  assert.equal(isStackDetectionTarget("README.md"), false);
  assert.equal(isStackDetectionTarget("package.json"), true);
});

// Assertion 3: {"in":"known phase transcript step","out":"same phase and evidence object"}
test("transcriptParsers: known phase transcript step produces exact phase and evidence", () => {
  const step = {
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "run_command",
        args: { CommandLine: "npm test" }
      }
    ]
  };

  const res = detectPhaseWithEvidenceFromTranscriptStep(step);
  const legacyRes = legacyDetectPhaseWithEvidenceFromTranscriptStep(step);

  assert.ok(res);
  assert.deepEqual(res, legacyRes);
  assert.equal(res.phase, "VERIFY");
  assert.equal(res.evidence, "cmd: npm test");

  const simplePhase = detectPhaseFromTranscriptStep(step);
  assert.equal(simplePhase, "VERIFY");
  assert.equal(simplePhase, legacyDetectPhaseFromTranscriptStep(step));
});

// Assertion 4: {"in":"valid GPT/Gemini usage lines","out":"exact legacy token objects"}
test("transcriptParsers: valid GPT token usage lines parsed identically to legacy parser", () => {
  const line = "GPT Token Usage: Input: 2,354 (Cached: 1,787) | Output: Blueprint: 2,687 | Thinking: 821 | Total: 5,862";
  const parsed = parseGptTokenUsageLine(line);
  const legacyParsed = legacyParseGptTokenUsageLine(line);

  assert.ok(parsed);
  assert.deepEqual(parsed, legacyParsed);
  assert.equal(parsed.inputTokens, 2354);
  assert.equal(parsed.cachedTokens, 1787);
  assert.equal(parsed.outputTokens, 3508); // 2687 + 821
  assert.equal(parsed.missTokens, 567);
  assert.equal(parsed.totalTokens, 5862);

  // Invalid usage line
  assert.equal(parseGptTokenUsageLine("No token data here"), null);
});

// Assertion 5: {"in":"legacy service imports","out":"same parser exports and behavior"}
test("transcriptParsers: backward compatibility re-exports from TranscriptIngestionService", () => {
  assert.strictEqual(legacyIsVerificationCommand, isVerificationCommand);
  assert.strictEqual(legacyIsIsolationCommand, isIsolationCommand);
  assert.strictEqual(legacyIsStackDetectionTarget, isStackDetectionTarget);
  assert.strictEqual(legacyParseVerificationOutput, parseVerificationOutput);
  assert.strictEqual(legacyDetectPhaseWithEvidenceFromTranscriptStep, detectPhaseWithEvidenceFromTranscriptStep);
  assert.strictEqual(legacyDetectPhaseFromTranscriptStep, detectPhaseFromTranscriptStep);
  assert.strictEqual(legacyParseGptTokenUsageLine, parseGptTokenUsageLine);

  // Verification output parsing (TAP and Jest formats)
  const tapOutput = "# pass 42\n# fail 0";
  const tapRes = parseVerificationOutput(tapOutput);
  assert.ok(tapRes);
  assert.equal(tapRes.status, "pass");
  assert.equal(tapRes.passCount, 42);
  assert.equal(tapRes.failCount, 0);

  const jestOutput = "Tests: 2 failed, 10 passed";
  const jestRes = parseVerificationOutput(jestOutput);
  assert.ok(jestRes);
  assert.equal(jestRes.status, "fail");
  assert.equal(jestRes.passCount, 10);
  assert.equal(jestRes.failCount, 2);
});
