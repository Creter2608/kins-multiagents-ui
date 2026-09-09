import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  JsonFileLoopStateStore,
  LoopCommandService,
  FileBlueprintArtifactVerifier,
  parseBlueprintGoldenAssertions,
  canonicalizeGoldenAssertions,
  assertWorkspaceMutationAllowed,
  BlueprintOracleService,
  type BlueprintOracleClient,
  CANONICAL_PHASES
} from "../src/loop/index.js";
import { parseSha256Hex, sha256Bytes } from "../src/checksum.js";
import { LoopEngine, assertBlueprintAllowsExecution, type LoopState } from "../src/engine.js";
import { LoopError } from "../src/errors.js";

const DUMMY_SHA = parseSha256Hex("c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c");

function createInitialState(runId: string = "test-run-123"): LoopState {
  return {
    schemaVersion: 2,
    revision: 1,
    runId,
    currentPhase: "INITIALIZE",
    status: "ready",
    goldenSha256: DUMMY_SHA,
    budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
    usage: { transitions: 0, retries: 0, operations: 0 },
    resourceBudget: { maxCostMicroUsd: 1000000, maxTokens: 120000, maxOracleCalls: 2, maxGlobalCycles: 2, maxVerificationRetries: 1, maxQualityRemediations: 1 },
    resourceUsage: { costMicroUsd: 0, promptTokens: 0, cachedTokens: 0, reasoningTokens: 0, completionTokens: 0, totalTokens: 0, oracleCalls: 0, globalCycles: 0, verificationRetries: 0, qualityRemediations: 0 },
    history: []
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-hard-hooks-"));
}

// Golden Assertion 1: {"in":"PLAN->EXECUTE; no blueprint","out":"TRANSITION_INVALID"}
test("Golden Assertion 1: PLAN -> EXECUTE without ready blueprint throws TRANSITION_INVALID", async () => {
  const tmpDir = makeTempDir();
  try {
    const stateFile = path.join(tmpDir, "state.json");
    const initial = {
      ...createInitialState("gate-run-001"),
      currentPhase: "PLAN" as const,
      status: "running" as const
    };
    fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

    const store = new JsonFileLoopStateStore(stateFile);
    const service = new LoopCommandService(store);

    await assert.rejects(
      service.transition({
        runId: "gate-run-001",
        expectedPhase: "PLAN",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      }),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "TRANSITION_INVALID");
        assert.match(err.message, /Stage 2 Technical Blueprint status must be 'ready'/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Golden Assertion 2: {"in":"second Stage 2 invocation","out":"rejected; count remains 1"}
test("Golden Assertion 2: Second Stage 2 invocation rejected; count remains 1", async () => {
  const tmpDir = makeTempDir();
  try {
    const stateFile = path.join(tmpDir, "state.json");
    const initial = {
      ...createInitialState("oracle-run-001"),
      currentPhase: "PLAN" as const,
      status: "running" as const
    };
    fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

    const store = new JsonFileLoopStateStore(stateFile);
    let oracleCalls = 0;
    const mockClient: BlueprintOracleClient = {
      async craftTechnicalPrompt(invocationKey, context) {
        oracleCalls++;
        return {
          markdown: `# Technical Blueprint\n\n\`\`\`json\n[\n  {"in": "test1", "out": "res1"},\n  {"in": "test2", "out": "res2"},\n  {"in": "test3", "out": "res3"}\n]\n\`\`\`\n`,
          providerReceipt: "receipt-token-123",
          completedAt: Date.now()
        };
      }
    };

    const oracleService = new BlueprintOracleService(store, mockClient, tmpDir);

    // Call 1: Must succeed
    const committedState = await oracleService.invokeOnce("oracle-run-001", "Design hooks");
    assert.equal(committedState.blueprint?.status, "ready");
    assert.equal(committedState.blueprint?.invocationCount, 1);
    assert.equal(oracleCalls, 1);

    // Call 2: Second invocation must be rejected with BUDGET_EXHAUSTED
    await assert.rejects(
      oracleService.invokeOnce("oracle-run-001", "Design hooks again"),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "BUDGET_EXHAUSTED");
        assert.match(err.message, /invocation count already reached maximum of 1/);
        return true;
      }
    );

    // Verify invocationCount remains 1 and client was not invoked a second time
    const finalState = await store.read();
    assert.equal(finalState.blueprint?.invocationCount, 1);
    assert.equal(oracleCalls, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Golden Assertion 3: {"in":"ready blueprint; artifact changed","out":"BLUEPRINT_INTEGRITY"}
test("Golden Assertion 3: Ready blueprint with modified artifact throws BLUEPRINT_INTEGRITY", async () => {
  const tmpDir = makeTempDir();
  try {
    const aiDir = path.join(tmpDir, ".ai");
    fs.mkdirSync(aiDir, { recursive: true });
    const blueprintPath = path.join(aiDir, "blueprint.md");

    const validMarkdown = `# Technical Blueprint\n\n\`\`\`json\n[\n  {"in": "inputA", "out": "outputA"},\n  {"in": "inputB", "out": "outputB"},\n  {"in": "inputC", "out": "outputC"}\n]\n\`\`\`\n`;
    fs.writeFileSync(blueprintPath, validMarkdown, "utf-8");

    const validSha = sha256Bytes(Buffer.from(validMarkdown, "utf-8"));
    const assertions = parseBlueprintGoldenAssertions(validMarkdown);
    const assertionsSha = sha256Bytes(Buffer.from(canonicalizeGoldenAssertions(assertions), "utf-8"));

    const state: LoopState = {
      ...createInitialState("verify-run-001"),
      currentPhase: "PLAN",
      status: "running",
      blueprint: {
        status: "ready",
        invocationKey: "key-1",
        invocationCount: 1,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: DUMMY_SHA,
        protectedEvalHash: DUMMY_SHA,
        artifactSha256: validSha,
        assertionsSha256: assertionsSha,
        goldenAssertions: assertions
      }
    };

    const verifier = new FileBlueprintArtifactVerifier(tmpDir);

    // Verification succeeds initially
    await verifier.verifyReadyBlueprint(state);

    // Tamper with blueprint file (e.g. change 1 byte)
    fs.writeFileSync(blueprintPath, validMarkdown + "\n<!-- tampered comment -->", "utf-8");

    // Verification must fail closed with BLUEPRINT_INTEGRITY
    await assert.rejects(
      verifier.verifyReadyBlueprint(state),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "BLUEPRINT_INTEGRITY");
        assert.match(err.message, /SHA-256 mismatch/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Golden Assertion 4: {"in":"write source during PLAN","out":"denied"}
test("Golden Assertion 4: Write source during PLAN phase is denied", () => {
  const tmpDir = makeTempDir();
  try {
    const state: LoopState = {
      ...createInitialState("guard-run-001"),
      currentPhase: "PLAN",
      status: "running"
    };

    assert.throws(
      () => {
        assertWorkspaceMutationAllowed(
          state,
          { kind: "modify", paths: ["src/app.ts"] },
          tmpDir
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "TRANSITION_INVALID");
        assert.match(err.message, /only permitted during EXECUTE phase/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Golden Assertion 5: {"in":"modify .eval during EXECUTE","out":"FAILED: SPECIFICATION_INTEGRITY"}
test("Golden Assertion 5: Modify .eval/ during EXECUTE throws SPECIFICATION_INTEGRITY", () => {
  const tmpDir = makeTempDir();
  try {
    const state: LoopState = {
      ...createInitialState("guard-run-002"),
      currentPhase: "EXECUTE",
      status: "running",
      blueprint: {
        status: "ready",
        invocationKey: "key-1",
        invocationCount: 1,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: DUMMY_SHA,
        protectedEvalHash: DUMMY_SHA,
        artifactSha256: DUMMY_SHA,
        assertionsSha256: DUMMY_SHA,
        goldenAssertions: [
          { in: "1", out: "2" },
          { in: "3", out: "4" },
          { in: "5", out: "6" }
        ]
      }
    };

    // Attempting to modify a file inside .eval must immediately throw SPECIFICATION_INTEGRITY
    assert.throws(
      () => {
        assertWorkspaceMutationAllowed(
          state,
          { kind: "modify", paths: [".eval/golden.json"] },
          tmpDir
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "SPECIFICATION_INTEGRITY");
        assert.match(err.message, /inside protected evaluation directory/);
        return true;
      }
    );

    // Attempting to modify .ai/blueprint.md during EXECUTE must also be denied
    assert.throws(
      () => {
        assertWorkspaceMutationAllowed(
          state,
          { kind: "modify", paths: [".ai/blueprint.md"] },
          tmpDir
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "SPECIFICATION_INTEGRITY");
        assert.match(err.message, /immutable Stage 2 artifact/);
        return true;
      }
    );

    // Permitted source mutation during EXECUTE with ready blueprint
    assert.doesNotThrow(() => {
      assertWorkspaceMutationAllowed(
        state,
        { kind: "modify", paths: ["src/feature.ts"] },
        tmpDir
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Strict assertion schema validation tests
test("BlueprintArtifactVerifier: rejects assertions with fewer than 3 or more than 5 items", () => {
  const tooFew = `# Blueprint\n\`\`\`json\n[{"in":"a","out":"b"},{"in":"c","out":"d"}]\n\`\`\`\n`;
  assert.throws(
    () => parseBlueprintGoldenAssertions(tooFew),
    (err: unknown) => err instanceof LoopError && err.code === "ASSERTION_SCHEMA_INVALID"
  );

  const tooMany = `# Blueprint\n\`\`\`json\n[{"in":"1","out":"a"},{"in":"2","out":"b"},{"in":"3","out":"c"},{"in":"4","out":"d"},{"in":"5","out":"e"},{"in":"6","out":"f"}]\n\`\`\`\n`;
  assert.throws(
    () => parseBlueprintGoldenAssertions(tooMany),
    (err: unknown) => err instanceof LoopError && err.code === "ASSERTION_SCHEMA_INVALID"
  );
});

test("BlueprintArtifactVerifier: rejects extra fields and empty values in assertions", () => {
  const extraFields = `# Blueprint\n\`\`\`json\n[{"in":"a","out":"b","extra":123},{"in":"c","out":"d"},{"in":"e","out":"f"}]\n\`\`\`\n`;
  assert.throws(
    () => parseBlueprintGoldenAssertions(extraFields),
    (err: unknown) => err instanceof LoopError && err.code === "ASSERTION_SCHEMA_INVALID"
  );

  const emptyIn = `# Blueprint\n\`\`\`json\n[{"in":"","out":"b"},{"in":"c","out":"d"},{"in":"e","out":"f"}]\n\`\`\`\n`;
  assert.throws(
    () => parseBlueprintGoldenAssertions(emptyIn),
    (err: unknown) => err instanceof LoopError && err.code === "ASSERTION_SCHEMA_INVALID"
  );
});

// BP-004: Unconditional verifier enforcement in LoopCommandService
test("BP-004: LoopCommandService default verifier unconditionally blocks PLAN->EXECUTE if blueprint artifact is missing", async () => {
  const tmpDir = makeTempDir();
  try {
    const stateFile = path.join(tmpDir, "state.json");
    const initial = {
      ...createInitialState("bp-004-run"),
      currentPhase: "PLAN" as const,
      status: "running" as const,
      blueprint: {
        status: "ready" as const,
        invocationKey: "key-1",
        invocationCount: 1 as const,
        artifactPath: ".ai/blueprint.md" as const,
        plannedTreeHash: DUMMY_SHA,
        protectedEvalHash: DUMMY_SHA,
        artifactSha256: DUMMY_SHA,
        assertionsSha256: DUMMY_SHA,
        goldenAssertions: [
          { in: "1", out: "2" },
          { in: "3", out: "4" },
          { in: "5", out: "6" }
        ]
      }
    };
    fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

    // Instantiated without passing blueprintVerifier -> must use FileBlueprintArtifactVerifier
    const store = new JsonFileLoopStateStore(stateFile);
    const service = new LoopCommandService(store);

    await assert.rejects(
      service.transition({
        runId: "bp-004-run",
        expectedPhase: "PLAN",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      }),
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.equal(err.code, "BLUEPRINT_INTEGRITY");
        assert.match(err.message, /Blueprint artifact missing or unreadable/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// BP-005: Engine asserts assertionsSha256
test("BP-005: assertBlueprintAllowsExecution throws TRANSITION_INVALID when assertionsSha256 is missing", () => {
  const state: LoopState = {
    ...createInitialState("bp-005-run"),
    currentPhase: "PLAN",
    status: "running",
    blueprint: {
      status: "ready",
      invocationKey: "key-1",
      invocationCount: 1,
      artifactPath: ".ai/blueprint.md",
      plannedTreeHash: DUMMY_SHA,
      protectedEvalHash: DUMMY_SHA,
      artifactSha256: DUMMY_SHA,
      // assertionsSha256 intentionally missing
      goldenAssertions: [
        { in: "1", out: "2" },
        { in: "3", out: "4" },
        { in: "5", out: "6" }
      ]
    }
  };

  // 1. Direct function assertion
  assert.throws(
    () => assertBlueprintAllowsExecution(state),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      assert.match(err.message, /assertionsSha256 is missing/);
      return true;
    }
  );

  // 2. Transition through LoopEngine
  const engine = new LoopEngine(
    {
      phases: CANONICAL_PHASES,
      initialPhase: "INITIALIZE",
      terminalPhase: "COMPLETE",
      budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
      goldenSha256: DUMMY_SHA,
      runId: "bp-005-run"
    },
    state
  );

  assert.throws(
    () => engine.transition("EXECUTE"),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      assert.match(err.message, /assertionsSha256 is missing/);
      return true;
    }
  );
});

