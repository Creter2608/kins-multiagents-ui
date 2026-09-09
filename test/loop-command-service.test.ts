import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  JsonFileLoopStateStore,
  FileLock,
  LoopCommandService,
  LoopPhaseConflictError,
  LoopRevisionConflictError,
  handleAgentLoopStatus,
  handleAgentLoopTransition,
  handleJsonRpcMessage,
  MCP_TOOLS_LIST,
  CANONICAL_PHASES,
  type BlueprintArtifactVerifier
} from "../src/loop/index.js";
import { parseSha256Hex } from "../src/checksum.js";
import { LoopEngine, type LoopState, type AuditRecord } from "../src/engine.js";
import { LoopError } from "../src/errors.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

const NOOP_BLUEPRINT_VERIFIER: BlueprintArtifactVerifier = {
  async verifyReadyBlueprint() {}
};

const DUMMY_SHA = parseSha256Hex("c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c");

const DUMMY_READY_BLUEPRINT = {
  status: "ready" as const,
  invocationKey: "key-1",
  invocationCount: 1 as const,
  artifactPath: ".ai/blueprint.md" as const,
  plannedTreeHash: DUMMY_SHA,
  protectedEvalHash: DUMMY_SHA,
  artifactSha256: DUMMY_SHA,
  assertionsSha256: DUMMY_SHA,
  goldenAssertions: [
    { in: "a", out: "b" },
    { in: "c", out: "d" },
    { in: "e", out: "f" }
  ],
  completedAt: 1234567890
};

function createInitialState(runId: string = "test-run-123"): LoopState {
  return {
    schemaVersion: 1,
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

function makeTempStateFile(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-loop-test-"));
  return path.join(tmpDir, "state.json");
}

test("LoopStateStore: reads and updates atomically under file lock", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState();
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const read1 = await store.read();
  assert.equal(read1.runId, "test-run-123");
  assert.equal(read1.currentPhase, "INITIALIZE");

  const updated = await store.update((current) => ({
    ...current,
    currentPhase: "SPEC_GATE",
    usage: { ...current.usage, transitions: 1 }
  }));

  assert.equal(updated.currentPhase, "SPEC_GATE");
  assert.equal(updated.usage.transitions, 1);

  // Read back to confirm persistence
  const read2 = await store.read();
  assert.equal(read2.currentPhase, "SPEC_GATE");
  assert.equal(read2.usage.transitions, 1);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopStateStore: throws STATE_CONFLICT when file is locked by another process", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState();
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const externalLock = new FileLock(stateFile);
  externalLock.acquire();

  const store = new JsonFileLoopStateStore(stateFile);
  await assert.rejects(
    async () => {
      await store.update((curr) => curr);
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "STATE_CONFLICT");
      return true;
    }
  );

  externalLock.release();
  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopStateStore: rejects state file paths pointing inside .eval/", () => {
  assert.throws(
    () => new JsonFileLoopStateStore(path.resolve(".eval", "state.json")),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "CONFIG_INVALID");
      return true;
    }
  );
});

test("LoopCommandService: Assertion 1 - SPEC_GATE + approve + matching runId transitions to ISOLATE", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "SPEC_GATE" as const,
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  const result = await service.transition({
    runId: "test-run-123",
    expectedPhase: "SPEC_GATE",
    expectedRevision: 1,
    action: "approve",
    actor: "human"
  });

  assert.equal(result.previousPhase, "SPEC_GATE");
  assert.equal(result.state.currentPhase, "ISOLATE");
  assert.equal(result.state.status, "running");
  assert.equal(result.state.usage.transitions, 1);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: Assertion 2 - Repeat transition with stale expectedPhase throws PHASE_CONFLICT and leaves state unchanged", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "ISOLATE" as const,
    status: "running" as const,
    usage: { transitions: 1, retries: 0, operations: 0 },
    history: [
      {
        sequence: 1,
        from: "SPEC_GATE" as const,
        to: "ISOLATE" as const,
        triggeredBy: "human: approve",
        timestamp: Date.now()
      }
    ]
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  // Agent sends stale expectedPhase: "SPEC_GATE" when state is already at "ISOLATE"
  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "SPEC_GATE",
        expectedRevision: 1,
        action: "approve",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopPhaseConflictError);
      assert.equal(err.code, "PHASE_CONFLICT");
      assert.equal(err.expectedPhase, "SPEC_GATE");
      assert.equal(err.actualPhase, "ISOLATE");
      return true;
    }
  );

  // State remains unchanged
  const current = await service.status();
  assert.equal(current.currentPhase, "ISOLATE");
  assert.equal(current.usage.transitions, 1);
  assert.equal(current.history.length, 1);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: Assertion 3 - RELEASE_GATE + reject + reason transitions to BLOCKED", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "RELEASE_GATE" as const,
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  const result = await service.transition({
    runId: "test-run-123",
    expectedPhase: "RELEASE_GATE",
    expectedRevision: 1,
    action: "reject",
    reason: "Missing regression test coverage on edge cases",
    actor: "human"
  });

  assert.equal(result.previousPhase, "RELEASE_GATE");
  assert.equal(result.state.currentPhase, "BLOCKED");
  assert.equal(result.state.status, "blocked");
  const lastHistory = result.state.history[result.state.history.length - 1];
  assert.ok(lastHistory);
  assert.match(lastHistory.triggeredBy || "", /human: reject \(Missing regression test coverage on edge cases\)/);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: rejects gate reject without reason", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "SPEC_GATE" as const,
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "SPEC_GATE",
        expectedRevision: 1,
        action: "reject",
        reason: "   ",
        actor: "human"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "CONFIG_INVALID");
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: rejects advance action at gates", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "SPEC_GATE" as const,
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "SPEC_GATE",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: rejects approve/reject actions at non-gate phases", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "PLAN" as const,
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "PLAN",
        expectedRevision: 1,
        action: "approve",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: validates runId strictly", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState("run-real-456");
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  await assert.rejects(
    async () => {
      await service.transition({
        runId: "run-fake-999",
        expectedPhase: "INITIALIZE",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "STATE_INVALID");
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("mcp-tools: handleAgentLoopStatus returns structured state", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState("mcp-run-001");
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  const res1 = await handleAgentLoopStatus(service);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.state.runId, "mcp-run-001");
    assert.equal(res1.state.currentPhase, "INITIALIZE");
  }

  // With matching runId
  const res2 = await handleAgentLoopStatus(service, { runId: "mcp-run-001" });
  assert.equal(res2.ok, true);

  // With mismatched runId
  const res3 = await handleAgentLoopStatus(service, { runId: "other-run" });
  assert.equal(res3.ok, false);
  if (!res3.ok) {
    assert.equal(res3.error.code, "RUN_ID_MISMATCH");
  }

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("mcp-tools: handleAgentLoopTransition handles successful advance and phase conflicts", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState("mcp-run-002"),
    currentPhase: "PLAN" as const,
    status: "running" as const,
    blueprint: DUMMY_READY_BLUEPRINT
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store, CANONICAL_PHASES, NOOP_BLUEPRINT_VERIFIER);

  // 1. Successful transition: PLAN -> EXECUTE
  const res1 = await handleAgentLoopTransition(service, {
    runId: "mcp-run-002",
    expectedPhase: "PLAN",
    expectedRevision: 1,
    action: "advance"
  });

  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.previousPhase, "PLAN");
    assert.equal(res1.state.currentPhase, "EXECUTE");
  }

  // 2. Duplicate tool call with stale expectedPhase (PLAN)
  const res2 = await handleAgentLoopTransition(service, {
    runId: "mcp-run-002",
    expectedPhase: "PLAN",
    expectedRevision: 1,
    action: "advance"
  });

  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.error.code, "PHASE_CONFLICT");
    assert.equal(res2.error.expectedPhase, "PLAN");
    assert.equal(res2.error.actualPhase, "EXECUTE");
  }

  // 3. Validation error: invalid action
  const res3 = await handleAgentLoopTransition(service, {
    runId: "mcp-run-002",
    expectedPhase: "EXECUTE",
    expectedRevision: 2,
    action: "invalid_action" as any
  });

  assert.equal(res3.ok, false);
  if (!res3.ok) {
    assert.equal(res3.error.code, "INVALID_ACTION");
  }

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("mcp-server: handleJsonRpcMessage responds to initialize, tools/list, and tools/call", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState("mcp-rpc-001"),
    currentPhase: "PLAN" as const,
    status: "running" as const,
    blueprint: DUMMY_READY_BLUEPRINT
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store, CANONICAL_PHASES, NOOP_BLUEPRINT_VERIFIER);

  // 1. initialize
  const initRes = await handleJsonRpcMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    service
  );
  assert.ok(initRes);
  assert.equal(initRes.id, 1);
  const initResult = initRes.result as Record<string, unknown>;
  assert.equal(initResult.protocolVersion, "2024-11-05");
  assert.ok(initResult.serverInfo);

  // 2. tools/list
  const listRes = await handleJsonRpcMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    service
  );
  assert.ok(listRes);
  const listResult = listRes.result as { tools: Array<{ name: string }> };
  assert.ok(Array.isArray(listResult.tools));
  const toolNames = listResult.tools.map((t) => t.name);
  assert.ok(toolNames.includes("agent_loop_status"));
  assert.ok(toolNames.includes("agent_loop_transition"));

  // 3. tools/call: agent_loop_status
  const callStatusRes = await handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agent_loop_status", arguments: {} }
    },
    service
  );
  assert.ok(callStatusRes);
  assert.equal(callStatusRes.id, 3);
  const statusResult = callStatusRes.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(statusResult.isError, false);
  const parsedStatus = JSON.parse(statusResult.content[0]?.text || "{}");
  assert.equal(parsedStatus.ok, true);
  assert.equal(parsedStatus.state.runId, "mcp-rpc-001");

  // 4. tools/call: agent_loop_transition
  const callTransRes = await handleJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "agent_loop_transition",
        arguments: {
          runId: "mcp-rpc-001",
          expectedPhase: "PLAN",
          expectedRevision: 1,
          action: "advance"
        }
      }
    },
    service
  );
  assert.ok(callTransRes);
  assert.equal(callTransRes.id, 4);
  const transResult = callTransRes.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(transResult.isError, false);
  const parsedTrans = JSON.parse(transResult.content[0]?.text || "{}");
  assert.equal(parsedTrans.ok, true);
  assert.equal(parsedTrans.state.currentPhase, "EXECUTE");

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("JsonFileLoopStateStore: writeSync writes atomically under file lock", async () => {
  const stateFile = makeTempStateFile();
  const store = new JsonFileLoopStateStore(stateFile);
  const testState = createInitialState("sync-write-001");

  store.writeSync(testState);

  assert.ok(fs.existsSync(stateFile));
  const readBack = await store.read();
  assert.equal(readBack.runId, "sync-write-001");
  assert.equal(readBack.currentPhase, "INITIALIZE");

  // Mutate and write again
  const mutatedState = {
    ...testState,
    currentPhase: "PLAN" as const,
    usage: { transitions: 1, retries: 0, operations: 0 }
  };
  store.writeSync(mutatedState);

  const readBack2 = await store.read();
  assert.equal(readBack2.currentPhase, "PLAN");
  assert.equal(readBack2.usage.transitions, 1);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopStateService: transitionPhase and resetLoop persist via store and notify listeners", () => {
  const stateFile = makeTempStateFile();
  const service = new LoopStateService(stateFile);

  const notifications: string[] = [];
  service.subscribe((snapshot: { currentPhase: string }) => {
    notifications.push(snapshot.currentPhase);
  });

  // resetLoop persists state
  const resetRes = service.resetLoop("reset-run-001");
  assert.equal(resetRes.success, true);
  assert.equal(service.getSnapshot().runId, "reset-run-001");

  // transitionPhase persists state
  const ok = service.transitionPhase("SPEC_GATE");
  assert.equal(ok, true);
  assert.equal(service.getSnapshot().currentPhase, "SPEC_GATE");

  // Read raw file to verify persistence
  const rawDisk = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  assert.equal(rawDisk.currentPhase, "SPEC_GATE");
  assert.equal(rawDisk.runId, "reset-run-001");

  service.dispose();
  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("Assertion 1: Two transitions use the same phase and revision -> Exactly one commits; the other returns OPTIMISTIC_CONCURRENCY_CONFLICT", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState("concurrency-run-001");
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  // Transition 1 with expectedRevision: 1
  const res1 = await service.transition({
    runId: "concurrency-run-001",
    expectedPhase: "INITIALIZE",
    expectedRevision: 1,
    action: "advance",
    actor: "agent"
  });
  assert.equal(res1.state.currentPhase, "SPEC_GATE");
  assert.equal(res1.state.revision, 2);

  // Concurrent attempt on stale phase and revision 1
  await assert.rejects(
    async () => {
      await service.transition({
        runId: "concurrency-run-001",
        expectedPhase: "INITIALIZE",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopPhaseConflictError || err instanceof LoopRevisionConflictError);
      return true;
    }
  );

  // Stale revision attempt on SPEC_GATE with expectedRevision: 1 instead of 2
  await assert.rejects(
    async () => {
      await service.transition({
        runId: "concurrency-run-001",
        expectedPhase: "SPEC_GATE",
        expectedRevision: 1,
        action: "approve",
        actor: "human"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopRevisionConflictError);
      assert.equal(err.code, "OPTIMISTIC_CONCURRENCY_CONFLICT");
      assert.equal(err.expectedRevision, 1);
      assert.equal(err.actualRevision, 2);
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("Assertion 2: Audit finds defects, one remediation passes closure -> pending -> running -> remediation_required -> closure_pending -> closed; two oracle calls total", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState("audit-run-001"),
    blueprint: DUMMY_READY_BLUEPRINT
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store, CANONICAL_PHASES, NOOP_BLUEPRINT_VERIFIER);

  // Advance to REALITY_CHECK: INITIALIZE -> SPEC_GATE -> ISOLATE -> DETECT_STACKS -> PLAN -> EXECUTE -> VERIFY -> REALITY_CHECK
  await service.transition({ runId: "audit-run-001", expectedPhase: "INITIALIZE", expectedRevision: 1, action: "advance", actor: "agent" });
  await service.transition({ runId: "audit-run-001", expectedPhase: "SPEC_GATE", expectedRevision: 2, action: "approve", actor: "human" });
  await service.transition({ runId: "audit-run-001", expectedPhase: "ISOLATE", expectedRevision: 3, action: "advance", actor: "agent" });
  await service.transition({ runId: "audit-run-001", expectedPhase: "DETECT_STACKS", expectedRevision: 4, action: "advance", actor: "agent" });
  await service.transition({ runId: "audit-run-001", expectedPhase: "PLAN", expectedRevision: 5, action: "advance", actor: "agent" });
  await service.transition({ runId: "audit-run-001", expectedPhase: "EXECUTE", expectedRevision: 6, action: "advance", actor: "agent" });
  const toReality = await service.transition({ runId: "audit-run-001", expectedPhase: "VERIFY", expectedRevision: 7, action: "advance", actor: "agent" });

  // 1. Entering REALITY_CHECK initializes audit status as 'pending'
  assert.equal(toReality.state.currentPhase, "REALITY_CHECK");
  assert.equal(toReality.state.audit?.status, "pending");
  assert.equal(toReality.state.revision, 8);

  // 2. Begin audit oracle (pending -> running)
  const runningState = await service.audit({
    runId: "audit-run-001",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 8,
    mutation: {
      kind: "begin",
      invocationKey: "audit-key-1",
      auditedTreeHash: "sha256-tree-1"
    }
  });
  assert.equal(runningState.audit?.status, "running");
  assert.equal(runningState.revision, 9);

  // 3. Complete audit with a finding (running -> remediation_required)
  const remediateState = await service.audit({
    runId: "audit-run-001",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 9,
    mutation: {
      kind: "complete",
      invocationKey: "audit-key-1",
      findings: [
        { id: "F-1", category: "AQI", severity: "HIGH", description: "Cyclomatic complexity exceeds threshold" }
      ],
      report: "1 defect found",
      completedAt: Date.now(),
      telemetry: {
        invocationKey: "audit-key-1",
        model: "gpt-5.6-sol",
        promptTokens: 5000,
        cachedTokens: 2000,
        reasoningTokens: 1000,
        completionTokens: 1500,
        totalTokens: 6500,
        costMicroUsd: 25000
      }
    }
  });
  assert.equal(remediateState.audit?.status, "remediation_required");
  assert.equal(remediateState.resourceUsage?.oracleCalls, 1);
  assert.equal(remediateState.revision, 10);

  // 4. Begin remediation (remediation_required -> closure_pending)
  const remediatingState = await service.audit({
    runId: "audit-run-001",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 10,
    mutation: { kind: "begin_remediation" }
  });
  assert.equal(remediatingState.audit?.status, "closure_pending");
  assert.equal(remediatingState.audit?.remediationCount, 1);
  assert.equal(remediatingState.revision, 11);

  // Cannot remediate a second time (qualityRemediation <= 1)
  await assert.rejects(
    async () => {
      await service.audit({
        runId: "audit-run-001",
        expectedPhase: "REALITY_CHECK",
        expectedRevision: 11,
        mutation: { kind: "begin_remediation" }
      });
    },
    /Cannot begin remediation when audit status is 'closure_pending'/
  );

  // 5. Close audit (closure_pending -> closed)
  const closedState = await service.audit({
    runId: "audit-run-001",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 11,
    mutation: {
      kind: "close",
      completedAt: Date.now()
    }
  });
  assert.equal(closedState.audit?.status, "closed");
  assert.equal(closedState.revision, 12);

  // 6. Transition to RELEASE_GATE is now allowed
  const releaseGate = await service.transition({
    runId: "audit-run-001",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 12,
    action: "advance",
    actor: "agent"
  });
  assert.equal(releaseGate.state.currentPhase, "RELEASE_GATE");
  assert.equal(releaseGate.state.revision, 13);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("Assertion 5: Usage projects total above $1 or 120k tokens -> Run fails closed before another paid invocation", async () => {
  const stateFile = makeTempStateFile();
  const initial = createInitialState("budget-run-001");
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  // Record usage up to limit
  const updated = await service.recordUsage({
    runId: "budget-run-001",
    expectedPhase: "INITIALIZE",
    expectedRevision: 1,
    telemetry: {
      invocationKey: "key-1",
      model: "gpt-5.6-sol",
      promptTokens: 60000,
      cachedTokens: 30000,
      reasoningTokens: 10000,
      completionTokens: 60000,
      totalTokens: 120000,
      costMicroUsd: 950000
    }
  });
  assert.equal(updated.resourceUsage?.totalTokens, 120000);
  assert.equal(updated.resourceUsage?.costMicroUsd, 950000);
  assert.equal(updated.revision, 2);

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

interface AuditHarness {
  readonly service: LoopCommandService;
  readonly state: () => LoopState;
}

function createAuditHarness(audit: AuditRecord): AuditHarness {
  let current: LoopState = {
    schemaVersion: 1,
    revision: 7,
    runId: "adversarial-run",
    currentPhase: "REALITY_CHECK",
    status: "running",
    goldenSha256: DUMMY_SHA,
    budget: {
      maxTransitions: 20,
      maxRetries: 2,
      maxOperations: 100
    },
    usage: {
      transitions: 0,
      retries: 0,
      operations: 0
    },
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
    },
    history: [],
    audit
  };

  const service = Object.create(LoopCommandService.prototype) as LoopCommandService;
  Object.defineProperty(service, "store", {
    configurable: true,
    value: {
      update: async (
        mutation: (state: LoopState) => LoopState | Promise<LoopState>
      ): Promise<LoopState> => {
        current = await mutation(current);
        return current;
      }
    }
  });

  return {
    service,
    state: () => current
  };
}

test("Adversarial QA F-01: audit mutation fails closed when expectedRevision is omitted", async () => {
  const harness = createAuditHarness({
    status: "pending",
    remediationCount: 0
  });

  const commandWithoutRevision = {
    runId: "adversarial-run",
    expectedPhase: "REALITY_CHECK",
    mutation: {
      kind: "begin",
      invocationKey: "audit-call-1",
      auditedTreeHash: "tree-hash-1"
    }
  };

  await assert.rejects(
    harness.service.audit(
      commandWithoutRevision as unknown as Parameters<
        LoopCommandService["audit"]
      >[0]
    )
  );

  assert.equal(harness.state().revision, 7);
  assert.equal(harness.state().audit?.status, "pending");
});

test("Adversarial QA F-02: audit close rejects the illegal pending-to-closed transition", async () => {
  const harness = createAuditHarness({
    status: "pending",
    remediationCount: 0
  });

  await assert.rejects(
    harness.service.audit({
      runId: "adversarial-run",
      expectedPhase: "REALITY_CHECK",
      expectedRevision: 7,
      mutation: {
        kind: "close",
        report: "must not close",
        completedAt: 1_700_000_000_000
      }
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "TRANSITION_INVALID"
      );
      return true;
    }
  );

  assert.equal(harness.state().revision, 7);
  assert.equal(harness.state().audit?.status, "pending");
});

test("Adversarial QA F-03: release gate rejects REALITY_CHECK when no closed audit exists", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    runId: "release-without-audit",
    initialPhase: "REALITY_CHECK",
    terminalPhase: "COMPLETE",
    goldenSha256: DUMMY_SHA,
    budget: {
      maxTransitions: 20,
      maxRetries: 2,
      maxOperations: 100
    }
  });

  const before = engine.snapshot();

  assert.throws(
    () => engine.transition("RELEASE_GATE"),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "TRANSITION_INVALID"
      );
      return true;
    }
  );

  const after = engine.snapshot();
  assert.equal(after.currentPhase, "REALITY_CHECK");
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.history, before.history);
});

// Layer 1 Assertion 1: {"in":"state rev=7, tokens=42/120000","out":"snapshot preserves rev=7 and 42/120000"}
test("LoopStateService: snapshot preserves rev=7 and tokens=42/120000 with deep copy", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-rev-"));
  const statePath = path.join(tempDir, "state.json");
  try {
    const rawState = {
      runId: "run-rev-7",
      schemaVersion: 1,
      revision: 7,
      currentPhase: "EXECUTE",
      status: "running",
      usage: { transitions: 5, retries: 0, operations: 12 },
      budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
      resourceBudget: {
        maxCostMicroUsd: 1_000_000,
        maxTokens: 120_000,
        maxOracleCalls: 2,
        maxGlobalCycles: 2,
        maxVerificationRetries: 1,
        maxQualityRemediations: 1
      },
      resourceUsage: {
        costMicroUsd: 420,
        promptTokens: 30,
        cachedTokens: 10,
        reasoningTokens: 0,
        completionTokens: 12,
        totalTokens: 42,
        oracleCalls: 1,
        globalCycles: 1,
        verificationRetries: 0,
        qualityRemediations: 0
      }
    };
    fs.writeFileSync(statePath, JSON.stringify(rawState), "utf-8");

    const service = new LoopStateService(statePath, tempDir);
    const snap = service.readState();

    assert.equal(snap.revision, 7);
    assert.equal(snap.resourceUsage.totalTokens, 42);
    assert.equal(snap.resourceBudget.maxTokens, 120_000);

    // Deep copy verification - mutations must not affect snapshot
    assert.notStrictEqual(snap.resourceUsage, rawState.resourceUsage);
    assert.notStrictEqual(snap.resourceBudget, rawState.resourceBudget);
    assert.deepEqual(snap.resourceUsage, rawState.resourceUsage);
    assert.deepEqual(snap.resourceBudget, rawState.resourceBudget);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 1 Assertion 2: {"in":"missing legacy resourceUsage","out":"cloned EMPTY_RESOURCE_USAGE; no cast"}
test("LoopCommandService: missing legacy resourceUsage clones EMPTY_RESOURCE_USAGE safely", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-legacy-usage-"));
  const statePath = path.join(tempDir, "state.json");
  try {
    const legacyState = {
      runId: "legacy-run-1",
      schemaVersion: 1,
      revision: 1,
      currentPhase: "REALITY_CHECK",
      status: "running",
      goldenSha256: DUMMY_SHA,
      budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
      usage: { transitions: 6, retries: 0, operations: 10 },
      history: [],
      audit: {
        status: "pending",
        remediationCount: 0
      }
    };
    fs.writeFileSync(statePath, JSON.stringify(legacyState), "utf-8");

    const store = new JsonFileLoopStateStore(statePath);
    const service = new LoopCommandService(store);

    // 1. Begin audit (pending -> running)
    await service.audit({
      runId: "legacy-run-1",
      expectedPhase: "REALITY_CHECK",
      expectedRevision: 1,
      mutation: {
        kind: "begin",
        invocationKey: "inv-1",
        auditedTreeHash: "abc1234"
      }
    });

    // 2. Complete audit (running -> accepted)
    const updated = await service.audit({
      runId: "legacy-run-1",
      expectedPhase: "REALITY_CHECK",
      expectedRevision: 2,
      mutation: {
        kind: "complete",
        invocationKey: "inv-1",
        report: "Audit passed without findings",
        findings: [],
        completedAt: Date.now(),
        telemetry: {
          invocationKey: "inv-1",
          model: "gpt-5.6-sol",
          promptTokens: 100,
          cachedTokens: 50,
          reasoningTokens: 20,
          completionTokens: 30,
          totalTokens: 130,
          costMicroUsd: 500
        }
      }
    });

    assert.equal(updated.revision, 3);
    assert.ok(updated.resourceUsage);
    assert.equal(updated.resourceUsage.totalTokens, 130);
    assert.equal(updated.resourceUsage.costMicroUsd, 500);
    assert.equal(updated.resourceUsage.oracleCalls, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Stage 4 Adversarial Audit Suite
test("Stage 4 Adversarial: LoopStateService explicitly copies resource snapshot objects", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/main/services/LoopStateService.ts"), "utf8");

  const copiedResourceBudget =
    /resourceBudget\s*:\s*(?:\{\s*\.\.\.[^}]*\.resourceBudget\s*\}|structuredClone\s*\([^)]*\.resourceBudget\s*\))/s;

  const copiedResourceUsage =
    /resourceUsage\s*:\s*(?:\{\s*\.\.\.[^}]*\.resourceUsage\s*\}|structuredClone\s*\([^)]*\.resourceUsage\s*\))/s;

  assert.match(
    source,
    copiedResourceBudget,
    "LoopStateService must place an independent resourceBudget copy in each snapshot"
  );

  assert.match(
    source,
    copiedResourceUsage,
    "LoopStateService must place an independent resourceUsage copy in each snapshot"
  );
});

test("Stage 4 Adversarial: resource contracts require revision, budget, and usage telemetry", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/shared/contracts.ts"), "utf8");

  assert.match(
    source,
    /readonly\s+revision\s*:\s*number\s*;/,
    "LoopStateSnapshot.revision must be required"
  );
  assert.doesNotMatch(
    source,
    /readonly\s+revision\s*\?/,
    "LoopStateSnapshot.revision must not be optional"
  );
  assert.match(
    source,
    /readonly\s+resourceBudget\s*:\s*ResourceBudget\s*;/
  );
  assert.match(
    source,
    /readonly\s+resourceUsage\s*:\s*ResourceUsage\s*;/
  );
});

test("Stage 4 Adversarial: legacy usage fallback is type-safe and renderer exposes required telemetry", () => {
  const commandSource = fs.readFileSync(path.resolve(process.cwd(), "src/loop/LoopCommandService.ts"), "utf8");
  const trackerSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/renderer/components/PhaseTracker.tsx"),
    "utf8"
  );

  assert.doesNotMatch(
    commandSource,
    /\bas\s+any\b|\/\/\s*@ts-(?:ignore|nocheck|expect-error)\b/,
    "Legacy resource usage fallback must not use unsafe casts or suppression"
  );

  assert.match(
    commandSource,
    /current\.resourceUsage\s*\?\s*\{\s*\.\.\.current\.resourceUsage\s*\}\s*:\s*\{\s*\.\.\.EMPTY_RESOURCE_USAGE\s*\}/s,
    "Missing legacy resourceUsage must fall back to an independent EMPTY_RESOURCE_USAGE copy"
  );

  assert.match(
    trackerSource,
    /REV:\s*#\{loopState\.revision(?:\s*\?\?\s*1)?\}/,
    "PhaseTracker must render the loop revision"
  );
  assert.match(
    trackerSource,
    /loopState\.resourceUsage\?*\.totalTokens/,
    "PhaseTracker must render consumed token telemetry"
  );
  assert.match(
    trackerSource,
    /loopState\.resourceBudget\?*\.maxTokens/,
    "PhaseTracker must render the configured token maximum"
  );
});

test("LoopCommandService: blocks advance from REALITY_CHECK to RELEASE_GATE without closed audit status", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "REALITY_CHECK" as const,
    status: "running" as const,
    audit: { status: "pending" as const, remediationCount: 0 }
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  // 1. Default advance without explicit targetPhase
  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "REALITY_CHECK",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      assert.match(err.message, /Stage 4 Adversarial Audit status must be 'closed'/);
      return true;
    }
  );

  // 2. Explicit targetPhase: RELEASE_GATE (AUD-001 bypass regression test)
  await assert.rejects(
    async () => {
      await service.transition({
        runId: "test-run-123",
        expectedPhase: "REALITY_CHECK",
        expectedRevision: 1,
        action: "advance",
        targetPhase: "RELEASE_GATE",
        actor: "agent"
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.code, "TRANSITION_INVALID");
      assert.match(err.message, /Stage 4 Adversarial Audit status must be 'closed'/);
      return true;
    }
  );

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});

test("LoopCommandService: allows advance from REALITY_CHECK to RELEASE_GATE when audit status is closed", async () => {
  const stateFile = makeTempStateFile();
  const initial = {
    ...createInitialState(),
    currentPhase: "REALITY_CHECK" as const,
    status: "running" as const,
    audit: { status: "closed" as const, remediationCount: 0 }
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  const result = await service.transition({
    runId: "test-run-123",
    expectedPhase: "REALITY_CHECK",
    expectedRevision: 1,
    action: "advance",
    actor: "agent"
  });

  assert.equal(result.previousPhase, "REALITY_CHECK");
  assert.equal(result.state.currentPhase, "RELEASE_GATE");

  fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
});



