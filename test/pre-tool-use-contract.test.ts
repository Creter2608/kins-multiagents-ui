import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopError } from "../src/errors.js";
import type { LoopState } from "../src/engine.js";
import { assertWorkspaceMutationAllowed } from "../src/loop/WorkspaceWriteGuard.js";
import { evaluateWorkspaceMutationPolicy } from "../src/shared/workspaceMutationPolicy.js";

function createInitializeState(): LoopState {
  return JSON.parse(JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    runId: "contract-test-run",
    currentPhase: "INITIALIZE",
    status: "ready",
    goldenSha256: "0".repeat(64),
    budget: {
      maxTransitions: 20,
      maxRetries: 1,
      maxOperations: 100
    },
    usage: {
      transitions: 0,
      retries: 0,
      operations: 0
    },
    history: [],
    resourceBudget: {
      maxCostMicroUsd: 1_000_000,
      maxTokens: 120_000,
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
  })) as LoopState;
}

test("workspace mutation exports accept the mandated targetPaths array contract", () => {
  const state = createInitializeState();

  const result = evaluateWorkspaceMutationPolicy(state, ["probe.ts"]);
  assert.equal(result.allowed, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);

  assert.throws(
    () => assertWorkspaceMutationAllowed(state, ["probe.ts"]),
    LoopError
  );
});

test("package.json exposes the required Electron packaging command", () => {
  const packagePath = path.join(process.cwd(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };

  const packageCommand =
    packageJson.scripts?.["package"] ??
    packageJson.scripts?.["dist"];

  assert.ok(packageCommand !== undefined && typeof packageCommand === "string", "package.json must expose either an npm 'package' or 'dist' script");
  assert.ok(
    packageCommand.trim().length > 0,
    "the Electron packaging command must not be empty"
  );
});
