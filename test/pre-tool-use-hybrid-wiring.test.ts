import { resolveLoopStatePath } from "../src/main/services/LoopStateService.js";
/**
 * test/pre-tool-use-hybrid-wiring.test.ts
 * Rigorous deterministic test suite for PreToolUse Hook Hybrid Policy and ProjectService wiring.
 * Verifies the 5 GPT Architect Golden Assertions, tamper prevention, and transactional project lifecycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  PreToolUseHookService,
  computeModeHmac,
  type EquipPreToolUseHookOptions
} from "../src/main/services/preToolUseHookService.js";
import {
  evaluatePreToolUseHook,
  type PreToolUseHookInput
} from "../src/cli/preToolUseHook.js";
import {
  evaluateWorkspaceMutationPolicy,
  isSafeDocumentationTarget
} from "../src/shared/workspaceMutationPolicy.js";
import { ProjectService } from "../src/main/services/ProjectService.js";
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
    runId: "run-hybrid-001",
    currentPhase: "INITIALIZE",
    status: "ready",
    goldenSha256: parseSha256Hex("0".repeat(64)),
    budget: { maxTransitions: 25, maxRetries: 3, maxOperations: 100 },
    usage: { transitions: 0, retries: 0, operations: 0 },
    history: [],
    resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
    resourceUsage: { ...EMPTY_RESOURCE_USAGE },
    blueprint: undefined,
    blueprintApproval: undefined,
    ...overrides
  };
}

test("GPT Assertion 1: strict mode: README.md without blueprint -> DENY", () => {
  const state = createMockState({ currentPhase: "INITIALIZE" });
  const res = evaluateWorkspaceMutationPolicy(state, ["README.md"], process.cwd(), "strict");
  assert.equal(res.allowed, false);
  assert.match(res.reason, /EXECUTE phase/);
});

test("GPT Assertion 2: docs-fast-path: docs/guide.md without blueprint -> ALLOW", () => {
  const state = createMockState({ currentPhase: "INITIALIZE" });
  const res = evaluateWorkspaceMutationPolicy(state, ["docs/guide.md"], process.cwd(), "documentation-fast-path");
  assert.equal(res.allowed, true);
  assert.equal(res.isFastPath, true);
  assert.match(res.reason, /Documentation fast path permitted/);
});

test("GPT Assertion 3: docs-fast-path: docs/LOOP.md without blueprint -> DENY", () => {
  const state = createMockState({ currentPhase: "INITIALIZE" });
  const res = evaluateWorkspaceMutationPolicy(state, ["docs/LOOP.md"], process.cwd(), "documentation-fast-path");
  assert.equal(res.allowed, false);
  assert.match(res.reason, /EXECUTE phase/);
});

test("GPT Assertion 4: docs-fast-path: AGENTS.md without blueprint -> DENY", () => {
  const state = createMockState({ currentPhase: "INITIALIZE" });
  const res = evaluateWorkspaceMutationPolicy(state, ["AGENTS.md"], process.cwd(), "documentation-fast-path");
  assert.equal(res.allowed, false);
  assert.match(res.reason, /EXECUTE phase/);
});

test("GPT Assertion 5 (Batch): README.md + src/app.ts without blueprint -> DENY", () => {
  const state = createMockState({ currentPhase: "INITIALIZE" });
  const res = evaluateWorkspaceMutationPolicy(
    state,
    ["README.md", "src/app.ts"],
    process.cwd(),
    "documentation-fast-path"
  );
  assert.equal(res.allowed, false);
  assert.match(res.reason, /EXECUTE phase/);
});

test("isSafeDocumentationTarget validates safe vs sensitive documents", () => {
  assert.equal(isSafeDocumentationTarget("README.md"), true);
  assert.equal(isSafeDocumentationTarget("readme.md"), true);
  assert.equal(isSafeDocumentationTarget("LICENSE"), true);
  assert.equal(isSafeDocumentationTarget("LICENSE.txt"), true);
  assert.equal(isSafeDocumentationTarget("docs/architecture.md"), true);
  assert.equal(isSafeDocumentationTarget("docs/sub/tutorial.txt"), true);

  // Sensitive instruction and specification files are strictly protected
  assert.equal(isSafeDocumentationTarget("AGENTS.md"), false);
  assert.equal(isSafeDocumentationTarget("GEMINI.md"), false);
  assert.equal(isSafeDocumentationTarget("CLAUDE.md"), false);
  assert.equal(isSafeDocumentationTarget("docs/LOOP.md"), false);
  assert.equal(isSafeDocumentationTarget("docs/loop.md"), false);
  assert.equal(isSafeDocumentationTarget("src/index.ts"), false);
  assert.equal(isSafeDocumentationTarget("package.json"), false);
});

test("CLI PreToolUseHook: documentation-fast-path allows README.md mutation without blueprint approval", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-hybrid-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");

    // State in INITIALIZE phase, no blueprint
    const state = createMockState({ currentPhase: "INITIALIZE" });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData,
      mutationPolicyMode: "documentation-fast-path"
    });

    // 1. Mutate README.md -> ALLOWED via fast path
    const readmeInput: PreToolUseHookInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(workspaceDir, "README.md") }
      },
      workspacePaths: [workspaceDir]
    };
    const resReadme = await evaluatePreToolUseHook(readmeInput, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(resReadme.decision, "allow");
    assert.match(resReadme.reason, /Documentation fast path/);

    // 2. Mutate AGENTS.md -> DENIED without blueprint
    const agentsInput: PreToolUseHookInput = {
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(workspaceDir, "AGENTS.md") }
      },
      workspacePaths: [workspaceDir]
    };
    const resAgents = await evaluatePreToolUseHook(agentsInput, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(resAgents.decision, "deny");
    assert.match(resAgents.reason, /(?:Blueprint has not been approved|EXECUTE phase)/);

    // 3. Mutate src/index.ts -> DENIED without blueprint
    const srcInput: PreToolUseHookInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(workspaceDir, "src", "index.ts") }
      },
      workspacePaths: [workspaceDir]
    };
    const resSrc = await evaluatePreToolUseHook(srcInput, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(resSrc.decision, "deny");
    assert.match(resSrc.reason, /(?:Blueprint has not been approved|EXECUTE phase)/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI PreToolUseHook: tampering with registry mode triggers HMAC failure -> DENY", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-tamper-test-"));
  try {
    const userData = path.join(tmpDir, "userData");
    const workspaceDir = path.join(tmpDir, "target-repo");
    const sidecarDir = path.join(userData, "workspaces", "ws-1", "sidecar", "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sidecarDir, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(sidecarDir, "state.json");
    const state = createMockState({ currentPhase: "INITIALIZE" });
    await fs.writeFile(sidecarStatePath, JSON.stringify(state), "utf-8");

    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userData,
      mutationPolicyMode: "strict"
    });

    // Manually tamper with workspaces.json without recomputing HMAC
    const registryPath = path.join(userData, "hooks", "workspaces.json");
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed.workspaces);
    assert.ok(keys.length > 0 && keys[0]);
    const canonKey = keys[0];
    parsed.workspaces[canonKey].mutationPolicyMode = "documentation-fast-path"; // tampered!
    await fs.writeFile(registryPath, JSON.stringify(parsed, null, 2), "utf-8");

    const input: PreToolUseHookInput = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: path.join(workspaceDir, "README.md") }
      },
      workspacePaths: [workspaceDir]
    };
    const res = await evaluatePreToolUseHook(input, { ANTIGRAVITY_HOOK_USER_DATA: userData });
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /HMAC signature verification failed/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ProjectService: initialize and switchProject equip and unequip PreToolUse hook transactionally", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proj-hook-test-"));
  try {
    const userDataDir = path.join(tmpDir, "userData");
    const configFile = path.join(userDataDir, "recent-projects.json");
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    await fs.mkdir(repoA, { recursive: true });
    await fs.mkdir(repoB, { recursive: true });

    const preToolUseHookService = new PreToolUseHookService();
    const mockServices = {
      ptyService: { setProjectRoot: async () => {}, setWorkspaceContext: () => {} },
      loopStateService: { setProjectRoot: async () => {} },
      mcpMonitorService: { setProjectRoot: async () => {} },
      rollbackService: { setProjectRoot: async () => {} },
      preToolUseHookService
    };

    const projectService = new ProjectService(configFile, repoA, mockServices);
    await projectService.initialize();

    // Verify repoA equipped in workspaces.json
    const registryPath = path.join(userDataDir, "hooks", "workspaces.json");
    let registryRaw = await fs.readFile(registryPath, "utf-8");
    let registry = JSON.parse(registryRaw);
    const keysA = Object.keys(registry.workspaces);
    assert.equal(keysA.length, 1);
    const firstA = keysA[0];
    assert.ok(firstA);
    assert.match(firstA, /repo-a/i);

    // Switch to repoB
    await projectService.switchProject(repoB);

    // Verify repoB equipped and repoA unequipped
    registryRaw = await fs.readFile(registryPath, "utf-8");
    registry = JSON.parse(registryRaw);
    const keysB = Object.keys(registry.workspaces);
    assert.equal(keysB.length, 1);
    const firstB = keysB[0];
    assert.ok(firstB);
    assert.match(firstB, /repo-b/i);
    assert.equal(keysB.some((k) => /repo-a/i.test(k)), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("GPT Regression 1 & 2: PreToolUseHookService resolves build-relative CLI command without userData pollution", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook spaces test-"));
  try {
    const userDataWithSpaces = path.join(tmpDir, "user data with spaces");
    const workspaceDir = path.join(tmpDir, "workspace");
    const hooksConfigPath = path.join(tmpDir, "custom-hooks.json");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(userDataWithSpaces, { recursive: true });

    const hookService = new PreToolUseHookService();
    const sidecarStatePath = path.join(userDataWithSpaces, "state.json");

    // 1. Omitted runtimeCommand with userDataPath containing spaces
    const equipped = await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userDataWithSpaces,
      hooksConfigPath
    });

    const hooksData = JSON.parse(await fs.readFile(hooksConfigPath, "utf-8"));
    const command = hooksData[PreToolUseHookService.HOOK_IDENTIFIER].PreToolUse[0].hooks[0].command;

    assert.ok(command.startsWith("node "), "Command must start with node ");
    assert.ok(command.endsWith("dist/src/cli/preToolUseHook.js") || command.endsWith("dist/src/cli/preToolUseHook.js\"") || command.endsWith("dist\src\cli\preToolUseHook.js\""), "Command must end in dist/src/cli/preToolUseHook.js");
    assert.equal(command.includes("user data with spaces"), false, "Command must not be prefixed with userDataPath");
    assert.equal(command.includes("AppData/Roaming") || command.includes("AppData\\Roaming"), false, "Command must not contain AppData/Roaming");

    // 2. Explicit runtimeCommand preserved exactly
    const customConfigPath = path.join(tmpDir, "explicit-hooks.json");
    await hookService.equipWorkspace({
      workspaceRoot: workspaceDir,
      sidecarStatePath,
      userDataPath: userDataWithSpaces,
      hooksConfigPath: customConfigPath,
      runtimeCommand: "node --custom-flag /opt/custom/hook.js"
    });

    const customHooksData = JSON.parse(await fs.readFile(customConfigPath, "utf-8"));
    const customCommand = customHooksData[PreToolUseHookService.HOOK_IDENTIFIER].PreToolUse[0].hooks[0].command;
    assert.equal(customCommand, "node --custom-flag /opt/custom/hook.js");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("GPT Regression 3, 4, 5: ProjectService resolves state.json via resolveLoopStatePath (.ai vs sidecar)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proj-state-path-test-"));
  try {
    const userDataDir = path.join(tmpDir, "userData");
    const configFile = path.join(userDataDir, "recent-projects.json");
    const repoNoAi = path.join(tmpDir, "repo-no-ai");
    const repoWithAi = path.join(tmpDir, "repo-with-ai");
    await fs.mkdir(repoNoAi, { recursive: true });
    await fs.mkdir(path.join(repoWithAi, ".ai"), { recursive: true });

    let equippedSidecarPath = "";
    const mockHookService = {
      equipWorkspace: async (opts: EquipPreToolUseHookOptions) => {
        equippedSidecarPath = opts.sidecarStatePath;
        return { hooksConfigPath: "", registryPath: "", canonicalWorkspacePath: opts.workspaceRoot, signingKey: Buffer.alloc(32) };
      },
      unequipWorkspace: async () => {}
    };

    const mockServices = {
      ptyService: { setProjectRoot: async () => {}, setWorkspaceContext: () => {} },
      loopStateService: { setProjectRoot: async () => {} },
      mcpMonitorService: { setProjectRoot: async () => {} },
      rollbackService: { setProjectRoot: async () => {} },
      preToolUseHookService: mockHookService
    };

    // 1. Initialize with repo without .ai -> uses <sidecarDir>/state/state.json
    const projectService = new ProjectService(configFile, repoNoAi, mockServices);
    await projectService.initialize();

    const normalizedNoAi = equippedSidecarPath.replaceAll("\\", "/");
    assert.match(normalizedNoAi, /\/state\/state\.json$/, "Repo without .ai must resolve to <sidecar>/state/state.json");
    assert.equal(normalizedNoAi.includes(repoNoAi.replaceAll("\\", "/")), false, "Sidecar path must not be inside foreign repo");

    // 2. Switch to repo with .ai -> uses <workspace>/.ai/state.json
    await projectService.switchProject(repoWithAi);
    const normalizedWithAi = equippedSidecarPath.replaceAll("\\", "/");
    assert.equal(
      normalizedWithAi,
      path.join(path.resolve(repoWithAi), ".ai", "state.json").replaceAll("\\", "/"),
      "Repo with .ai must resolve to <workspace>/.ai/state.json"
    );

    // 3. Switch back to repo without .ai -> candidate state path resolved to sidecar
    await projectService.switchProject(repoNoAi);
    const normalizedSwitchBack = equippedSidecarPath.replaceAll("\\", "/");
    assert.match(normalizedSwitchBack, /\/state\/state\.json$/, "Switching to repo without .ai must resolve candidate to sidecar");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PreToolUseHookService preserves an explicitly supplied empty runtime command", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hook-nullish-command-")
  );

  try {
    const workspaceRoot = path.join(tmpDir, "workspace");
    const userDataPath = path.join(tmpDir, "user data");
    const hooksConfigPath = path.join(tmpDir, "hooks.json");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(userDataPath, { recursive: true });

    await new PreToolUseHookService().equipWorkspace({
      workspaceRoot,
      sidecarStatePath: path.join(userDataPath, "state", "state.json"),
      userDataPath,
      hooksConfigPath,
      runtimeCommand: ""
    });

    const hooksData: unknown = JSON.parse(
      await fs.readFile(hooksConfigPath, "utf-8")
    );

    assert.ok(hooksData !== null && typeof hooksData === "object");

    const ownedConfiguration = Reflect.get(
      hooksData,
      PreToolUseHookService.HOOK_IDENTIFIER
    );
    assert.ok(
      ownedConfiguration !== null && typeof ownedConfiguration === "object"
    );

    const preToolUse = Reflect.get(ownedConfiguration, "PreToolUse");
    assert.ok(Array.isArray(preToolUse));
    assert.equal(preToolUse.length, 1);

    const hooks = Reflect.get(preToolUse[0], "hooks");
    assert.ok(Array.isArray(hooks));
    assert.equal(hooks.length, 1);
    assert.equal(Reflect.get(hooks[0], "command"), "");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ProjectService equips initialization and switch targets with exact authoritative state paths", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "project-exact-state-path-")
  );

  try {
    const userDataDirectory = path.join(tmpDir, "userData");
    const configFile = path.join(
      userDataDirectory,
      "recent-projects.json"
    );
    const initialRoot = path.join(tmpDir, "initial workspace");
    const candidateRoot = path.join(tmpDir, "candidate workspace");

    await fs.mkdir(initialRoot, { recursive: true });
    await fs.mkdir(candidateRoot, { recursive: true });

    const equippedOptions: EquipPreToolUseHookOptions[] = [];
    const preToolUseHookService = {
      async equipWorkspace(options: EquipPreToolUseHookOptions) {
        equippedOptions.push(options);
        return {
          hooksConfigPath: "",
          registryPath: "",
          canonicalWorkspacePath: options.workspaceRoot,
          signingKey: Buffer.alloc(32)
        };
      },
      async unequipWorkspace(): Promise<void> {}
    };

    const services = {
      ptyService: {
        async setProjectRoot(): Promise<void> {},
        setWorkspaceContext(): void {}
      },
      loopStateService: {
        async setProjectRoot(): Promise<void> {}
      },
      mcpMonitorService: {
        async setProjectRoot(): Promise<void> {}
      },
      rollbackService: {
        async setProjectRoot(): Promise<void> {}
      },
      preToolUseHookService
    };

    const projectService = new ProjectService(
      configFile,
      initialRoot,
      services
    );

    await projectService.initialize();

    const initialContext = projectService.getWorkspaceContext();
    assert.ok(initialContext);
    assert.equal(equippedOptions.length, 1);
    assert.equal(
      equippedOptions[0]?.workspaceRoot,
      initialContext.root
    );
    assert.equal(
      equippedOptions[0]?.sidecarStatePath,
      resolveLoopStatePath(
        initialContext.root,
        initialContext.sidecarDirectory
      )
    );

    await projectService.switchProject(candidateRoot);

    const candidateContext = projectService.getWorkspaceContext();
    assert.ok(candidateContext);
    assert.equal(equippedOptions.length, 2);
    assert.equal(
      equippedOptions[1]?.workspaceRoot,
      candidateContext.root
    );
    assert.equal(
      equippedOptions[1]?.sidecarStatePath,
      resolveLoopStatePath(
        candidateContext.root,
        candidateContext.sidecarDirectory
      )
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
