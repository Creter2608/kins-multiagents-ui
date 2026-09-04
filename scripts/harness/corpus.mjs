/**
 * scripts/harness/corpus.mjs
 * Benchmark Corpus Management & Task Ingestion Engine.
 * Provides canonical manifest hashing, provenance verification, F2P/P2P semantic validation,
 * and staging boundary protection (candidates never write to .eval/).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

const TASK_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATASET_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATASET_VERSION_REGEX = /^[a-zA-Z0-9._-]+$/;
const COMMIT_SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const HASH_SHA256_REGEX = /^[0-9a-fA-F]{64}$/;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;

/**
 * Deep-sort object keys to create a canonical representation.
 */
function deepSortKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }
  const sortedObj = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    sortedObj[key] = deepSortKeys(value[key]);
  }
  return sortedObj;
}

/**
 * Normalizes manifest data and outputs canonical JSON string.
 */
export function canonicalizeTaskManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('Task manifest must be a non-null object.');
  }

  // Clone and exclude manifestSha256 from canonical payload
  const clone = { ...manifest };
  delete clone.manifestSha256;

  // Normalize commands
  if (Array.isArray(clone.commands)) {
    clone.commands = clone.commands.map(cmd => ({
      argv: Array.isArray(cmd.argv) ? [...cmd.argv] : [],
      timeoutMs: Number(cmd.timeoutMs || DEFAULT_TIMEOUT_MS)
    }));
  }

  // Normalize hidden assertions
  if (Array.isArray(clone.hiddenAssertions)) {
    clone.hiddenAssertions = clone.hiddenAssertions
      .map(a => ({
        path: path.normalize(a.path || '').replace(/\\/g, '/'),
        sha256: String(a.sha256 || '').toLowerCase()
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  // Normalize public files
  if (Array.isArray(clone.publicFiles)) {
    clone.publicFiles = [...clone.publicFiles]
      .map(p => path.normalize(p).replace(/\\/g, '/'))
      .sort();
  }

  const sorted = deepSortKeys(clone);
  return JSON.stringify(sorted);
}

/**
 * Computes SHA-256 digest of canonicalized task manifest.
 */
export function hashTaskManifest(manifest) {
  const canonicalJson = canonicalizeTaskManifest(manifest);
  return crypto.createHash('sha256').update(canonicalJson, 'utf-8').digest('hex').toLowerCase();
}

/**
 * Validates a candidate task manifest.
 */
export function validateCandidateTask(candidate, options = {}) {
  const errors = [];

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: ['Candidate must be a non-null JSON object'] };
  }

  if (candidate.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, received: ${candidate.schemaVersion}`);
  }

  if (typeof candidate.taskId !== 'string' || !TASK_ID_REGEX.test(candidate.taskId)) {
    errors.push(`taskId '${candidate.taskId}' invalid. Must match pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/`);
  }

  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
    errors.push('title must be a non-empty string');
  }

  if (typeof candidate.datasetId !== 'string' || !DATASET_ID_REGEX.test(candidate.datasetId)) {
    errors.push(`datasetId '${candidate.datasetId}' invalid. Must match pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/`);
  }

  if (typeof candidate.datasetVersion !== 'string' || !DATASET_VERSION_REGEX.test(candidate.datasetVersion)) {
    errors.push(`datasetVersion '${candidate.datasetVersion}' invalid`);
  }

  if (typeof candidate.baseCommit !== 'string' || !COMMIT_SHA_REGEX.test(candidate.baseCommit)) {
    errors.push(`baseCommit must be a 40-char commit SHA, received: '${candidate.baseCommit}'`);
  }

  if (typeof candidate.targetCommit !== 'string' || !COMMIT_SHA_REGEX.test(candidate.targetCommit)) {
    errors.push(`targetCommit must be a 40-char commit SHA, received: '${candidate.targetCommit}'`);
  }

  if (candidate.sourceType !== 'commit' && candidate.sourceType !== 'issue') {
    errors.push(`sourceType must be 'commit' or 'issue', received: '${candidate.sourceType}'`);
  }

  if (typeof candidate.sourceId !== 'string' || candidate.sourceId.trim().length === 0) {
    errors.push('sourceId must be a non-empty string');
  }

  if (typeof candidate.license !== 'string' || candidate.license.trim().length === 0) {
    errors.push('license must be a non-empty string');
  }

  if (candidate.taskType !== 'f2p' && candidate.taskType !== 'p2p') {
    errors.push(`taskType must be 'f2p' or 'p2p', received: '${candidate.taskType}'`);
  }

  if (typeof candidate.weight !== 'number' || candidate.weight < 0 || !Number.isFinite(candidate.weight)) {
    errors.push('weight must be a non-negative number');
  }

  if (!Array.isArray(candidate.commands) || candidate.commands.length === 0) {
    errors.push('commands must be a non-empty array');
  } else {
    for (let i = 0; i < candidate.commands.length; i++) {
      const cmd = candidate.commands[i];
      if (!cmd || typeof cmd !== 'object' || !Array.isArray(cmd.argv) || cmd.argv.length === 0) {
        errors.push(`commands[${i}].argv must be a non-empty array of strings`);
      }
      const timeout = Number(cmd.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
        errors.push(`commands[${i}].timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
      }
    }
  }

  if (Array.isArray(candidate.hiddenAssertions)) {
    for (let i = 0; i < candidate.hiddenAssertions.length; i++) {
      const a = candidate.hiddenAssertions[i];
      if (!a || typeof a !== 'object') {
        errors.push(`hiddenAssertions[${i}] must be an object`);
        continue;
      }
      if (typeof a.path !== 'string' || a.path.trim().length === 0) {
        errors.push(`hiddenAssertions[${i}].path must be a non-empty string`);
      } else if (path.isAbsolute(a.path) || a.path.startsWith('..') || a.path.includes('../') || a.path.includes('..\\')) {
        errors.push(`hiddenAssertions[${i}].path must be a relative path without traversal: '${a.path}'`);
      }
      if (typeof a.sha256 !== 'string' || !HASH_SHA256_REGEX.test(a.sha256)) {
        errors.push(`hiddenAssertions[${i}].sha256 must be a 64-char hex string`);
      }
    }
  }

  if (Array.isArray(candidate.publicFiles)) {
    for (let i = 0; i < candidate.publicFiles.length; i++) {
      const p = candidate.publicFiles[i];
      if (typeof p !== 'string' || path.isAbsolute(p) || p.startsWith('..') || p.includes('../') || p.includes('..\\')) {
        errors.push(`publicFiles[${i}] must be a relative path without traversal: '${p}'`);
      }
    }
  }

  if (options.verifyDigest && candidate.manifestSha256) {
    const computedDigest = hashTaskManifest(candidate);
    if (computedDigest !== candidate.manifestSha256.toLowerCase()) {
      errors.push(`manifestSha256 mismatch: expected ${computedDigest}, found ${candidate.manifestSha256}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Execute command synchronously in working directory.
 */
function runCommandInDir(command, dir) {
  const [cmd, ...args] = command.argv;
  const res = spawnSync(cmd, args, {
    cwd: dir,
    shell: false,
    timeout: command.timeoutMs || DEFAULT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT');
  const exitCode = timedOut ? null : (res.status ?? (res.error ? 1 : 0));
  return {
    passed: exitCode === 0,
    exitCode,
    timedOut
  };
}

/**
 * Ingests a new benchmark task from Git commits / issues.
 * Validates F2P/P2P semantics and writes candidate to staging directory (NEVER .eval/).
 */
export async function ingestTask(options) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const taskId = options.taskId;
  const title = options.title;
  const taskType = options.taskType;
  const datasetId = options.datasetId || 'kins-benchmark';
  const datasetVersion = options.datasetVersion || '1.0.0';
  const sourceType = options.sourceType || 'commit';
  const license = options.license || 'MIT';
  const weight = options.weight !== undefined ? Number(options.weight) : 1;
  const validateSemantics = options.validateSemantics !== false;

  // Ranh giới an toàn: Kiểm tra stagingDir
  const defaultStagingDir = path.resolve(repoRoot, '.harness', 'corpus-staging');
  const stagingDir = path.resolve(options.stagingDir || defaultStagingDir);

  const evalDir = path.resolve(repoRoot, '.eval');
  if (stagingDir === evalDir || stagingDir.startsWith(evalDir + path.sep)) {
    throw new Error('STAGING_VIOLATION: Ingestion stagingDir must NEVER point into .eval/. Candidates must be isolated in staging.');
  }

  if (!taskId || !TASK_ID_REGEX.test(taskId)) {
    throw new Error(`Invalid taskId '${taskId}'. Must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/`);
  }

  // 1. Resolve commit SHAs
  let baseSha;
  let targetSha;
  try {
    baseSha = execFileSync('git', ['rev-parse', '--verify', `${options.baseCommit}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim().toLowerCase();
  } catch (err) {
    throw new Error(`Failed to resolve baseCommit '${options.baseCommit}': ${err.message}`);
  }

  try {
    targetSha = execFileSync('git', ['rev-parse', '--verify', `${options.targetCommit}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim().toLowerCase();
  } catch (err) {
    throw new Error(`Failed to resolve targetCommit '${options.targetCommit}': ${err.message}`);
  }

  const sourceId = options.sourceId || targetSha.slice(0, 8);

  // Auto-detect repository URL if not provided
  let repoUrl = options.repositoryUrl || 'local';
  if (repoUrl === 'local') {
    try {
      repoUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim() || 'local';
    } catch {
      repoUrl = 'local';
    }
  }

  // Normalize commands
  const rawCommands = Array.isArray(options.commands) ? options.commands : [options.commands];
  if (rawCommands.length === 0 || !rawCommands[0]?.argv) {
    throw new Error('Ingestion requires at least one valid command in options.commands');
  }
  const commands = rawCommands.map(cmd => ({
    argv: [...cmd.argv],
    timeoutMs: Number(cmd.timeoutMs || DEFAULT_TIMEOUT_MS)
  }));

  // Normalize hidden assertions
  const hiddenAssertions = (options.hiddenAssertions || []).map(a => {
    let hash = a.sha256;
    if (!hash && fs.existsSync(path.resolve(repoRoot, a.path))) {
      const fileBytes = fs.readFileSync(path.resolve(repoRoot, a.path));
      hash = crypto.createHash('sha256').update(fileBytes).digest('hex').toLowerCase();
    }
    return {
      path: path.normalize(a.path).replace(/\\/g, '/'),
      sha256: (hash || '').toLowerCase()
    };
  });

  const publicFiles = (options.publicFiles || []).map(p => path.normalize(p).replace(/\\/g, '/'));

  // 2. Semantic verification if requested
  if (validateSemantics) {
    const tempPrefix = path.join(os.tmpdir(), 'kins-corpus-');
    const baseWorktree = fs.mkdtempSync(`${tempPrefix}base-`);
    const targetWorktree = fs.mkdtempSync(`${tempPrefix}target-`);

    try {
      execFileSync('git', ['worktree', 'add', '--detach', baseWorktree, baseSha], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      execFileSync('git', ['worktree', 'add', '--detach', targetWorktree, targetSha], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      for (const cmd of commands) {
        const baseExec = runCommandInDir(cmd, baseWorktree);
        const targetExec = runCommandInDir(cmd, targetWorktree);

        if (taskType === 'f2p') {
          if (baseExec.passed) {
            throw new Error(`SEMANTIC_VALIDATION_FAILED: F2P task '${taskId}' MUST fail on base commit (${baseSha.slice(0, 8)}), but it PASSED.`);
          }
          if (!targetExec.passed) {
            throw new Error(`SEMANTIC_VALIDATION_FAILED: F2P task '${taskId}' MUST pass on target commit (${targetSha.slice(0, 8)}), but it FAILED.`);
          }
        } else if (taskType === 'p2p') {
          if (!baseExec.passed) {
            throw new Error(`SEMANTIC_VALIDATION_FAILED: P2P task '${taskId}' MUST pass on base commit (${baseSha.slice(0, 8)}), but it FAILED.`);
          }
          if (!targetExec.passed) {
            throw new Error(`SEMANTIC_VALIDATION_FAILED: P2P task '${taskId}' MUST pass on target commit (${targetSha.slice(0, 8)}), but it FAILED.`);
          }
        }
      }
    } finally {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', baseWorktree], { cwd: repoRoot, stdio: 'ignore' });
      } catch {
        // cleanup best effort
      }
      try {
        execFileSync('git', ['worktree', 'remove', '--force', targetWorktree], { cwd: repoRoot, stdio: 'ignore' });
      } catch {
        // cleanup best effort
      }
      try {
        if (fs.existsSync(baseWorktree)) fs.rmSync(baseWorktree, { recursive: true, force: true });
        if (fs.existsSync(targetWorktree)) fs.rmSync(targetWorktree, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // 3. Golden bundle digest calculation
  const bundleHash = crypto.createHash('sha256');
  for (const a of hiddenAssertions) {
    bundleHash.update(`${a.path}:${a.sha256}\n`);
  }
  const goldenBundleDigest = bundleHash.digest('hex').toLowerCase();

  // 4. Assemble candidate manifest
  const candidateManifest = {
    schemaVersion: 1,
    taskId,
    title,
    datasetId,
    datasetVersion,
    repositoryUrl: repoUrl,
    baseCommit: baseSha,
    targetCommit: targetSha,
    sourceType,
    sourceId,
    license,
    taskType,
    weight,
    publicFiles,
    goldenBundleDigest,
    commands,
    hiddenAssertions
  };

  const manifestSha256 = hashTaskManifest(candidateManifest);
  const finalManifest = {
    ...candidateManifest,
    manifestSha256
  };

  // Validate complete manifest
  const val = validateCandidateTask(finalManifest, { verifyDigest: true });
  if (!val.valid) {
    throw new Error(`Generated manifest failed validation: ${val.errors.join('; ')}`);
  }

  // 5. Atomic write to staging directory
  const taskStagingDir = path.join(stagingDir, taskId);
  fs.mkdirSync(taskStagingDir, { recursive: true });

  const manifestPath = path.join(taskStagingDir, 'task.json');
  fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf-8');

  // Also write legacy BenchmarkTask schema JSON for runner compatibility
  const benchmarkTask = {
    schemaVersion: 1,
    id: taskId,
    title,
    kind: taskType,
    command: commands[0],
    hiddenAssertions,
    datasetId,
    datasetVersion,
    manifestSha256,
    provenance: {
      repositoryUrl: repoUrl,
      baseCommit: baseSha,
      targetCommit: targetSha,
      sourceType,
      sourceId,
      license
    },
    weight
  };
  const benchmarkTaskPath = path.join(taskStagingDir, 'benchmark-task.json');
  fs.writeFileSync(benchmarkTaskPath, JSON.stringify(benchmarkTask, null, 2) + '\n', 'utf-8');

  return {
    taskId,
    manifestPath,
    benchmarkTaskPath,
    manifestSha256,
    validated: true
  };
}

/**
 * Scans a corpus directory, validates all task manifests, and confirms integrity digests.
 */
export async function verifyCorpus(corpusDir) {
  const resolvedDir = path.resolve(corpusDir);
  if (!fs.existsSync(resolvedDir)) {
    return { valid: false, count: 0, issues: [`Directory does not exist: ${resolvedDir}`] };
  }

  const issues = [];
  let count = 0;

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && (entry.name === 'task.json' || entry.name.endsWith('.manifest.json'))) {
        count++;
        try {
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const val = validateCandidateTask(parsed, { verifyDigest: true });
          if (!val.valid) {
            issues.push(`${fullPath}: ${val.errors.join('; ')}`);
          }
        } catch (err) {
          issues.push(`${fullPath}: Failed to parse JSON: ${err.message}`);
        }
      }
    }
  }

  scanDir(resolvedDir);

  return {
    valid: issues.length === 0,
    count,
    issues
  };
}
