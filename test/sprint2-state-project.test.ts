import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ProjectService } from "../src/main/services/ProjectService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

test("ARCH-2: ProjectService switches project and updates evalHarnessService root", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprint2-proj-"));
  const subProjA = path.join(tmpDir, "proj-a");
  const subProjB = path.join(tmpDir, "proj-b");
  await fs.mkdir(subProjA, { recursive: true });
  await fs.mkdir(subProjB, { recursive: true });

  const repointedPaths = {
    pty: [] as string[],
    loop: [] as string[],
    mcp: [] as string[],
    rollback: [] as string[],
    eval: [] as string[]
  };

  const mockServices = {
    ptyService: {
      async setProjectRoot(p: string) { repointedPaths.pty.push(p); }
    },
    loopStateService: {
      async setProjectRoot(p: string) { repointedPaths.loop.push(p); }
    },
    mcpMonitorService: {
      async setProjectRoot(p: string) { repointedPaths.mcp.push(p); }
    },
    rollbackService: {
      async setProjectRoot(p: string) { repointedPaths.rollback.push(p); }
    },
    evalHarnessService: {
      async setProjectRoot(p: string) { repointedPaths.eval.push(p); }
    }
  };

  const configFile = path.join(tmpDir, "recent.json");
  const projectService = new ProjectService(configFile, subProjA, mockServices);

  await projectService.initialize();
  assert.equal(repointedPaths.eval.length, 1);
  assert.equal(repointedPaths.eval[0], path.resolve(subProjA));

  await projectService.switchProject(subProjB);
  assert.equal(repointedPaths.eval.length, 2);
  assert.equal(repointedPaths.eval[1], path.resolve(subProjB));
  assert.equal(repointedPaths.loop[1], path.resolve(subProjB));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("ARCH-3: LoopStateService uses FileLock safely during reset and transitions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprint2-loop-"));
  const stateFile = path.join(tmpDir, ".ai", "state.json");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });

  const loopService = new LoopStateService(stateFile);
  const resetRes = await loopService.resetLoop("run-sprint2-test");
  assert.equal(resetRes.success, true);
  assert.equal(resetRes.state?.runId, "run-sprint2-test");
  assert.equal(resetRes.state?.currentPhase, "INITIALIZE");

  // Verify lock file is cleaned up
  assert.equal(await fs.stat(stateFile + ".lock").catch(() => null), null);

  // Transition through a phase
  const advanceOk = loopService.advanceToPhase("SPEC_GATE", "test advance");
  assert.equal(advanceOk, true);
  assert.equal(loopService.getSnapshot().currentPhase, "SPEC_GATE");
  assert.equal(await fs.stat(stateFile + ".lock").catch(() => null), null);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
