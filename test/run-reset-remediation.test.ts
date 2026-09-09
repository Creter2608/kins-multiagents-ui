import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateRunResetTransition } from "../src/main/services/LoopStateService.js";

test("run reset: init to first real run emits exactly once", () => {
  const first = evaluateRunResetTransition({
    previousRunId: "init",
    nextRunId: "run-001",
    previousPhase: "INITIALIZE",
    nextPhase: "INITIALIZE",
    lastNotifiedRunId: null
  });

  assert.deepEqual(first, {
    notify: true,
    lastNotifiedRunId: "run-001"
  });

  const repeatedSnapshot = evaluateRunResetTransition({
    previousRunId: "run-001",
    nextRunId: "run-001",
    previousPhase: "INITIALIZE",
    nextPhase: "INITIALIZE",
    lastNotifiedRunId: first.lastNotifiedRunId
  });

  assert.deepEqual(repeatedSnapshot, {
    notify: false,
    lastNotifiedRunId: "run-001"
  });
});

test("run reset: run ID change followed by INITIALIZE does not double-notify", () => {
  const runIdChange = evaluateRunResetTransition({
    previousRunId: "run-001",
    nextRunId: "run-002",
    previousPhase: "COMPLETE",
    nextPhase: "COMPLETE",
    lastNotifiedRunId: "run-001"
  });

  assert.equal(runIdChange.notify, true);
  assert.equal(runIdChange.lastNotifiedRunId, "run-002");

  const subsequentInitialize = evaluateRunResetTransition({
    previousRunId: "run-002",
    nextRunId: "run-002",
    previousPhase: "COMPLETE",
    nextPhase: "INITIALIZE",
    lastNotifiedRunId: runIdChange.lastNotifiedRunId
  });

  assert.deepEqual(subsequentInitialize, {
    notify: false,
    lastNotifiedRunId: "run-002"
  });
});

test("IPC project switch handlers rely on the canonical project-switched callback", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "src/main/ipc.ts"),
    "utf8"
  );

  const switchStart = source.indexOf('ipcMain.handle("project:switch"');
  const openFolderStart = source.indexOf(
    'ipcMain.handle("project:open-folder"',
    switchStart
  );
  const terminalStart = source.indexOf("// Terminal", openFolderStart);

  assert.notEqual(switchStart, -1, "project:switch handler must exist");
  assert.notEqual(openFolderStart, -1, "project:open-folder handler must exist");
  assert.notEqual(terminalStart, -1, "project handler section terminator must exist");

  const switchHandler = source.slice(switchStart, openFolderStart);
  const openFolderHandler = source.slice(openFolderStart, terminalStart);

  assert.equal(
    switchHandler.includes("broadcastProjectSwitch("),
    false,
    "project:switch must not broadcast after switchProject already invokes the canonical callback"
  );

  assert.equal(
    openFolderHandler.includes("broadcastProjectSwitch("),
    false,
    "project:open-folder must not broadcast after switchProject already invokes the canonical callback"
  );
});
