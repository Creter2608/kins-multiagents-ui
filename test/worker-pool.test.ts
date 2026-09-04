import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const POOL_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "worker-pool.mjs")).href;
const {
  validatePoolOptions,
  runTaskPool
} = await import(POOL_URL) as typeof import("../scripts/harness/worker-pool.d.mts");

test("worker-pool: validatePoolOptions validates concurrency and network bounds", () => {
  const valid = validatePoolOptions({ concurrency: 4, taskTimeoutMs: 10000 });
  assert.equal(valid.valid, true);

  const invalidConcurrency = validatePoolOptions({ concurrency: 0 });
  assert.equal(invalidConcurrency.valid, false);
  assert.match(invalidConcurrency.errors[0]!, /concurrency must be an integer between 1 and 32/);

  const tooHighConcurrency = validatePoolOptions({ concurrency: 64 });
  assert.equal(tooHighConcurrency.valid, false);

  const invalidTimeout = validatePoolOptions({ taskTimeoutMs: -1 });
  assert.equal(invalidTimeout.valid, false);
  assert.match(invalidTimeout.errors[0]!, /taskTimeoutMs must be a positive integer/);
});

test("worker-pool: bounded concurrency ceiling (peakWorkers <= concurrency)", async () => {
  const taskCount = 16;
  const concurrencyCeiling = 4;

  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    schemaVersion: 1 as const,
    id: `task-${String(i).padStart(3, "0")}`,
    title: `Concurrent task ${i}`,
    kind: (i % 2 === 0 ? "f2p" : "p2p") as "f2p" | "p2p",
    command: { argv: ["node", "-v"] as const, timeoutMs: 5000 },
    hiddenAssertions: []

  }));

  const executionLog: string[] = [];

  const batchResult = await runTaskPool(
    tasks,
    async (task, workerCtx) => {
      executionLog.push(`start:${task.id}:${workerCtx.workerId}`);
      // Simulate non-trivial work
      await new Promise((r) => setTimeout(r, 20));
      executionLog.push(`finish:${task.id}:${workerCtx.workerId}`);

      return {
        taskResult: {
          id: task.id,
          kind: task.kind,
          base: { exitCode: task.kind === "f2p" ? 1 : 0, passed: task.kind !== "f2p", signal: null, timedOut: false },
          current: { exitCode: 0, passed: true, signal: null, timedOut: false },
          passed: true
        },
        attempt: {
          runId: workerCtx.runId,
          taskId: task.id,
          attempt: 1,
          workerId: workerCtx.workerId,
          containerId: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tokenUsage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, source: "unavailable" as const },
          cost: null
        }
      };
    },
    { concurrency: concurrencyCeiling }
  );

  assert.equal(batchResult.results.length, taskCount);
  assert.equal(batchResult.passed, true);
  assert.ok(batchResult.peakWorkers <= concurrencyCeiling, `Peak workers (${batchResult.peakWorkers}) must not exceed ceiling (${concurrencyCeiling})`);
  assert.ok(batchResult.peakWorkers > 1, "Peak workers should demonstrate concurrent execution");

  // Verify exact deterministic output ordering
  for (let i = 0; i < taskCount; i++) {
    assert.equal(batchResult.results[i]!.id, `task-${String(i).padStart(3, "0")}`);
  }
});

test("worker-pool: guarantees deterministic input ordering despite asynchronous completion order", async () => {
  // Task 0 takes 60ms, Task 1 takes 30ms, Task 2 takes 5ms
  const tasks = [
    { schemaVersion: 1 as const, id: "task-slow", title: "Slow", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: "task-med", title: "Med", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: "task-fast", title: "Fast", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] }
  ];

  const delays: Record<string, number> = {
    "task-slow": 60,
    "task-med": 30,
    "task-fast": 5
  };

  const completionOrder: string[] = [];

  const batch = await runTaskPool(
    tasks,
    async (task, workerCtx) => {
      const delay = delays[task.id] || 10;
      await new Promise((r) => setTimeout(r, delay));
      completionOrder.push(task.id);

      return {
        taskResult: {
          id: task.id,
          kind: task.kind,
          base: { exitCode: 0, passed: true, signal: null, timedOut: false },
          current: { exitCode: 0, passed: true, signal: null, timedOut: false },
          passed: true
        },
        attempt: {
          runId: workerCtx.runId,
          taskId: task.id,
          attempt: 1,
          workerId: workerCtx.workerId,
          containerId: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: "unavailable" as const },
          cost: null
        }
      };
    },
    { concurrency: 3 }
  );

  // Completion order should be Fast -> Med -> Slow
  assert.equal(completionOrder[0], "task-fast");
  assert.equal(completionOrder[1], "task-med");
  assert.equal(completionOrder[2], "task-slow");

  // BUT batch results MUST preserve original task array order: Slow -> Med -> Fast
  assert.equal(batch.results[0]!.id, "task-slow");
  assert.equal(batch.results[1]!.id, "task-med");
  assert.equal(batch.results[2]!.id, "task-fast");
});

test("worker-pool: abortSignal stops admitting new tasks gracefully", async () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({
    schemaVersion: 1 as const,
    id: `abort-task-${i}`,
    title: `Task ${i}`,
    kind: "p2p" as const,
    command: { argv: ["node", "-v"] as const, timeoutMs: 5000 },
    hiddenAssertions: []
  }));

  const abortController = new AbortController();
  let executedCount = 0;

  const batch = await runTaskPool(
    tasks,
    async (task, workerCtx) => {
      executedCount++;
      if (executedCount === 2) {
        abortController.abort();
      }
      await new Promise((r) => setTimeout(r, 20));

      return {
        taskResult: {
          id: task.id,
          kind: task.kind,
          base: { exitCode: 0, passed: true, signal: null, timedOut: false },
          current: { exitCode: 0, passed: true, signal: null, timedOut: false },
          passed: true
        },
        attempt: {
          runId: workerCtx.runId,
          taskId: task.id,
          attempt: 1,
          workerId: workerCtx.workerId,
          containerId: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: "unavailable" as const },
          cost: null
        }
      };
    },
    { concurrency: 2, abortSignal: abortController.signal }
  );

  assert.equal(batch.results.length, 8);
  assert.ok(executedCount < 8, "Abort should prevent admitting all 8 tasks");
  assert.equal(batch.passed, false, "Aborted batch should not pass overall");
});

test("worker-pool: error isolation converts single task crash into failure without crashing pool", async () => {
  const tasks = [
    { schemaVersion: 1 as const, id: "task-ok-1", title: "OK 1", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: "task-crash", title: "Crash", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: "task-ok-2", title: "OK 2", kind: "p2p" as const, command: { argv: ["node", "-v"] as const, timeoutMs: 5000 }, hiddenAssertions: [] }
  ];

  const batch = await runTaskPool(
    tasks,
    async (task, workerCtx) => {
      if (task.id === "task-crash") {
        throw new Error("Simulated unhandled worker crash");
      }

      return {
        taskResult: {
          id: task.id,
          kind: task.kind,
          base: { exitCode: 0, passed: true, signal: null, timedOut: false },
          current: { exitCode: 0, passed: true, signal: null, timedOut: false },
          passed: true
        },
        attempt: {
          runId: workerCtx.runId,
          taskId: task.id,
          attempt: 1,
          workerId: workerCtx.workerId,
          containerId: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: "unavailable" as const },
          cost: null
        }
      };
    },
    { concurrency: 2 }
  );

  assert.equal(batch.results.length, 3);
  assert.equal(batch.results[0]!.passed, true);
  assert.equal(batch.results[1]!.passed, false); // Crashed task handled gracefully
  assert.equal(batch.results[2]!.passed, true);  // Other tasks continue and pass
  assert.equal(batch.passed, false);
});
