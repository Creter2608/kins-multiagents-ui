/**
 * test/core-loop-wiring.test.ts
 * Verification test suite for Core Loop Wiring:
 * 1. Path & Registry Synchronization (--user-data CLI argument & multi-fallback)
 * 2. Automatic HMAC Blueprint Approval Issuance & Invalidation
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseSha256Hex } from "../src/checksum.js";
import {
  type LoopState,
  DEFAULT_RESOURCE_BUDGET,
  EMPTY_RESOURCE_USAGE
} from "../src/engine.js";
import {
  createBlueprintApproval,
  verifyBlueprintApproval,
  canonicalizePath
} from "../src/main/services/blueprintApprovalAuthenticator.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import {
  evaluatePreToolUseHook,
  parseCliHookArgs,
  resolveDefaultUserDataPath
} from "../src/cli/preToolUseHook.js";
import {
  JsonFileLoopStateStore,
  LoopCommandService
} from "../src/loop/index.js";

function createMockState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    schemaVersion: 2,
    revision: 1,
    runId: "run-wiring-001",
    currentPhase: "PLAN",
    status: "running",
    goldenSha256: parseSha256Hex("0".repeat(64)),
    budget: { maxTransitions: 25, maxRetries: 3, maxOperations: 100 },
    usage: { transitions: 1, retries: 0, operations: 5 },
    history: [],
    resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
    resourceUsage: { ...EMPTY_RESOURCE_USAGE },
    blueprint: {
      status: "ready",
      invocationKey: "key-wiring-001",
      invocationCount: 1,
      artifactPath: ".ai/blueprint.md",
      plannedTreeHash: parseSha256Hex("0".repeat(64)),
      protectedEvalHash: parseSha256Hex("0".repeat(64)),
      artifactSha256: parseSha256Hex("a".repeat(64)),
      assertionsSha256: parseSha256Hex("b".repeat(64)),
      goldenAssertions: [
        { in: "a", out: "b" },
        { in: "c", out: "d" },
        { in: "e", out: "f" }
      ]
    },
    ...overrides
  };
}

test("Golden Assertion 1: parseCliHookArgs parses --user-data, --registry, --auth-key", () => {
  const args1 = ["--user-data", "D:/custom/user-data", "--registry", "D:/custom/reg.json", "--auth-key", "D:/custom/key.bin"];
  const parsed1 = parseCliHookArgs(args1);
  assert.equal(parsed1.userDataPath, "D:/custom/user-data");
  assert.equal(parsed1.registryPath, "D:/custom/reg.json");
  assert.equal(parsed1.authKeyPath, "D:/custom/key.bin");

  const args2 = ["--user-data=D:/custom/user-data", "--registry=D:/custom/reg.json", "--auth-key=D:/custom/key.bin"];
  const parsed2 = parseCliHookArgs(args2);
  assert.equal(parsed2.userDataPath, "D:/custom/user-data");
  assert.equal(parsed2.registryPath, "D:/custom/reg.json");
  assert.equal(parsed2.authKeyPath, "D:/custom/key.bin");
});

test("Golden Assertion 2: evaluatePreToolUseHook with userDataPath resolves registry without ANTIGRAVITY_HOOK_USER_DATA", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-hook-"));
  try {
    const userData = path.join(tmpDir, "cockpit-user-data");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const state = createMockState({
      currentPhase: "PLAN",
      blueprintApproval: undefined
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const input = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "src", "index.ts") }
      },
      workspacePaths: [workspaceDir]
    };

    // Evaluate passing userDataPath in options, with empty process env
    const res = await evaluatePreToolUseHook(input, { userDataPath: userData });
    assert.equal(res.decision, "deny");
    // Verify it found the workspace registry in userDataPath and checked approval
    assert.match(res.reason, /Blueprint has not been approved/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 3 & 4: LoopCommandService.transition PLAN -> EXECUTE automatically issues valid blueprintApproval", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-cmd-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const stateFile = path.join(tmpDir, "state.json");
    const workspaceRoot = path.join(tmpDir, "my-repo");
    await fs.mkdir(workspaceRoot, { recursive: true });

    // Ensure signing key exists in userData
    const signingKey = PreToolUseHookService.getOrCreateSigningKeySync(userData);

    const store = new JsonFileLoopStateStore(stateFile);
    const initial = createMockState({
      currentPhase: "PLAN",
      revision: 1,
      runId: "run-advance-001",
      blueprintApproval: undefined
    });
    await store.writeSync(initial);

    // Mock verifier that passes
    const mockVerifier = {
      verifyReadyBlueprint: async () => {}
    };

    const cmdService = new LoopCommandService(
      store,
      undefined,
      mockVerifier,
      workspaceRoot,
      () => signingKey
    );

    // Advance PLAN -> EXECUTE
    const result = await cmdService.transition({
      runId: "run-advance-001",
      expectedPhase: "PLAN",
      expectedRevision: 1,
      action: "advance",
      actor: "agent"
    });

    assert.equal(result.state.currentPhase, "EXECUTE");
    assert.ok(result.state.blueprintApproval, "blueprintApproval must be defined on state");
    assert.equal(result.state.blueprintApproval.runId, "run-advance-001");
    assert.equal(result.state.blueprintApproval.canonicalWorkspacePath, canonicalizePath(workspaceRoot));
    assert.equal(result.state.blueprintApproval.blueprintSha256, initial.blueprint!.artifactSha256!);

    // Verify cryptographic signature with verifyBlueprintApproval
    const isValid = verifyBlueprintApproval(result.state, workspaceRoot, signingKey);
    assert.equal(isValid, true, "Blueprint approval must cryptographically verify against signingKey");

    // Re-read from store to ensure persistence
    const persisted = await store.read();
    assert.equal(persisted.currentPhase, "EXECUTE");
    assert.ok(persisted.blueprintApproval);
    assert.equal(verifyBlueprintApproval(persisted, workspaceRoot, signingKey), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 5: Blueprint mutation or rollback invalidates blueprintApproval", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-inval-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const stateFile = path.join(tmpDir, "state.json");
    const workspaceRoot = path.join(tmpDir, "my-repo");
    await fs.mkdir(workspaceRoot, { recursive: true });

    const signingKey = PreToolUseHookService.getOrCreateSigningKeySync(userData);
    const store = new JsonFileLoopStateStore(stateFile);

    const initial = createMockState({
      currentPhase: "PLAN",
      revision: 1,
      runId: "run-inval-001",
      blueprintApproval: undefined
    });
    await store.writeSync(initial);

    const mockVerifier = {
      verifyReadyBlueprint: async () => {}
    };

    const cmdService = new LoopCommandService(
      store,
      undefined,
      mockVerifier,
      workspaceRoot,
      () => signingKey
    );

    // 1. Advance to EXECUTE
    await cmdService.transition({
      runId: "run-inval-001",
      expectedPhase: "PLAN",
      expectedRevision: 1,
      action: "advance",
      actor: "agent"
    });

    const stateAfterAdvance = await store.read();
    assert.ok(stateAfterAdvance.blueprintApproval);

    // 2. Blueprint mutation (e.g. begin) invalidates approval
    // Set phase to PLAN for blueprint mutation test
    await store.update((s) => ({ ...s, currentPhase: "PLAN", blueprint: { ...s.blueprint!, status: "pending", invocationCount: 0 } }));
    const revBefore = (await store.read()).revision;

    const mutatedState = await cmdService.blueprint({
      runId: "run-inval-001",
      expectedPhase: "PLAN",
      expectedRevision: revBefore,
      mutation: {
        kind: "begin",
        invocationKey: "key-mut-001",
        plannedTreeHash: parseSha256Hex("1".repeat(64)),
        protectedEvalHash: parseSha256Hex("1".repeat(64))
      }
    });

    assert.equal(mutatedState.blueprintApproval, undefined, "blueprint mutation must clear blueprintApproval");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PLAN -> EXECUTE remains atomic when no blueprint signing key is available", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-no-key-"));
  const previousUserData = process.env.ANTIGRAVITY_HOOK_USER_DATA;

  try {
    const unusableUserDataPath = path.join(tmpDir, "not-a-directory");
    const stateFile = path.join(tmpDir, "state.json");
    const workspaceRoot = path.join(tmpDir, "workspace");

    await fs.writeFile(unusableUserDataPath, "regular file", "utf-8");
    await fs.mkdir(workspaceRoot, { recursive: true });
    process.env.ANTIGRAVITY_HOOK_USER_DATA = unusableUserDataPath;

    const store = new JsonFileLoopStateStore(stateFile);
    const initial = createMockState({
      currentPhase: "PLAN",
      revision: 1,
      runId: "run-no-signing-key",
      blueprintApproval: undefined
    });
    await store.writeSync(initial);

    const commandService = new LoopCommandService(
      store,
      undefined,
      { verifyReadyBlueprint: async () => {} },
      workspaceRoot,
      () => null
    );

    await assert.rejects(
      commandService.transition({
        runId: initial.runId,
        expectedPhase: "PLAN",
        expectedRevision: 1,
        action: "advance",
        actor: "agent"
      }),
      /signing key|blueprint approval|authenticate/i
    );

    const persisted = await store.read();
    assert.equal(persisted.currentPhase, "PLAN");
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.blueprintApproval, undefined);
    assert.deepEqual(persisted.history, initial.history);
  } finally {
    if (previousUserData === undefined) {
      delete process.env.ANTIGRAVITY_HOOK_USER_DATA;
    } else {
      process.env.ANTIGRAVITY_HOOK_USER_DATA = previousUserData;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PreToolUse hook rejects a registry entry with no entry HMAC", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-unsigned-registry-"));

  try {
    const userDataPath = path.join(tmpDir, "user-data");
    const workspaceRoot = path.join(tmpDir, "workspace");
    const sidecarStatePath = path.join(tmpDir, "sidecar", "state.json");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(path.dirname(sidecarStatePath), { recursive: true });

    const signingKey =
      PreToolUseHookService.getOrCreateSigningKeySync(userDataPath);
    const baseState = createMockState({
      currentPhase: "EXECUTE",
      runId: "run-unsigned-registry",
      blueprintApproval: undefined
    });

    const state: LoopState = {
      ...baseState,
      blueprintApproval: createBlueprintApproval(
        {
          runId: baseState.runId,
          canonicalWorkspacePath: workspaceRoot,
          blueprintSha256: baseState.blueprint!.artifactSha256!
        },
        signingKey
      )
    };

    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    const hookService = new PreToolUseHookService();
    await hookService.equipWorkspace({
      workspaceRoot,
      sidecarStatePath,
      userDataPath
    });

    const registryPath = path.join(
      userDataPath,
      "hooks",
      "workspaces.json"
    );
    const registry = JSON.parse(
      await fs.readFile(registryPath, "utf-8")
    );

    for (const entry of Object.values(registry.workspaces) as Array<{ entryHmac?: string; modeHmac?: string }>) {
      delete entry.entryHmac;
      delete entry.modeHmac;
    }
    await fs.writeFile(registryPath, JSON.stringify(registry), "utf-8");

    const result = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: path.join(workspaceRoot, "src", "index.ts")
          }
        },
        workspacePaths: [workspaceRoot]
      },
      { userDataPath }
    );

    assert.equal(result.decision, "deny");
    assert.match(result.reason, /HMAC|unsigned|authentication|registry/i);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
