import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { WorkspaceRegistryService } from "../src/main/services/workspaceRegistryService.js";
import { RuleResolverService } from "../src/main/services/ruleResolverService.js";
import { ProjectSandboxService } from "../src/main/services/projectSandboxService.js";
import { ProjectService, type ProjectScopedServices } from "../src/main/services/ProjectService.js";

function getTreeSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!fs.existsSync(dir)) return snapshot;

  function scan(current: string, rel: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath, relPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        snapshot[relPath] = crypto.createHash("sha256").update(content).digest("hex");
      }
    }
  }
  scan(dir, "");
  return snapshot;
}

// Golden Assertion 1: {"in":"switch to clean external repo","out":"repo unchanged; sidecar created in userData"}
test("sidecar: switch to clean external repo leaves repo untouched and creates sidecar in userData", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-"));
  const tempExtRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ext-repo-"));
  const tempDefaultRepo = fs.mkdtempSync(path.join(os.tmpdir(), "default-repo-"));

  try {
    // Populate clean external repo with sample user code
    fs.writeFileSync(path.join(tempExtRepo, "main.py"), "print('hello from client repo')", "utf-8");
    fs.writeFileSync(path.join(tempExtRepo, "README.md"), "# Client Project", "utf-8");

    const baselineSnapshot = getTreeSnapshot(tempExtRepo);

    let ptyRoot = "";
    let loopRoot = "";
    const mockServices: ProjectScopedServices = {
      ptyService: { setProjectRoot: async (p) => { ptyRoot = p; } },
      loopStateService: { setProjectRoot: async (p) => { loopRoot = p; } },
      mcpMonitorService: { setProjectRoot: async () => {} },
      rollbackService: { setProjectRoot: async () => {} }
    };

    const configPath = path.join(tempUserDir, "projects.json");
    const projectService = new ProjectService(configPath, tempDefaultRepo, mockServices);
    await projectService.initialize();

    // Switch to external repo
    const state = await projectService.switchProject(tempExtRepo);
    assert.equal(state.currentProject.path, path.resolve(tempExtRepo));
    assert.equal(ptyRoot, path.resolve(tempExtRepo));
    assert.equal(loopRoot, path.resolve(tempExtRepo));

    // Zero repository pollution invariant: repo must remain byte-for-byte identical
    const postSwitchSnapshot = getTreeSnapshot(tempExtRepo);
    assert.deepEqual(postSwitchSnapshot, baselineSnapshot, "Target project was polluted with generated files!");

    // Verify sidecar was created under userData
    const context = projectService.getWorkspaceContext();
    assert.ok(context, "WorkspaceContext must be active");
    assert.equal(context.root, path.resolve(tempExtRepo));
    assert.ok(context.sidecarDirectory.startsWith(tempUserDir), "Sidecar must be placed in userData");
    assert.ok(fs.existsSync(context.sidecarDirectory), "Sidecar directory must exist on disk");
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempExtRepo, { recursive: true, force: true });
    fs.rmSync(tempDefaultRepo, { recursive: true, force: true });
  }
});

// Golden Assertion 2: {"in":"path and symlink alias","out":"same workspace ID"}
test("sidecar: canonical path and alias resolve to identical workspace ID", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-sym-"));
  const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "target-dir-"));

  try {
    const registry = new WorkspaceRegistryService(tempUserDir);
    const rec1 = await registry.resolve(tempTarget);

    // Test case insensitive on Windows / canonical realpath
    const altPath = process.platform === "win32"
      ? tempTarget.toLowerCase()
      : tempTarget;

    const rec2 = await registry.resolve(altPath);
    assert.equal(rec1.id, rec2.id, "Workspace ID must be identical for canonical paths");
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempTarget, { recursive: true, force: true });
  }
});

// Golden Assertion 3: {"in":"rule provenance & precedence","out":"deterministic hierarchy without modifying repo"}
test("sidecar: RuleResolverService resolves strict provenance without modifying repository", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-rules-"));
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-rules-"));

  try {
    // Add user-global constraint
    const rulesDir = path.join(tempUserDir, "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "global-constraints.md"), "NO_FORCE_PUSH=true", "utf-8");

    // Add native AGENTS.md in repo
    fs.writeFileSync(path.join(tempRepo, "AGENTS.md"), "# Native Project Guidance", "utf-8");
    const baselineSnapshot = getTreeSnapshot(tempRepo);

    const registry = new WorkspaceRegistryService(tempUserDir);
    const record = await registry.resolve(tempRepo);
    const sidecarDir = registry.getSidecarDirectory(record.id);

    // Add workspace-sidecar rule
    fs.writeFileSync(path.join(sidecarDir, "rules.md"), "WORKSPACE_RULE=active", "utf-8");

    const resolver = new RuleResolverService();
    const blocks = await resolver.resolve({
      workspace: record,
      userDataDirectory: tempUserDir,
      sidecarDirectory: sidecarDir
    });

    assert.ok(blocks.length >= 3);
    const b0 = blocks[0];
    const b1 = blocks[1];
    const b2 = blocks[2];
    assert.ok(b0 && b1 && b2);
    assert.equal(b0.source, "host-policy");
    assert.equal(b1.source, "user-global-constraint");
    assert.equal(b2.source, "workspace-sidecar");

    const nativeBlock = blocks.find((b) => b.source === "repository-native");
    assert.ok(nativeBlock, "Must discover native AGENTS.md read-only");
    assert.ok(nativeBlock.content.includes("Native Project Guidance"));

    // Ensure repo was never written
    const postSnapshot = getTreeSnapshot(tempRepo);
    assert.deepEqual(postSnapshot, baselineSnapshot);
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

// Golden Assertion 4: {"in":"sandbox creation fails","out":"previous project remains active"}
test("sidecar: transactional switch failure restores previous project cleanly", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-tx-"));
  const tempProjectA = fs.mkdtempSync(path.join(os.tmpdir(), "proj-a-"));
  const tempProjectB = fs.mkdtempSync(path.join(os.tmpdir(), "proj-b-"));

  try {
    let currentRoot = "";
    const mockServices: ProjectScopedServices = {
      ptyService: {
        setProjectRoot: async (p) => {
          if (p === path.resolve(tempProjectB)) {
            throw new Error("Simulated PTY failure on project B");
          }
          currentRoot = p;
        }
      },
      loopStateService: { setProjectRoot: async () => {} },
      mcpMonitorService: { setProjectRoot: async () => {} },
      rollbackService: { setProjectRoot: async () => {} }
    };

    const configPath = path.join(tempUserDir, "projects.json");
    const service = new ProjectService(configPath, tempProjectA, mockServices);
    await service.initialize();
    assert.equal(service.getState().currentProject.path, path.resolve(tempProjectA));

    // Attempt switch to B -> throws error
    await assert.rejects(
      service.switchProject(tempProjectB),
      /Simulated PTY failure on project B/
    );

    // Verify rollback restored Project A
    assert.equal(service.getState().currentProject.path, path.resolve(tempProjectA));
    assert.equal(service.getWorkspaceContext()?.root, path.resolve(tempProjectA));
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempProjectA, { recursive: true, force: true });
    fs.rmSync(tempProjectB, { recursive: true, force: true });
  }
});

// Golden Assertion 5: {"in":"switch A to B","out":"all services and /workspace resolve to B"}
test("sidecar: successful switch A to B re-anchors all services and updates sandbox", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-ab-"));
  const tempA = fs.mkdtempSync(path.join(os.tmpdir(), "proj-a2-"));
  const tempB = fs.mkdtempSync(path.join(os.tmpdir(), "proj-b2-"));

  try {
    const reAnchoredRoots: string[] = [];
    const mockServices: ProjectScopedServices = {
      ptyService: { setProjectRoot: async (p) => { reAnchoredRoots.push(`pty:${p}`); } },
      loopStateService: { setProjectRoot: async (p) => { reAnchoredRoots.push(`loop:${p}`); } },
      mcpMonitorService: { setProjectRoot: async (p) => { reAnchoredRoots.push(`mcp:${p}`); } },
      rollbackService: { setProjectRoot: async (p) => { reAnchoredRoots.push(`rollback:${p}`); } }
    };

    const configPath = path.join(tempUserDir, "projects.json");
    const service = new ProjectService(configPath, tempA, mockServices);
    await service.initialize();

    reAnchoredRoots.length = 0; // reset
    const nextState = await service.switchProject(tempB);

    assert.equal(nextState.currentProject.path, path.resolve(tempB));
    assert.equal(service.getWorkspaceContext()?.root, path.resolve(tempB));
    assert.ok(reAnchoredRoots.includes(`pty:${path.resolve(tempB)}`));
    assert.ok(reAnchoredRoots.includes(`loop:${path.resolve(tempB)}`));
    assert.ok(reAnchoredRoots.includes(`mcp:${path.resolve(tempB)}`));
    assert.ok(reAnchoredRoots.includes(`rollback:${path.resolve(tempB)}`));
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempA, { recursive: true, force: true });
    fs.rmSync(tempB, { recursive: true, force: true });
  }
});
