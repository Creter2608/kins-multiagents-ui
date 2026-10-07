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
  type PreToolUseHookInput,
  DEFAULT_SOURCE_READ_TOKEN_THRESHOLD,
  estimateFileTokens,
  isSourceCodePath
} from "../src/cli/preToolUseHook.js";
import { bindEnforcedPhaseTemplate } from "../src/shared/phaseTemplateBinding.js";
import { RuleBundleCompilerService } from "../src/main/services/ruleBundleCompilerService.js";
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

    const hooksConfigPath = path.join(tmpDir, "hooks.json");
    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData,
      hooksConfigPath
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

test("Read-Gate Golden Assertion 1: view_file on non-source file (markdown/json) -> allowed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-read-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    // Enable CodeGraph in workspace
    await fs.mkdir(path.join(workspaceDir, ".codegraph"), { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    await fs.writeFile(sidecarStatePath, JSON.stringify(createMockState()), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    // Write a large README.md (e.g. 5000 bytes)
    const readmePath = path.join(workspaceDir, "README.md");
    await fs.writeFile(readmePath, "# Large Documentation\n" + "hello world\n".repeat(400), "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: readmePath }
      },
      workspacePaths: [workspaceDir],
      runId: "run-test-001"
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "allow");
    assert.match(res.reason, /not a source code file/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Read-Gate Golden Assertion 2: view_file on small source file <= 200 tokens -> allowed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-read-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    await fs.mkdir(path.join(workspaceDir, ".codegraph"), { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    await fs.writeFile(sidecarStatePath, JSON.stringify(createMockState()), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    // Small source file (approx 100 bytes = ~25 tokens <= 200)
    const smallFilePath = path.join(workspaceDir, "src", "small.ts");
    await fs.mkdir(path.dirname(smallFilePath), { recursive: true });
    await fs.writeFile(smallFilePath, "export const PI = 3.14159;\nexport const E = 2.71828;\n", "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: smallFilePath }
      },
      workspacePaths: [workspaceDir],
      runId: "run-test-001"
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "allow");
    assert.match(res.reason, /within low-token threshold/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Read-Gate Golden Assertion 3: view_file on large source file in CodeGraph workspace without exploration -> denied", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-read-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    // Enable CodeGraph
    await fs.mkdir(path.join(workspaceDir, ".codegraph"), { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    await fs.writeFile(sidecarStatePath, JSON.stringify(createMockState()), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    // Large source file: 2000 bytes => ~500 tokens > 200
    const largeFilePath = path.join(workspaceDir, "src", "big.ts");
    await fs.mkdir(path.dirname(largeFilePath), { recursive: true });
    await fs.writeFile(largeFilePath, "export function doSomething(): void {\n" + "  console.log('line');\n".repeat(100) + "}\n", "utf-8");

    const stat = await fs.stat(largeFilePath);
    const expectedTokens = Math.ceil(stat.size / 4);

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: largeFilePath }
      },
      workspacePaths: [workspaceDir],
      runId: "run-test-001"
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
    assert.equal(
      res.reason,
      `Anti-Token-Drain Protocol: view_file denied for a large source file in a CodeGraph-enabled workspace; run codegraph_explore in the current run before requesting the full file (estimatedTokens=${expectedTokens}, threshold=200).`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Read-Gate Golden Assertion 4: view_file on large source file after recordCodeGraphExploration -> allowed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-read-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    await fs.mkdir(path.join(workspaceDir, ".codegraph"), { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    await fs.writeFile(sidecarStatePath, JSON.stringify(createMockState()), "utf-8");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    // Record exploration evidence
    await PreToolUseHookService.recordCodeGraphExploration(
      workspaceDir,
      "run-test-001",
      userData,
      equipped.signingKey
    );

    const largeFilePath = path.join(workspaceDir, "src", "big.ts");
    await fs.mkdir(path.dirname(largeFilePath), { recursive: true });
    await fs.writeFile(largeFilePath, "export function doSomething(): void {\n" + "  console.log('line');\n".repeat(100) + "}\n", "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: largeFilePath }
      },
      workspacePaths: [workspaceDir],
      runId: "run-test-001"
    };

    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "allow");
    assert.match(res.reason, /CodeGraph exploration verified/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Read-Gate Golden Assertion 5: resolveCodeGraphReadGate returns accurate exploration status", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-read-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".codegraph"), { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    await fs.writeFile(sidecarStatePath, JSON.stringify(createMockState()), "utf-8");

    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData
    });

    const targetFile = path.join(workspaceDir, "src", "index.ts");

    // Before exploration
    const before = await hookService.resolveCodeGraphReadGate({
      canonicalTargetPath: targetFile,
      runId: "run-test-001",
      userDataPath: userData
    });
    assert.equal(before.codeGraphActive, true);
    assert.equal(before.exploredInCurrentRun, false);

    // After exploration
    await PreToolUseHookService.recordCodeGraphExploration(
      workspaceDir,
      "run-test-001",
      userData,
      equipped.signingKey
    );

    const after = await hookService.resolveCodeGraphReadGate({
      canonicalTargetPath: targetFile,
      runId: "run-test-001",
      userDataPath: userData
    });
    assert.equal(after.codeGraphActive, true);
    assert.equal(after.exploredInCurrentRun, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Phase Template Golden Assertion: compilation and deterministic binding wrapper", () => {
  const compiler = new RuleBundleCompilerService();
  const bundle = compiler.compileUniversalRules();

  assert.ok(bundle.phaseTemplates);
  assert.ok(bundle.phaseTemplates.PLAN);
  assert.ok(bundle.phaseTemplates.EXECUTE);
  assert.ok(bundle.phaseTemplates.VERIFY);

  assert.equal(bundle.phaseTemplates.PLAN.phase, "PLAN");
  assert.equal(bundle.phaseTemplates.PLAN.templateId, "plan-document-reviewer-prompt");
  assert.match(bundle.phaseTemplates.PLAN.sha256, /^[a-f0-9]{64}$/);

  const boundPlan = bindEnforcedPhaseTemplate("PLAN", bundle.phaseTemplates.PLAN);
  assert.match(boundPlan, /^<enforced-superpowers-template phase="PLAN" id="plan-document-reviewer-prompt" sha256="[a-f0-9]{64}">/);
  assert.match(boundPlan, /<\/enforced-superpowers-template>$/);
});

