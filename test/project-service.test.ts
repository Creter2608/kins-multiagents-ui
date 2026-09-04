import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectService, type ProjectScopedServices } from "../src/main/services/ProjectService.js";

function createMockServices(): {
  services: ProjectScopedServices;
  calls: { pty: string[]; loop: string[]; mcp: string[]; rollback: string[] };
} {
  const calls = {
    pty: [] as string[],
    loop: [] as string[],
    mcp: [] as string[],
    rollback: [] as string[]
  };

  const services: ProjectScopedServices = {
    ptyService: {
      setProjectRoot: async (p: string) => {
        calls.pty.push(p);
      }
    },
    loopStateService: {
      setProjectRoot: async (p: string) => {
        calls.loop.push(p);
      }
    },
    mcpMonitorService: {
      setProjectRoot: async (p: string) => {
        calls.mcp.push(p);
      }
    },
    rollbackService: {
      setProjectRoot: async (p: string) => {
        calls.rollback.push(p);
      }
    }
  };

  return { services, calls };
}

test("ProjectService: missing config -> default root active, all services repointed, state persisted", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-svc-test-"));
  const defaultDir = path.join(tempDir, "project-a");
  fs.mkdirSync(defaultDir, { recursive: true });
  const configFile = path.join(tempDir, "recent-projects.json");

  try {
    const { services, calls } = createMockServices();
    const service = new ProjectService(configFile, defaultDir, services);

    const state = await service.initialize();

    assert.equal(state.currentProject.path, path.resolve(defaultDir));
    assert.equal(state.currentProject.name, "project-a");
    assert.equal(state.recentProjects.length, 1);
    assert.equal(state.recentProjects[0]?.path, path.resolve(defaultDir));

    // Check all services received the path
    assert.deepEqual(calls.pty, [path.resolve(defaultDir)]);
    assert.deepEqual(calls.loop, [path.resolve(defaultDir)]);
    assert.deepEqual(calls.mcp, [path.resolve(defaultDir)]);
    assert.deepEqual(calls.rollback, [path.resolve(defaultDir)]);

    // Check persistence
    assert.ok(fs.existsSync(configFile));
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(saved.currentProjectPath, path.resolve(defaultDir));
    assert.deepEqual(saved.recentProjects, [path.resolve(defaultDir)]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ProjectService: switch /tmp/a -> /tmp/b -> b active, recents [b, a], persisted", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-svc-test-"));
  const dirA = path.join(tempDir, "project-a");
  const dirB = path.join(tempDir, "project-b");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const configFile = path.join(tempDir, "recent-projects.json");

  try {
    const { services, calls } = createMockServices();
    const service = new ProjectService(configFile, dirA, services);
    await service.initialize();

    // Switch to B
    const stateB = await service.switchProject(dirB);

    assert.equal(stateB.currentProject.path, path.resolve(dirB));
    assert.equal(stateB.currentProject.name, "project-b");
    assert.equal(stateB.recentProjects.length, 2);
    assert.equal(stateB.recentProjects[0]?.path, path.resolve(dirB));
    assert.equal(stateB.recentProjects[1]?.path, path.resolve(dirA));

    // Verify services received dirB as second call
    assert.deepEqual(calls.pty, [path.resolve(dirA), path.resolve(dirB)]);
    assert.deepEqual(calls.loop, [path.resolve(dirA), path.resolve(dirB)]);
    assert.deepEqual(calls.mcp, [path.resolve(dirA), path.resolve(dirB)]);
    assert.deepEqual(calls.rollback, [path.resolve(dirA), path.resolve(dirB)]);

    // Check persistence
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(saved.currentProjectPath, path.resolve(dirB));
    assert.deepEqual(saved.recentProjects, [path.resolve(dirB), path.resolve(dirA)]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ProjectService: switch again to /tmp/a -> recents [a, b] without duplicate", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-svc-test-"));
  const dirA = path.join(tempDir, "project-a");
  const dirB = path.join(tempDir, "project-b");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const configFile = path.join(tempDir, "recent-projects.json");

  try {
    const { services } = createMockServices();
    const service = new ProjectService(configFile, dirA, services);
    await service.initialize();
    await service.switchProject(dirB);

    // Switch back to A
    const stateA = await service.switchProject(dirA);

    assert.equal(stateA.currentProject.path, path.resolve(dirA));
    assert.equal(stateA.recentProjects.length, 2);
    assert.equal(stateA.recentProjects[0]?.path, path.resolve(dirA));
    assert.equal(stateA.recentProjects[1]?.path, path.resolve(dirB));

    // Check persistence
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(saved.currentProjectPath, path.resolve(dirA));
    assert.deepEqual(saved.recentProjects, [path.resolve(dirA), path.resolve(dirB)]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ProjectService: malformed config -> safe fallback to default root and re-pointed", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-svc-test-"));
  const defaultDir = path.join(tempDir, "default-proj");
  fs.mkdirSync(defaultDir, { recursive: true });
  const configFile = path.join(tempDir, "recent-projects.json");

  fs.writeFileSync(configFile, "{ invalid json corrupted", "utf-8");

  try {
    const { services, calls } = createMockServices();
    const service = new ProjectService(configFile, defaultDir, services);
    const state = await service.initialize();

    assert.equal(state.currentProject.path, path.resolve(defaultDir));
    assert.deepEqual(calls.pty, [path.resolve(defaultDir)]);

    // Verify config was repaired
    const saved = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(saved.currentProjectPath, path.resolve(defaultDir));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ProjectService: nonexistent path -> reject; state, file, services unchanged", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-svc-test-"));
  const dirA = path.join(tempDir, "project-a");
  const nonexistent = path.join(tempDir, "ghost-dir");
  fs.mkdirSync(dirA, { recursive: true });
  const configFile = path.join(tempDir, "recent-projects.json");

  try {
    const { services, calls } = createMockServices();
    const service = new ProjectService(configFile, dirA, services);
    await service.initialize();

    await assert.rejects(
      async () => {
        await service.switchProject(nonexistent);
      },
      {
        message: /Directory does not exist/
      }
    );

    // State remains dirA
    assert.equal(service.getState().currentProject.path, path.resolve(dirA));
    assert.equal(service.getState().recentProjects.length, 1);

    // Services only called once during initialize
    assert.equal(calls.pty.length, 1);
    assert.equal(calls.pty[0], path.resolve(dirA));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
