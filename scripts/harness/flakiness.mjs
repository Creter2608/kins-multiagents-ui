/**
 * scripts/harness/flakiness.mjs
 * Flakiness Filter & Pass@k Statistical Sampling Engine.
 * Implements unbiased pass@k statistical estimators (Chen et al. / HumanEval),
 * pre-flight baseline flakiness detection, execution jitter, and CPU stress injection.
 */

import * as crypto from 'node:crypto';

/**
 * Calculates unbiased pass@k estimate for a single task given n attempts, c passes, and k selection size.
 * Uses product formulation to prevent combinatorial integer overflow:
 * pass@k = 1 - \prod_{i=1}^{k} (n - c - i + 1) / (n - i + 1)
 *
 * @param {number} n Total generated attempts for the task (n >= 1)
 * @param {number} c Total passing attempts (0 <= c <= n)
 * @param {number} k Evaluation budget size (1 <= k <= n)
 * @returns {number}
 */
export function estimatePassAtK(n, c, k) {
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`n must be a positive integer, got ${n}`);
  }
  if (!Number.isInteger(c) || c < 0 || c > n) {
    throw new TypeError(`c must be an integer between 0 and n (${n}), got ${c}`);
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new TypeError(`k must be an integer >= 1, got ${k}`);
  }

  if (k > n) {
    throw new Error(`k (${k}) cannot exceed sample size n (${n})`);
  }

  if (c === 0) {
    return 0.0;
  }

  if (n - c < k) {
    return 1.0;
  }

  let product = 1.0;
  for (let i = 1; i <= k; i++) {
    product *= (n - c - i + 1) / (n - i + 1);
  }

  const result = 1.0 - product;
  return Math.round(result * 10000) / 10000;
}

/**
 * Computes average pass@k distributions across multiple tasks for specified k values.
 *
 * @param {Array<{ id: string, attempts: boolean[] }>} tasksWithAttempts
 * @param {number[]} [kValues=[1, 3, 5]]
 * @returns {Record<number, number>}
 */
export function computePassAtKDistribution(tasksWithAttempts, kValues = [1, 3, 5]) {
  if (!Array.isArray(tasksWithAttempts) || tasksWithAttempts.length === 0) {
    const empty = {};
    for (const k of kValues) {
      empty[k] = 0.0;
    }
    return empty;
  }

  const result = {};

  for (const k of kValues) {
    let taskEstimatesSum = 0;
    let validTaskCount = 0;

    for (const task of tasksWithAttempts) {
      const attempts = task.attempts || [];
      const n = attempts.length;
      if (n < k) {
        // Skip tasks that do not have enough samples for this k
        continue;
      }
      const c = attempts.filter(Boolean).length;
      taskEstimatesSum += estimatePassAtK(n, c, k);
      validTaskCount++;
    }

    if (validTaskCount > 0) {
      result[k] = Math.round((taskEstimatesSum / validTaskCount) * 10000) / 10000;
    } else {
      result[k] = 0.0;
    }
  }

  return result;
}

/**
 * Pre-flight detector that executes a benchmark task multiple times against baseline
 * to identify flaky, non-deterministic assertions before evaluating candidate patches.
 *
 * @param {object} task
 * @param {(task: object, runIdx: number) => Promise<{ passed: boolean }>} executeFn
 * @param {object} [options={}]
 * @returns {Promise<{ taskId: string, isFlaky: boolean, runs: number, passedCount: number, failedCount: number, flakinessRate: number }>}
 */
export async function detectTaskFlakiness(task, executeFn, options = {}) {
  const runs = Math.max(2, Math.min(Number(options.runs || 3), 10));
  const taskId = task.id || 'anonymous-task';

  let passedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < runs; i++) {
    if (options.jitter) {
      await injectExecutionJitter(options.jitter);
    }

    const res = await executeFn(task, i);
    if (res.passed) {
      passedCount++;
    } else {
      failedCount++;
    }

    // Early termination on first variance if configured
    if (options.stopOnFirstVariance && passedCount > 0 && failedCount > 0) {
      break;
    }
  }

  const isFlaky = passedCount > 0 && failedCount > 0;
  const flakinessRate = isFlaky
    ? Math.round((Math.min(passedCount, failedCount) / (passedCount + failedCount)) * 10000) / 10000
    : 0.0;

  return {
    taskId,
    isFlaky,
    runs: passedCount + failedCount,
    passedCount,
    failedCount,
    flakinessRate
  };
}

/**
 * Filters a list of tasks into stable tasks and flaky tasks.
 *
 * @param {object[]} tasks
 * @param {Array<{ taskId: string, isFlaky: boolean }>} flakinessResults
 * @returns {{ stableTasks: object[], flakyTasks: object[], flakyTaskIds: string[] }}
 */
export function filterFlakyTasks(tasks, flakinessResults) {
  const flakySet = new Set(
    flakinessResults.filter(r => r.isFlaky).map(r => r.taskId)
  );

  const stableTasks = [];
  const flakyTasks = [];

  for (const t of tasks) {
    if (flakySet.has(t.id)) {
      flakyTasks.push(t);
    } else {
      stableTasks.push(t);
    }
  }

  return {
    stableTasks,
    flakyTasks,
    flakyTaskIds: Array.from(flakySet).sort()
  };
}

/**
 * Injects a deterministic bounded random delay to surface concurrency race conditions.
 *
 * @param {{ minMs?: number, maxMs?: number }} [options={}]
 * @returns {Promise<number>} Actual delay applied in ms
 */
export async function injectExecutionJitter(options = {}) {
  const minMs = Math.max(0, Number(options.minMs || 0));
  const maxMs = Math.max(minMs, Number(options.maxMs || 30));

  const delay = minMs === maxMs
    ? minMs
    : minMs + Math.floor(Math.random() * (maxMs - minMs + 1));

  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  return delay;
}

/**
 * Injects bounded CPU stress for a given duration to test timeout resilience under load.
 *
 * @param {number} durationMs Duration to execute compute loop
 * @returns {number} Operations completed
 */
export function injectCpuStress(durationMs = 50) {
  const start = Date.now();
  let ops = 0;
  while (Date.now() - start < durationMs) {
    // Light deterministic CPU hashing
    crypto.createHash('sha256').update(String(ops++)).digest();
  }
  return ops;
}
