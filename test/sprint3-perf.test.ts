import test from "node:test";
import * as assert from "node:assert/strict";
import { DockerStatusService } from "../src/main/services/DockerStatusService.js";

test("REL-1: DockerStatusService backs off exponentially on missing/unavailable container", async () => {
  const service = new DockerStatusService("non_existent_sandbox_container_12345", 2000);
  assert.equal(service.getCurrentIntervalMs(), 2000);

  // First check: container doesn't exist -> Missing / Unavailable
  await service.checkStatus();
  assert.equal(["Missing", "Unavailable"].includes(service.getStatus()), true);

  // Interval should have backed off by 1.5x (2000 * 1.5 = 3000)
  assert.equal(service.getCurrentIntervalMs(), 3000);

  // Second check: backs off again (3000 * 1.5 = 4500)
  await service.checkStatus();
  assert.equal(service.getCurrentIntervalMs(), 4500);

  service.dispose();
});
