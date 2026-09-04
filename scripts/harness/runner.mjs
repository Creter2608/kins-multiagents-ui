#!/usr/bin/env node
/**
 * scripts/harness/runner.mjs
 * Hermetic, zero-dependency Evaluation Benchmark Harness Runner for autonomous agents.
 * Evaluates F2P (Fail-to-Pass) and P2P (Pass-to-Pass) tasks against base commit and current workspace.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { validateGitDiffIntegrity } from './anti-gaming.mjs';
import {
  getSandboxConfig,
  spawnEphemeralSandbox,
  execInSandbox,
  teardownEphemeralSandbox
} from './sandbox.mjs';
import { runTaskPool } from './worker-pool.mjs';
import { AuditEventStream, buildBatchEvaluationReport } from './telemetry.mjs';


const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const TASK_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;

export function parseTask(content, sourcePath = 'inline') {
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch (err) {
    throw new Error(`Task file ${sourcePath} is not valid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Task file ${sourcePath} must contain a JSON object.`);
  }

  // Schema validation
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Task ${sourcePath}: expected schemaVersion 1, received ${parsed.schemaVersion}`);
  }

  if (typeof parsed.id !== 'string' || !TASK_ID_REGEX.test(parsed.id)) {
    throw new Error(`Task ${sourcePath}: invalid id '${parsed.id}'. Must match pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/`);
  }

  if (typeof parsed.title !== 'string' || parsed.title.trim().length === 0) {
    throw new Error(`Task ${sourcePath}: title must be a non-empty string`);
  }

  if (parsed.kind !== 'f2p' && parsed.kind !== 'p2p') {
    throw new Error(`Task ${sourcePath}: kind must be either 'f2p' or 'p2p', received '${parsed.kind}'`);
  }

  if (!parsed.command || typeof parsed.command !== 'object') {
    throw new Error(`Task ${sourcePath}: command must be an object`);
  }

  const { argv, timeoutMs = DEFAULT_TIMEOUT_MS } = parsed.command;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(`Task ${sourcePath}: command.argv must be a non-empty array of strings`);
  }

  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new Error(`Task ${sourcePath}: command.argv elements must be strings containing no null bytes`);
    }
  }

  const numericTimeout = Number(timeoutMs);
  if (!Number.isInteger(numericTimeout) || numericTimeout < 1 || numericTimeout > MAX_TIMEOUT_MS) {
    throw new Error(`Task ${sourcePath}: command.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }

  const hiddenAssertions = Array.isArray(parsed.hiddenAssertions) ? parsed.hiddenAssertions : [];
  for (const assertion of hiddenAssertions) {
    if (!assertion || typeof assertion !== 'object') {
      throw new Error(`Task ${sourcePath}: hiddenAssertions item must be an object`);
    }
    if (typeof assertion.path !== 'string' || assertion.path.trim().length === 0) {
      throw new Error(`Task ${sourcePath}: hiddenAssertion.path must be a non-empty string`);
    }
    if (path.isAbsolute(assertion.path) || assertion.path.startsWith('..')) {
      throw new Error(`Task ${sourcePath}: hiddenAssertion.path must be a relative path without traversal: '${assertion.path}'`);
    }
    if (typeof assertion.sha256 !== 'string' || !SHA256_HEX_REGEX.test(assertion.sha256.toLowerCase())) {
      throw new Error(`Task ${sourcePath}: hiddenAssertion.sha256 must be a 64-char hex string: '${assertion.sha256}'`);
    }
  }

  return {
    schemaVersion: 1,
    id: parsed.id,
    title: parsed.title,
    kind: parsed.kind,
    command: {
      argv: [...argv],
      timeoutMs: numericTimeout
    },
    hiddenAssertions: hiddenAssertions.map(a => ({
      path: path.normalize(a.path).replace(/\\/g, '/'),
      sha256: a.sha256.toLowerCase()
    }))
  };
}

export function computeMetrics(results, options = {}) {
  const flakyTaskIds = Array.isArray(options.flakyTaskIds) ? options.flakyTaskIds : [];
  const k = typeof options.k === 'number' && options.k > 0 ? options.k : 1;
  const passAtKDistributions = options.passAtKDistributions;

  const f2pResults = results.filter(r => r.kind === 'f2p');
  const p2pResults = results.filter(r => r.kind === 'p2p');

  const f2pPassed = f2pResults.filter(r => r.passed).length;
  const passAt1 = f2pResults.length === 0 ? 1 : Number((f2pPassed / f2pResults.length).toFixed(4));
  const passAtK = options.passAtK !== undefined ? options.passAtK : passAt1;

  const basePassingP2P = p2pResults.filter(r => r.base.passed);
  let ssi = 1;
  if (basePassingP2P.length > 0) {
    const currentPassingAmongBase = basePassingP2P.filter(r => r.current.passed).length;
    ssi = Number((currentPassingAmongBase / basePassingP2P.length).toFixed(4));
  }

  const metrics = {
    passAt1,
    passAtK,
    k,
    ssi
  };

  if (passAtKDistributions) {
    metrics.passAtKDistributions = passAtKDistributions;
  }
  if (flakyTaskIds.length > 0) {
    metrics.flakyTaskIds = flakyTaskIds;
  }

  return metrics;
}

function verifyHiddenAssertions(tasks, evalRoot) {
  for (const task of tasks) {
    for (const assertion of task.hiddenAssertions) {
      const targetPath = path.resolve(evalRoot, assertion.path);
      if (!fs.existsSync(targetPath)) {
        throw new Error(`[TAMPERING DETECTED] Missing hidden assertion file: ${targetPath} for task '${task.id}'`);
      }
      const content = fs.readFileSync(targetPath);
      const computedHash = crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
      const expectedHash = assertion.sha256.toLowerCase();

      const actBuf = Buffer.from(computedHash, 'hex');
      const expBuf = Buffer.from(expectedHash, 'hex');
      if (actBuf.length !== expBuf.length || !crypto.timingSafeEqual(actBuf, expBuf)) {
        throw new Error(`[TAMPERING DETECTED] Hidden assertion checksum mismatch for ${assertion.path} in task '${task.id}'. Expected ${expectedHash}, computed ${computedHash}`);
      }
    }
  }
}

export async function executeTaskCommand(command, workingDir, mode, targetRoot, options = {}) {
  const sandboxOpt = options?.sandbox;
  const securePatchPath = options?.securePatchPath;
  let patchApplied = false;

  if (securePatchPath && fs.existsSync(securePatchPath)) {
    try {
      execFileSync('git', ['apply', '--whitespace=nowarn', securePatchPath], {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      patchApplied = true;
    } catch (patchErr) {
      throw new Error(`Failed to apply secure test patch ${securePatchPath}: ${patchErr.message}`);
    }
  }

  try {
    if (sandboxOpt) {
      const sandboxConfigOverrides = typeof sandboxOpt === 'object' ? sandboxOpt : {};
      const networkPolicy = options?.networkPolicy || sandboxConfigOverrides.networkPolicy;
      const config = getSandboxConfig(`eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, {
        workdir: '/workspace',
        mounts: [{ source: workingDir, target: '/workspace', readOnly: false }],
        timeoutMs: command.timeoutMs,
        ...(networkPolicy ? { networkPolicy } : {}),
        ...sandboxConfigOverrides
      });

      const instance = await spawnEphemeralSandbox(config);
      try {
        const execResult = await execInSandbox(instance, command.argv, {
          cwd: '/workspace',
          timeoutMs: command.timeoutMs,
          env: {
            KINS_EVAL_MODE: mode,
            KINS_EVAL_TARGET_ROOT: targetRoot
          }
        });

        const timedOut = Boolean(execResult.timedOut);
        const exitCode = timedOut ? null : (execResult.exitCode ?? 0);
        const passed = exitCode === 0;

        return {
          exitCode,
          passed,
          signal: null,
          timedOut
        };
      } finally {
        await teardownEphemeralSandbox(instance);
      }
    }

    // Non-sandbox / host execution branch (legacy behavior unchanged)
    const [cmd, ...args] = command.argv;
    const env = {
      ...process.env,
      KINS_EVAL_MODE: mode,
      KINS_EVAL_TARGET_ROOT: targetRoot
    };

    const res = spawnSync(cmd, args, {
      cwd: workingDir,
      env,
      shell: false,
      timeout: command.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timedOut = res.error && res.error.code === 'ETIMEDOUT';
    const exitCode = timedOut ? null : (res.status ?? (res.error ? 1 : 0));
    const passed = exitCode === 0;

    return {
      exitCode,
      passed,
      signal: res.signal || null,
      timedOut: Boolean(timedOut)
    };
  } finally {
    if (patchApplied && securePatchPath) {
      try {
        execFileSync('git', ['apply', '--reverse', '--whitespace=nowarn', securePatchPath], {
          cwd: workingDir,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch {
        // cleanup best effort
      }
    }
  }
}


/**
 * Executes a single benchmark task against baseCommit (in detached worktree)
 * and current workspace.
 */
export async function runBenchmarkTask(task, runContext) {
  const { repoRoot, baseCommit, evalRoot, sandbox, networkPolicy, securePatchPath } = runContext;

  const tempPrefix = path.join(os.tmpdir(), 'kins-task-');
  const tempWorktree = fs.mkdtempSync(tempPrefix);
  let worktreeAttached = false;

  try {
    execFileSync('git', ['worktree', 'add', '--detach', tempWorktree, baseCommit], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    worktreeAttached = true;

    const securePatchCandidate = evalRoot
      ? path.join(evalRoot, '..', '.ai', 'secure-patches', `${task.id}.patch`)
      : path.join(repoRoot, '.ai', 'secure-patches', `${task.id}.patch`);
    const resolvedPatchPath = fs.existsSync(securePatchCandidate) ? securePatchCandidate : securePatchPath;
    const cmdOpts = { sandbox, networkPolicy, securePatchPath: resolvedPatchPath };

    // Execute against base
    const baseExec = await executeTaskCommand(task.command, tempWorktree, 'base', tempWorktree, cmdOpts);

    // Execute against current workspace
    const currentExec = await executeTaskCommand(task.command, repoRoot, 'current', repoRoot, cmdOpts);

    let passed = false;
    if (task.kind === 'f2p') {
      passed = !baseExec.passed && currentExec.passed;
    } else if (task.kind === 'p2p') {
      passed = baseExec.passed && currentExec.passed;
    }

    return {
      id: task.id,
      kind: task.kind,
      base: baseExec,
      current: currentExec,
      passed
    };
  } finally {
    if (worktreeAttached) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', tempWorktree], {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch {
        // cleanup best effort
      }
    }
    try {
      if (fs.existsSync(tempWorktree)) {
        fs.rmSync(tempWorktree, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Runs a batch of benchmark tasks concurrently using worker-pool.
 */
export async function runBenchmarkBatch(tasks, options = {}) {
  const {
    repoRoot,
    evalRoot,
    baseCommit,
    outputPath,
    sandbox,
    networkPolicy,
    concurrency,
    dataset,
    auditStream: customAuditStream,
    auditLogPath
  } = options;

  let verifiedCommit;
  try {
    verifiedCommit = execFileSync('git', ['rev-parse', '--verify', `${baseCommit}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    throw new Error(`Invalid base git commit '${baseCommit}': ${err.message}`);
  }

  const auditStream = customAuditStream instanceof AuditEventStream
    ? customAuditStream
    : new AuditEventStream(auditLogPath ? { logPath: auditLogPath } : {});

  auditStream.append('BATCH_STARTED', {
    taskCount: Array.isArray(tasks) ? tasks.length : 0,
    concurrency: concurrency || 'default',
    baseCommit: verifiedCommit
  });

  const poolRes = await runTaskPool(
    tasks,
    async (task, workerCtx) => {
      auditStream.append('TASK_STARTED', {
        taskId: task.id,
        workerId: workerCtx.workerId,
        runId: workerCtx.runId
      });

      const startedAt = new Date().toISOString();
      const taskResult = await runBenchmarkTask(task, {
        repoRoot,
        baseCommit: verifiedCommit,
        evalRoot,
        sandbox,
        networkPolicy
      });
      const finishedAt = new Date().toISOString();

      auditStream.append('TASK_COMPLETED', {
        taskId: task.id,
        workerId: workerCtx.workerId,
        passed: taskResult.passed
      });

      const attempt = {
        runId: workerCtx.runId,
        taskId: task.id,
        attempt: 1,
        workerId: workerCtx.workerId,
        containerId: '',
        startedAt,
        finishedAt,
        tokenUsage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'unavailable' },
        cost: null
      };
      return { taskResult, attempt };
    },
    {
      concurrency,
      repoRoot,
      baseCommit: verifiedCommit,
      sandbox,
      networkPolicy
    }
  );

  auditStream.append('BATCH_COMPLETED', {
    passed: poolRes.passed,
    resultsCount: poolRes.results.length,
    peakWorkers: poolRes.peakWorkers
  });

  const baseReport = {
    schemaVersion: 1,
    baseCommit: verifiedCommit,
    metrics: poolRes.metrics,
    passed: poolRes.passed,
    results: poolRes.results,
    violations: []
  };

  const batchReport = buildBatchEvaluationReport({
    dataset,
    attempts: poolRes.attempts,
    taskReports: [baseReport],
    tasks,
    auditStream
  });

  const fullReport = {
    ...baseReport,
    dataset: batchReport.dataset,
    attempts: poolRes.attempts,
    weightedPassed: batchReport.weightedPassed,
    totalCostMicroUsd: batchReport.totalCostMicroUsd,
    dollarEfficiencyIndex: batchReport.dollarEfficiencyIndex,
    auditDigest: batchReport.auditDigest,
    taskReports: [baseReport]
  };

  if (outputPath) {
    writeReportAtomically(outputPath, fullReport);
  }

  return fullReport;
}

export async function runEvaluation(options) {

  const { repoRoot, evalRoot, baseCommit, outputPath, sandbox } = options;

  if (!repoRoot || !fs.existsSync(repoRoot)) {
    throw new Error(`Invalid repoRoot: ${repoRoot}`);
  }
  if (!evalRoot || !fs.existsSync(evalRoot)) {
    throw new Error(`Invalid evalRoot: ${evalRoot}`);
  }
  if (!baseCommit) {
    throw new Error(`Missing required baseCommit parameter.`);
  }

  // 1. Validate base commit exists in git
  let verifiedCommit;
  try {
    verifiedCommit = execFileSync('git', ['rev-parse', '--verify', `${baseCommit}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    throw new Error(`Invalid base git commit '${baseCommit}': ${err.message}`);
  }

  // 1.5 Anti-Gaming & Tampering inspection before running any tasks
  const integrity = await validateGitDiffIntegrity(repoRoot, verifiedCommit, {});
  if (!integrity.clean) {
    const disqualifiedReport = {
      schemaVersion: 1,
      baseCommit: verifiedCommit,
      metrics: { passAt1: 0, passAtK: 0, k: 1, ssi: 0 },
      passed: false,
      results: [],
      violations: integrity.violations
    };
    if (outputPath) {
      writeReportAtomically(outputPath, disqualifiedReport);
    }
    return disqualifiedReport;
  }

  // 2. Discover task JSON files
  const tasksDir = path.resolve(evalRoot, 'harness', 'tasks');
  const taskEntries = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter(f => f.endsWith('.json') && f !== 'eval-report.json').sort()
    : [];

  if (taskEntries.length === 0) {
    const emptyReport = {
      schemaVersion: 1,
      baseCommit: verifiedCommit,
      metrics: { passAt1: 0, passAtK: 0, k: 1, ssi: 0 },
      passed: true,
      results: [],
      violations: []
    };
    if (outputPath) {
      writeReportAtomically(outputPath, emptyReport);
    }
    return emptyReport;
  }

  // 3. Parse and validate all tasks upfront
  const tasks = [];
  for (const filename of taskEntries) {
    const fullPath = path.join(tasksDir, filename);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const task = parseTask(content, fullPath);
    tasks.push(task);
  }

  // Ensure unique IDs and sort lexicographically
  const idSet = new Set();
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      throw new Error(`Duplicate task ID found: '${t.id}'`);
    }
    idSet.add(t.id);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  // 4. Verify hidden assertions integrity BEFORE running any task
  verifyHiddenAssertions(tasks, evalRoot);

  // 5. Setup temporary detached Git worktree for base commit
  const tempPrefix = path.join(os.tmpdir(), 'kins-eval-');
  const tempWorktree = fs.mkdtempSync(tempPrefix);
  let worktreeAttached = false;

  try {
    execFileSync('git', ['worktree', 'add', '--detach', tempWorktree, verifiedCommit], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    worktreeAttached = true;

    // 6. Execute tasks against base worktree and current workspace
    const results = [];
    for (const task of tasks) {
      const securePatchCandidate = path.join(evalRoot, '..', '.ai', 'secure-patches', `${task.id}.patch`);
      const securePatchPath = fs.existsSync(securePatchCandidate) ? securePatchCandidate : options.securePatchPath;
      const cmdOpts = { sandbox, networkPolicy: options.networkPolicy, securePatchPath };

      // Execute against base
      const baseExec = await executeTaskCommand(task.command, tempWorktree, 'base', tempWorktree, cmdOpts);

      // Execute against current workspace
      const currentExec = await executeTaskCommand(task.command, repoRoot, 'current', repoRoot, cmdOpts);


      // Evaluate task pass criteria
      let passed = false;
      if (task.kind === 'f2p') {
        // F2P: MUST fail on base AND pass on current
        passed = !baseExec.passed && currentExec.passed;
      } else if (task.kind === 'p2p') {
        // P2P: MUST pass on both base AND current
        passed = baseExec.passed && currentExec.passed;
      }

      results.push({
        id: task.id,
        kind: task.kind,
        base: baseExec,
        current: currentExec,
        passed
      });
    }

    // 7. Compute deterministic metrics
    const metrics = computeMetrics(results);

    // Overall passed requires:
    // - at least one F2P task
    // - at least one P2P task
    // - all F2P tasks passed
    // - all P2P tasks passed
    const hasF2P = results.some(r => r.kind === 'f2p');
    const hasP2P = results.some(r => r.kind === 'p2p');
    const allPassed = results.every(r => r.passed);
    const overallPassed = hasF2P && hasP2P && allPassed;

    const report = {
      schemaVersion: 1,
      baseCommit: verifiedCommit,
      metrics,
      passed: overallPassed,
      results,
      violations: []
    };

    // 8. Write report atomically (with fallback for Windows EPERM/EBUSY)
    if (outputPath) {
      writeReportAtomically(outputPath, report);
    }

    return report;
  } finally {
    // 9. Teardown temporary worktree
    if (worktreeAttached) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', tempWorktree], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch {
        // Fallback prune
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {}
      }
    }
    if (fs.existsSync(tempWorktree)) {
      try {
        fs.rmSync(tempWorktree, { recursive: true, force: true });
      } catch {}
    }
  }
}

function writeReportAtomically(outputPath, report) {
  const resolvedOutput = path.resolve(outputPath);
  const outDir = path.dirname(resolvedOutput);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const tmpFile = `${resolvedOutput}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const serialized = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(tmpFile, serialized, 'utf-8');
  try {
    fs.renameSync(tmpFile, resolvedOutput);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, resolvedOutput);
      try { fs.unlinkSync(tmpFile); } catch {}
    } else {
      throw err;
    }
  }
}

export function parseCliArgs(args) {
  const options = {
    baseCommit: null,
    repoRoot: process.cwd(),
    evalRoot: path.resolve(process.cwd(), '.eval'),
    outputPath: path.resolve(process.cwd(), '.ai', 'reports', 'eval-report.json')
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base') {
      options.baseCommit = args[++i];
    } else if (arg === '--repo-root') {
      options.repoRoot = path.resolve(args[++i]);
    } else if (arg === '--eval-root') {
      options.evalRoot = path.resolve(args[++i]);
    } else if (arg === '--output') {
      options.outputPath = path.resolve(args[++i]);
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`
Usage: node scripts/harness/runner.mjs --base <commit> [options]

Options:
  --base <commit>      Git commit or tag representing baseline state (required)
  --repo-root <path>   Path to git repository root (default: cwd)
  --eval-root <path>   Path to evaluation root (default: <repo-root>/.eval)
  --output <path>      Output report path (default: <repo-root>/.ai/reports/eval-report.json)
  --help, -h           Show this help message
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.baseCommit) {
    throw new Error("Missing required argument: --base <commit>");
  }

  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`[HARNESS USAGE ERROR] ${err.message}\n`);
    process.exit(2);
  }

  try {
    const report = await runEvaluation(options);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.violations && report.violations.length > 0) {
      process.exit(2);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    process.stderr.write(`[HARNESS INFRASTRUCTURE/INTEGRITY ERROR] ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  main().catch(err => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(2);
  });
}
