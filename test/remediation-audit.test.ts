import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

test("PITFALL-019: one resetLoop transition emits exactly one run-reset callback", async () => {
  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kins-run-reset-cardinality-")
  );
  const stateFilePath = path.join(tempDirectory, ".ai", "state.json");
  const service = new LoopStateService(
    stateFilePath,
    process.cwd(),
    tempDirectory
  );

  try {
    // Establish a prior non-init run so the next reset changes the run ID
    // and exercises both resetLoop() and readState() notification paths.
    const firstReset = await service.resetLoop();
    assert.equal(firstReset.success, true);

    // Prevent timestamp-based run IDs from colliding on fast systems.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    let resetNotifications = 0;
    const unsubscribe = service.onRunReset(() => {
      resetNotifications += 1;
    });

    try {
      const secondReset = await service.resetLoop();
      assert.equal(secondReset.success, true);
      assert.equal(
        resetNotifications,
        1,
        "one logical run reset must notify telemetry reset subscribers exactly once"
      );
    } finally {
      unsubscribe();
    }
  } finally {
    service.dispose();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("AQI: modified IPC production source contains no explicit any declaration or cast", () => {
  const sourcePath = path.resolve("src/main/ipc.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(
    source,
    /(?:\bas\s+any\b|:\s*any\b)/,
    "src/main/ipc.ts must use the ProjectService state contract instead of explicit any"
  );
});
