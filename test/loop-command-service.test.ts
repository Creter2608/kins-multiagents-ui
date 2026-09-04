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
  handleAgentLoopStatus,
  handleAgentLoopTransition,
  handleJsonRpcMessage,
  MCP_TOOLS_LIST
} from "../src/loop/index.js";
import { parseSha256Hex } from "../src/checksum.js";
import type { LoopState } from "../src/engine.js";
import { LoopError } from "../src/errors.js";

const DUMMY_SHA = parseSha256Hex("c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c");

function createInitialState(runId: string = "test-run-123"): LoopState {
  return {
    schemaVersion: 1,
    runId,
    currentPhase: "INITIALIZE",
    status: "ready",
    goldenSha256: DUMMY_SHA,
    budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
    usage: { transitions: 0, retries: 0, operations: 0 },
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
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

  // 1. Successful transition: PLAN -> EXECUTE
  const res1 = await handleAgentLoopTransition(service, {
    runId: "mcp-run-002",
    expectedPhase: "PLAN",
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
    status: "running" as const
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

  const store = new JsonFileLoopStateStore(stateFile);
  const service = new LoopCommandService(store);

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

