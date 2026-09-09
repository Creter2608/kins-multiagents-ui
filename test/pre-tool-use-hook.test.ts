/**
 * test/pre-tool-use-hook.test.ts
 * Rigorous deterministic test suite for Antigravity PreToolUse CLI Hard Hook.
 * Implements the 5 Stage 2 Golden Assertions and proves universal repository decoupling.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  createBlueprintApproval,
  verifyBlueprintApproval,
  canonicalizePath
} from "../src/main/services/blueprintApprovalAuthenticator.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import {
  evaluatePreToolUseHook,
  type PreToolUseHookInput
} from "../src/cli/preToolUseHook.js";
import { evaluateWorkspaceMutationPolicy } from "../src/shared/workspaceMutationPolicy.js";
import { parseSha256Hex } from "../src/checksum.js";
import {
  type LoopState,
  DEFAULT_RESOURCE_BUDGET,
  EMPTY_RESOURCE_USAGE
} from "../src/engine.js";

function createMockState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    schemaVersion: 2,
    revision: 1,
    runId: "run-test-001",
    currentPhase: "EXECUTE",
    status: "running",
    goldenSha256: parseSha256Hex("0".repeat(64)),
    budget: { maxTransitions: 25, maxRetries: 3, maxOperations: 100 },
    usage: { transitions: 5, retries: 0, operations: 10 },
    history: [],
    resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
    resourceUsage: { ...EMPTY_RESOURCE_USAGE },
    blueprint: {
      status: "ready",
      invocationKey: "key-001",
      invocationCount: 1,
      artifactPath: ".ai/blueprint.md",
      plannedTreeHash: parseSha256Hex("0".repeat(64)),
      protectedEvalHash: parseSha256Hex("0".repeat(64)),
      artifactSha256: parseSha256Hex("a".repeat(64)),
      assertionsSha256: parseSha256Hex("b".repeat(64))
    },
    ...overrides
  };
}

test("Golden Assertion 1: write before approval -> deny", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    // State in PLAN phase, blueprint not ready, no approval
    const state = createMockState({
      currentPhase: "PLAN",
      blueprint: undefined,
      blueprintApproval: undefined
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "src", "index.ts") }
      },
      workspacePaths: [workspaceDir]
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /Blueprint has not been approved/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 2: valid signed approval in EXECUTE -> allow", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const approval = createBlueprintApproval(
      {
        runId: "run-test-001",
        canonicalWorkspacePath: workspaceDir,
        blueprintSha256: "a".repeat(64)
      },
      equipped.signingKey
    );

    const state = createMockState({
      currentPhase: "EXECUTE",
      blueprintApproval: approval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(workspaceDir, "src", "feature.ts") }
      },
      workspacePaths: [workspaceDir]
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "allow");
    assert.match(res.reason, /Mutation permitted/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 3: tampered signature or stale run -> deny", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    // 1. Stale run replay test
    const staleApproval = createBlueprintApproval(
      {
        runId: "run-STALE-OLD",
        canonicalWorkspacePath: workspaceDir,
        blueprintSha256: "a".repeat(64)
      },
      equipped.signingKey
    );

    const stateWithStaleRun = createMockState({
      runId: "run-ACTIVE-NEW",
      currentPhase: "EXECUTE",
      blueprintApproval: staleApproval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(stateWithStaleRun), "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "src", "app.ts") }
      },
      workspacePaths: [workspaceDir]
    };

    let res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");

    // 2. Tampered signature test
    const tamperedApproval = {
      ...staleApproval,
      runId: "run-ACTIVE-NEW",
      signature: "deadbeef".repeat(8)
    };
    const stateWithTamperedSig = createMockState({
      runId: "run-ACTIVE-NEW",
      currentPhase: "EXECUTE",
      blueprintApproval: tamperedApproval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(stateWithTamperedSig), "utf-8");

    res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 4: target outside registered workspace -> deny", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const foreignDir = path.join(tmpDir, "foreign-unregistered-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(foreignDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const approval = createBlueprintApproval(
      {
        runId: "run-test-001",
        canonicalWorkspacePath: workspaceDir,
        blueprintSha256: "a".repeat(64)
      },
      equipped.signingKey
    );

    const state = createMockState({
      currentPhase: "EXECUTE",
      blueprintApproval: approval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    // Target is in foreign unregistered repo
    const input: PreToolUseHookInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(foreignDir, "secret.txt") }
      },
      workspacePaths: [foreignDir]
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /outside any registered Cockpit workspace/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 5: mutation during read-only audit -> deny", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const approval = createBlueprintApproval(
      {
        runId: "run-test-001",
        canonicalWorkspacePath: workspaceDir,
        blueprintSha256: "a".repeat(64)
      },
      equipped.signingKey
    );

    // Current phase is REALITY_CHECK (read-only audit phase)
    const state = createMockState({
      currentPhase: "REALITY_CHECK",
      blueprintApproval: approval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "src", "code.ts") }
      },
      workspacePaths: [workspaceDir]
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /only permitted during EXECUTE phase/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Decoupling invariant: equip leaves target repository completely clean (0 foreign files)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-decouple-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    // Put one user file in target repo
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# Target Project\n");

    const hookService = new PreToolUseHookService();
    const hooksConfigPath = path.join(tmpDir, "gemini-config", "hooks.json");
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData,
      hooksConfigPath
    });

    // Check target repo contents: MUST ONLY HAVE README.md
    const repoEntries = await fs.readdir(workspaceDir);
    assert.deepEqual(repoEntries, ["README.md"]);

    // Verify .ai, .agents do NOT exist in target repo
    const hasAi = await fs.access(path.join(workspaceDir, ".ai")).then(() => true).catch(() => false);
    const hasAgents = await fs.access(path.join(workspaceDir, ".agents")).then(() => true).catch(() => false);
    assert.equal(hasAi, false, "Target repo must not have .ai directory");
    assert.equal(hasAgents, false, "Target repo must not have .agents directory");

    // Verify hook was installed cleanly into external hooksConfigPath
    const hooksContent = JSON.parse(await fs.readFile(hooksConfigPath, "utf-8"));
    assert.ok(hooksContent[PreToolUseHookService.HOOK_IDENTIFIER]);
    assert.equal(hooksContent[PreToolUseHookService.HOOK_IDENTIFIER].PreToolUse[0].matcher, PreToolUseHookService.HOOK_MATCHER);

    // Verify unequip cleans up
    await hookService.unequipWorkspace(workspaceDir, userData);
    const registry = JSON.parse(await fs.readFile(path.join(userData, "hooks", "workspaces.json"), "utf-8"));
    assert.equal(registry.workspaces[canonicalizePath(workspaceDir)], undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Real process CLI pipe test: spawn preToolUseHook.js with stdin/stdout protocol", async () => {
  const { spawn } = await import("node:child_process");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-pipe-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const approval = createBlueprintApproval(
      {
        runId: "run-pipe-001",
        canonicalWorkspacePath: workspaceDir,
        blueprintSha256: "a".repeat(64)
      },
      equipped.signingKey
    );

    const state = createMockState({
      runId: "run-pipe-001",
      currentPhase: "EXECUTE",
      blueprintApproval: approval
    });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    const cliScriptPath = path.resolve(process.cwd(), "dist", "src", "cli", "preToolUseHook.js");

    // Helper to run CLI process
    async function runCliWithPayload(payload: unknown): Promise<{ decision: string; reason: string }> {
      return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [cliScriptPath], {
          env: { ...process.env, ANTIGRAVITY_HOOK_USER_DATA: userData },
          stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Process exited with code ${code}: ${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch (err) {
            reject(new Error(`Failed to parse stdout '${stdout}': ${err}`));
          }
        });

        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
      });
    }

    // 1. Valid execution in EXECUTE phase with approval -> allow
    const allowInput = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "src", "feature.ts") }
      },
      workspacePaths: [workspaceDir]
    };
    const allowOutput = await runCliWithPayload(allowInput);
    assert.equal(allowOutput.decision, "allow");
    assert.match(allowOutput.reason, /Mutation permitted/);

    // 2. Denied execution outside workspace -> deny
    const denyInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(tmpDir, "unauthorized.txt") }
      },
      workspacePaths: [workspaceDir]
    };
    const denyOutput = await runCliWithPayload(denyInput);
    assert.equal(denyOutput.decision, "deny");
    assert.match(denyOutput.reason, /outside any registered Cockpit workspace/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
