/**
 * scripts/harness/worker-pool.mjs
 * Parallel Worker Pool & Ephemeral Container Orchestration Engine.
 * Schedules benchmark tasks across bounded concurrent workers while guaranteeing
 * isolated worktrees, zero cross-contamination, deterministic output ordering,
 * and graceful cancellation.
 */

import * as os from 'node:os';
import * as process from 'node:process';
import { validateNetworkPolicy } from './network-policy.mjs';
import { computeMetrics } from './runner.mjs';

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 4, 8));
const MAX_CONCURRENCY = 32;

/**
 * Validates pool options.
 */
export function validatePoolOptions(options = {}) {
  const errors = [];
  if (options && typeof options !== 'object') {
    return { valid: false, errors: ['Pool options must be an object'] };
  }

  if (options.concurrency !== undefined) {
    const c = Number(options.concurrency);
    if (!Number.isInteger(c) || c < 1 || c > MAX_CONCURRENCY) {
      errors.push(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
    }
  }

  if (options.taskTimeoutMs !== undefined) {
    const t = Number(options.taskTimeoutMs);
    if (!Number.isInteger(t) || t < 1) {
      errors.push('taskTimeoutMs must be a positive integer');
    }
  }

  if (options.networkPolicy !== undefined) {
    const polCheck = validateNetworkPolicy(options.networkPolicy);
    if (!polCheck.valid) {
      errors.push(...polCheck.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Runs a list of benchmark tasks through a bounded worker pool.
 */
export async function runTaskPool(tasks, taskExecutor, options = {}) {
  const val = validatePoolOptions(options);
  if (!val.valid) {
    throw new Error(`Invalid pool options: ${val.errors.join('; ')}`);
  }

  if (!Array.isArray(tasks)) {
    throw new TypeError('tasks must be an array of benchmark tasks');
  }
  if (typeof taskExecutor !== 'function') {
    throw new TypeError('taskExecutor must be a function');
  }

  const runId = options.runId || `pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const repoRoot = options.repoRoot || process.cwd();
  const baseCommit = options.baseCommit || 'HEAD';
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || DEFAULT_CONCURRENCY), MAX_CONCURRENCY));
  const abortSignal = options.abortSignal;

  if (tasks.length === 0) {
    return {
      runId,
      results: [],
      attempts: [],
      metrics: { passAt1: 0, passAtK: 0, k: 1, ssi: 0 },
      passed: true,
      peakWorkers: 0
    };
  }

  const results = new Array(tasks.length);
  const attempts = new Array(tasks.length);

  let nextTaskIndex = 0;
  let activeWorkers = 0;
  let peakWorkers = 0;

  async function workerLoop(workerId) {
    while (nextTaskIndex < tasks.length) {
      if (abortSignal?.aborted) {
        break;
      }

      const currentIndex = nextTaskIndex++;
      const currentTask = tasks[currentIndex];
      if (!currentTask) break;

      activeWorkers++;
      peakWorkers = Math.max(peakWorkers, activeWorkers);

      const workerCtx = {
        workerId,
        runId,
        attemptIndex: currentIndex,
        repoRoot,
        baseCommit,
        sandbox: options.sandbox,
        networkPolicy: options.networkPolicy
      };

      try {
        const outcome = await taskExecutor(currentTask, workerCtx);
        results[currentIndex] = outcome.taskResult;
        attempts[currentIndex] = outcome.attempt;
      } catch (err) {
        // Infrastructure or task failure isolated to this attempt
        results[currentIndex] = {
          id: currentTask.id,
          kind: currentTask.kind,
          base: { exitCode: 1, passed: false, signal: null, timedOut: false },
          current: { exitCode: 1, passed: false, signal: null, timedOut: false },
          passed: false
        };
        attempts[currentIndex] = {
          runId,
          taskId: currentTask.id,
          attempt: 1,
          workerId,
          containerId: '',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'unavailable' },
          cost: null
        };
      } finally {
        activeWorkers--;
      }
    }
  }

  // Spawn concurrent worker loops up to min(concurrency, tasks.length)
  const actualWorkers = Math.min(concurrency, tasks.length);
  const workerPromises = [];
  for (let w = 1; w <= actualWorkers; w++) {
    workerPromises.push(workerLoop(`worker-${w}`));
  }

  await Promise.all(workerPromises);

  // Fill in any remaining slots if aborted
  for (let i = 0; i < tasks.length; i++) {
    if (!results[i]) {
      const task = tasks[i];
      results[i] = {
        id: task.id,
        kind: task.kind,
        base: { exitCode: null, passed: false, signal: 'ABORT', timedOut: false },
        current: { exitCode: null, passed: false, signal: 'ABORT', timedOut: false },
        passed: false
      };
      attempts[i] = {
        runId,
        taskId: task.id,
        attempt: 1,
        workerId: 'aborted',
        containerId: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'unavailable' },
        cost: null
      };
    }
  }

  const metrics = computeMetrics(results);
  const hasF2P = results.some(r => r.kind === 'f2p');
  const hasP2P = results.some(r => r.kind === 'p2p');
  const allPassed = results.every(r => r.passed);
  const passed = hasF2P && hasP2P && allPassed;

  return {
    runId,
    results,
    attempts,
    metrics,
    passed,
    peakWorkers
  };
}
