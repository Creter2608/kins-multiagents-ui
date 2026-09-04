import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const FLAKINESS_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'flakiness.mjs')).href;
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'runner.mjs')).href;

const {
  estimatePassAtK,
  computePassAtKDistribution,
  detectTaskFlakiness,
  filterFlakyTasks,
  injectExecutionJitter,
  injectCpuStress
} = await import(FLAKINESS_URL) as typeof import('../scripts/harness/flakiness.d.mts');

const {
  computeMetrics
} = await import(RUNNER_URL) as typeof import('../scripts/harness/runner.d.mts');

test('flakiness: estimatePassAtK calculates unbiased combinatorial estimator without overflow', () => {
  // Zero pass
  assert.strictEqual(estimatePassAtK(10, 0, 1), 0.0);
  assert.strictEqual(estimatePassAtK(10, 0, 3), 0.0);

  // All pass
  assert.strictEqual(estimatePassAtK(5, 5, 1), 1.0);
  assert.strictEqual(estimatePassAtK(5, 5, 3), 1.0);

  // n - c < k guarantees at least one pass in every k-sample subset
  assert.strictEqual(estimatePassAtK(5, 4, 2), 1.0); // 5 - 4 = 1 < 2

  // Standard HumanEval test case:
  // n = 10, c = 2, k = 2
  // 1 - (8/10 * 7/9) = 1 - 56/90 = 1 - 0.62222... = 0.3778
  const passAt2 = estimatePassAtK(10, 2, 2);
  assert.strictEqual(passAt2, 0.3778);

  // k = 1 matches c / n
  assert.strictEqual(estimatePassAtK(10, 4, 1), 0.4);

  // Validation checks
  assert.throws(() => estimatePassAtK(5, 2, 6), /cannot exceed sample size/);
  assert.throws(() => estimatePassAtK(0, 0, 1), /positive integer/);
  assert.throws(() => estimatePassAtK(5, 6, 1), /between 0 and n/);
});

test('flakiness: computePassAtKDistribution aggregates multi-task confidence curves', () => {
  const tasksWithAttempts = [
    { id: 't1', attempts: [true, true, true, false, false] }, // 3/5
    { id: 't2', attempts: [true, false, false, false, false] }, // 1/5
    { id: 't3', attempts: [true, true, true, true, true] }     // 5/5
  ];

  const dist = computePassAtKDistribution(tasksWithAttempts, [1, 3, 5]);

  // Check k=1: avg(3/5, 1/5, 5/5) = (0.6 + 0.2 + 1.0) / 3 = 0.6
  assert.strictEqual(dist[1], 0.6);

  // k=3 and k=5 are computed
  assert.ok(dist[3]! > dist[1]!, 'pass@3 should be higher than pass@1');
  assert.ok(dist[5]! >= dist[3]!, 'pass@5 should be higher than or equal to pass@3');
});

test('flakiness: detectTaskFlakiness identifies unstable non-deterministic baseline executions', async () => {
  const stableTask = { id: 'stable-task' };
  const flakyTask = { id: 'flaky-task' };

  // Always passes -> Not flaky
  const resStable = await detectTaskFlakiness(
    stableTask,
    async () => ({ passed: true }),
    { runs: 3 }
  );
  assert.strictEqual(resStable.isFlaky, false);
  assert.strictEqual(resStable.passedCount, 3);
  assert.strictEqual(resStable.failedCount, 0);
  assert.strictEqual(resStable.flakinessRate, 0.0);

  // Intermittent pass/fail -> Flaky
  let toggle = false;
  const resFlaky = await detectTaskFlakiness(
    flakyTask,
    async () => {
      toggle = !toggle;
      return { passed: toggle };
    },
    { runs: 4 }
  );
  assert.strictEqual(resFlaky.isFlaky, true);
  assert.strictEqual(resFlaky.passedCount, 2);
  assert.strictEqual(resFlaky.failedCount, 2);
  assert.strictEqual(resFlaky.flakinessRate, 0.5);
});

test('flakiness: filterFlakyTasks segregates stable and flaky tasks', () => {
  const tasks = [
    { schemaVersion: 1 as const, id: 't1', title: 'T1', kind: 'f2p' as const, command: { argv: ['echo'] as const, timeoutMs: 1000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: 't2', title: 'T2', kind: 'p2p' as const, command: { argv: ['echo'] as const, timeoutMs: 1000 }, hiddenAssertions: [] },
    { schemaVersion: 1 as const, id: 't3', title: 'T3', kind: 'p2p' as const, command: { argv: ['echo'] as const, timeoutMs: 1000 }, hiddenAssertions: [] }
  ];

  const flakinessResults = [
    { taskId: 't1', isFlaky: false, runs: 3, passedCount: 3, failedCount: 0, flakinessRate: 0 },
    { taskId: 't2', isFlaky: true, runs: 3, passedCount: 1, failedCount: 2, flakinessRate: 0.3333 },
    { taskId: 't3', isFlaky: false, runs: 3, passedCount: 3, failedCount: 0, flakinessRate: 0 }
  ];

  const filtered = filterFlakyTasks(tasks, flakinessResults);
  assert.strictEqual(filtered.stableTasks.length, 2);
  assert.strictEqual(filtered.flakyTasks.length, 1);
  assert.deepEqual(filtered.flakyTaskIds, ['t2']);
});

test('flakiness: injectExecutionJitter and injectCpuStress execute bounded stress tests', async () => {
  const delay = await injectExecutionJitter({ minMs: 5, maxMs: 15 });
  assert.ok(delay >= 5 && delay <= 15, `Delay ${delay} should be within [5, 15]`);

  const ops = injectCpuStress(20);
  assert.ok(ops > 0, 'CPU stress should complete operations');
});

test('flakiness: computeMetrics integrates k, passAtKDistributions, and flakyTaskIds', () => {
  const results = [
    {
      id: 'task-1',
      kind: 'f2p' as const,
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    },
    {
      id: 'task-2',
      kind: 'p2p' as const,
      base: { exitCode: 0, passed: true, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    }
  ];

  const metrics = computeMetrics(results, {
    k: 3,
    passAtK: 0.9,
    passAtKDistributions: { 1: 0.8, 3: 0.9, 5: 0.95 },
    flakyTaskIds: ['flaky-1']
  });

  assert.strictEqual(metrics.passAt1, 1.0);
  assert.strictEqual(metrics.passAtK, 0.9);
  assert.strictEqual(metrics.k, 3);
  assert.deepEqual(metrics.passAtKDistributions, { 1: 0.8, 3: 0.9, 5: 0.95 });
  assert.deepEqual(metrics.flakyTaskIds, ['flaky-1']);
});
