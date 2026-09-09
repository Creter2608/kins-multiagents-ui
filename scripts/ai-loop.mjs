#!/usr/bin/env node
/**
 * scripts/ai-loop.mjs
 * Deterministic, persistent runner for the 10-phase Canonical Autonomous Loop v3.0.
 * Enforces atomic state persistence, file locking, budget ceilings, and golden verification.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  getSandboxConfig,
  spawnEphemeralSandbox,
  teardownEphemeralSandbox
} from './harness/sandbox.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = APP_ROOT; // Backward compatibility alias

// Dynamic import of dist/src/index.js (built engine)
let LoopEngine, validateWorkspace, parseSha256Hex, LoopError, classifyUnknownError;
try {
  const engineModule = await import('../dist/src/index.js');
  LoopEngine = engineModule.LoopEngine;
  validateWorkspace = engineModule.validateWorkspace;
  parseSha256Hex = engineModule.parseSha256Hex;
  LoopError = engineModule.LoopError;
  classifyUnknownError = engineModule.classifyUnknownError;
} catch (err) {
  process.stderr.write(`[ai-loop ERROR] Failed to load dist/src/index.js. Run 'npm run build' first: ${err.message}\n`);
  process.exit(1);
}

const CANONICAL_PHASES = [
  { id: 'INITIALIZE', allowedNext: ['SPEC_GATE', 'FAILED'] },
  { id: 'SPEC_GATE', allowedNext: ['ISOLATE', 'BLOCKED'] },
  { id: 'ISOLATE', allowedNext: ['DETECT_STACKS', 'BLOCKED', 'FAILED'] },
  { id: 'DETECT_STACKS', allowedNext: ['PLAN', 'FAILED'] },
  { id: 'PLAN', allowedNext: ['EXECUTE', 'BLOCKED', 'FAILED'] },
  { id: 'EXECUTE', allowedNext: ['VERIFY', 'BLOCKED', 'FAILED'] },
  { id: 'VERIFY', allowedNext: ['REALITY_CHECK', 'EXECUTE', 'BLOCKED', 'FAILED'] },
  { id: 'REALITY_CHECK', allowedNext: ['RELEASE_GATE', 'EXECUTE', 'BLOCKED', 'FAILED'] },
  { id: 'RELEASE_GATE', allowedNext: ['COMPLETE', 'BLOCKED'] },
  { id: 'COMPLETE', allowedNext: [], terminal: true },
  { id: 'BLOCKED', allowedNext: [], terminal: true },
  { id: 'FAILED', allowedNext: [], terminal: true }
];

const DEFAULT_BUDGET = {
  maxTransitions: 25,
  maxRetries: 2,
  maxOperations: 50
};

function printHelp() {
  const help = `
Usage: node scripts/ai-loop.mjs <command> [options]

Commands:
  init                     Initialize a new loop run
  status                   Display current loop state snapshot
  transition <phase>       Transition to the specified next phase
  rollback [--code]        Rollback to the previous phase in history (optionally restore tracked git changes)
  retry [count]            Consume retries from the retry budget (default: 1)
  fail <code> <message>    Mark run as failed with code and explanation
  isolate --task <id>      Create or reuse an isolated Git worktree sandbox for a task
  pitfalls [query]         Extract matching invariant pitfall guards from wiki/pitfalls.md
  verify                   Validate workspace assertions against .eval/golden_assertions.json

Options:
  --project-root <path>    Path to the target project root (default: current working directory or derived from state file)
  --run-id <id>            Deterministic run identifier (default: auto-generated timestamp)
  --state-file <path>      Path to state JSON file (default: .ai/state.json)
  --golden-sha <sha>       Expected SHA-256 for golden assertions
  --json                   Output state as pure JSON
  --help, -h               Show this help message
`;
  process.stdout.write(help.trim() + '\n');
}

function resolveTargetProjectRoot(projectRootArg, stateFileArg) {
  if (projectRootArg) {
    return path.resolve(projectRootArg);
  }
  if (stateFileArg) {
    const resolvedState = path.resolve(stateFileArg);
    const stateDir = path.dirname(resolvedState);
    if (path.basename(stateDir) === '.ai') {
      return path.dirname(stateDir);
    }
    try {
      const gitRoot = execFileSync('git', ['-C', stateDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
      if (gitRoot) return path.resolve(gitRoot);
    } catch {
      return stateDir;
    }
  }
  return process.cwd();
}

function resolveStateFile(rawPath, targetProjectRoot) {
  const root = targetProjectRoot || process.cwd();
  const resolved = path.resolve(root, rawPath || '.ai/state.json');
  const targetEvalDir = path.resolve(root, '.eval');
  const appEvalDir = path.resolve(APP_ROOT, '.eval');
  if (resolved === targetEvalDir || resolved.startsWith(targetEvalDir + path.sep) ||
      resolved === appEvalDir || resolved.startsWith(appEvalDir + path.sep)) {
    throw new LoopError('CONFIG_INVALID', 'configuration', 'Security invariant violation: State file cannot be located in .eval/');
  }
  return resolved;
}

class FileLock {
  constructor(filePath) {
    this.lockPath = filePath + '.lock';
    this.fd = null;
  }

  acquire() {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      this.fd = fs.openSync(this.lockPath, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new LoopError('STATE_CONFLICT', 'state', `Active run locked by another process: ${this.lockPath}`);
      }
      throw err;
    }
  }

  release() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore cleanup errors
      }
      this.fd = null;
    }
  }
}

function atomicSaveState(stateFile, state) {
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${stateFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const serialized = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(tmpFile, serialized, 'utf-8');
  try {
    fs.renameSync(tmpFile, stateFile);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, stateFile);
      try { fs.unlinkSync(tmpFile); } catch {}
    } else {
      throw err;
    }
  }
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    throw new LoopError('STATE_INVALID', 'state', `No state file found at: ${stateFile}. Run 'init' first.`);
  }
  let content;
  try {
    content = fs.readFileSync(stateFile, 'utf-8');
  } catch (err) {
    throw new LoopError('STATE_INVALID', 'state', `Failed to read state file: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !parsed.currentPhase) {
      throw new Error('Invalid state schema');
    }
    return parsed;
  } catch (err) {
    throw new LoopError('STATE_INVALID', 'state', `Corrupted or invalid state JSON: ${err.message}`);
  }
}

function getEngineOptions(runId, goldenSha, targetProjectRoot = APP_ROOT) {
  let validSha = goldenSha;
  if (!validSha) {
    const targetShaFile = path.resolve(targetProjectRoot, '.eval/golden_assertions.sha256');
    const appShaFile = path.resolve(APP_ROOT, '.eval/golden_assertions.sha256');
    const shaFile = fs.existsSync(targetShaFile) ? targetShaFile : appShaFile;
    if (fs.existsSync(shaFile)) {
      validSha = fs.readFileSync(shaFile, 'utf-8').trim().split(/\s+/)[0];
    } else {
      validSha = '0000000000000000000000000000000000000000000000000000000000000000';
    }
  }

  return {
    phases: CANONICAL_PHASES,
    initialPhase: 'INITIALIZE',
    terminalPhase: 'COMPLETE',
    budget: DEFAULT_BUDGET,
    goldenSha256: parseSha256Hex(validSha),
    runId: runId || `run-${Date.now()}`
  };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let command = null;
  let cmdArgs = [];
  let projectRootArg = null;
  let stateFileArg = null;
  let runIdArg = null;
  let goldenShaArg = null;
  let taskArg = null;
  let jsonOutput = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--project-root') {
      projectRootArg = rawArgs[++i];
    } else if (arg === '--state-file') {
      stateFileArg = rawArgs[++i];
    } else if (arg === '--run-id') {
      runIdArg = rawArgs[++i];
    } else if (arg === '--golden-sha') {
      goldenShaArg = rawArgs[++i];
    } else if (arg === '--task') {
      taskArg = rawArgs[++i];
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (!arg.startsWith('-') && command === null) {
      command = arg;
    } else {
      cmdArgs.push(arg);
    }
  }

  if (!command) {
    printHelp();
    process.exit(1);
  }

  const targetProjectRoot = resolveTargetProjectRoot(projectRootArg, stateFileArg);
  const stateFilePath = resolveStateFile(stateFileArg, targetProjectRoot);
  const lock = new FileLock(stateFilePath);

  try {
    switch (command) {
      case 'init': {
        lock.acquire();
        try {
          const opts = getEngineOptions(runIdArg, goldenShaArg, targetProjectRoot);
          const engine = new LoopEngine(opts);
          const snapshot = engine.snapshot();
          snapshot.sandbox = {
            config: getSandboxConfig(snapshot.runId),
            instance: null,
            teardown: null
          };
          atomicSaveState(stateFilePath, snapshot);
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
          } else {
            process.stdout.write(`[ai-loop] Initialized run ${snapshot.runId} at phase ${snapshot.currentPhase}\n`);
            process.stdout.write(`[ai-loop] State saved: ${stateFilePath}\n`);
          }
        } finally {
          lock.release();
        }
        break;
      }

      case 'status': {
        const state = loadState(stateFilePath);
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(state, null, 2) + '\n');
        } else {
          process.stdout.write(`Run ID:      ${state.runId}\n`);
          process.stdout.write(`Phase:       ${state.currentPhase}\n`);
          process.stdout.write(`Status:      ${state.status}\n`);
          process.stdout.write(`Transitions: ${state.usage.transitions}/${state.budget.maxTransitions}\n`);
          process.stdout.write(`Retries:     ${state.usage.retries}/${state.budget.maxRetries}\n`);
          if (state.lastError) {
            process.stdout.write(`Last Error:  [${state.lastError.code}] ${state.lastError.message}\n`);
          }
        }
        break;
      }

      case 'transition': {
        const targetPhase = cmdArgs[0];
        if (!targetPhase) {
          throw new LoopError('CONFIG_INVALID', 'configuration', 'Usage: node scripts/ai-loop.mjs transition <phase>');
        }
        lock.acquire();
        try {
          const savedState = loadState(stateFilePath);
          const opts = getEngineOptions(savedState.runId, savedState.goldenSha256);
          const engine = new LoopEngine(opts, savedState);
          const nextState = engine.transition(targetPhase);

          // Preserve or initialize sandbox state
          nextState.sandbox = savedState.sandbox || {
            config: getSandboxConfig(savedState.runId),
            instance: null,
            teardown: null
          };

          // On transition to ISOLATE, spawn ephemeral sandbox if not already spawned
          if (nextState.currentPhase === 'ISOLATE' && !nextState.sandbox.instance) {
            try {
              const inst = await spawnEphemeralSandbox(nextState.sandbox.config);
              nextState.sandbox.instance = {
                runId: inst.runId,
                containerName: inst.containerName,
                containerId: inst.containerId,
                status: inst.status,
                mode: inst.mode,
                workspacePath: inst.workspacePath,
                ownedPaths: [...inst.ownedPaths]
              };
              nextState.sandbox.teardown = null;
            } catch (spawnErr) {
              process.stderr.write(`[ai-loop WARN] Sandbox spawn in ISOLATE: ${spawnErr.message}\n`);
            }
          }

          // On terminal transition (COMPLETE or FAILED), perform idempotent teardown
          if ((nextState.currentPhase === 'COMPLETE' || nextState.currentPhase === 'FAILED') && nextState.sandbox.instance && !nextState.sandbox.teardown) {
            try {
              const tdResult = await teardownEphemeralSandbox(nextState.sandbox.instance);
              nextState.sandbox.teardown = tdResult;
            } catch (tdErr) {
              process.stderr.write(`[ai-loop WARN] Sandbox teardown on terminal phase: ${tdErr.message}\n`);
            }
          }

          if (savedState.testSummary) {
            nextState.testSummary = savedState.testSummary;
          }

          if (savedState.architecturalCompliance) {
            nextState.architecturalCompliance = savedState.architecturalCompliance;
          }

          if (savedState.audit && !nextState.audit) {
            nextState.audit = savedState.audit;
          } else if (savedState.audit && nextState.audit) {
            nextState.audit = {
              ...savedState.audit,
              ...nextState.audit
            };
          }

          if (nextState.currentPhase === 'REALITY_CHECK' || nextState.currentPhase === 'COMPLETE') {
            try {
              const { evaluateArchitecturalCompliance } = await import('./harness/judge.mjs');
              let diffText = '';
              try {
                diffText = execFileSync('git', ['-c', 'safe.directory=*', 'diff', 'HEAD'], {
                  cwd: targetProjectRoot,
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'pipe']
                });
                if (!diffText.trim()) {
                  diffText = execFileSync('git', ['-c', 'safe.directory=*', 'diff', 'HEAD~1'], {
                    cwd: targetProjectRoot,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe']
                  });
                }
              } catch {
                try {
                  diffText = execFileSync('git', ['-c', 'safe.directory=*', 'diff'], {
                    cwd: targetProjectRoot,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe']
                  });
                } catch {
                  diffText = '';
                }
              }
              const compliance = evaluateArchitecturalCompliance({
                repoRoot: targetProjectRoot,
                diffText
              });
              nextState.architecturalCompliance = compliance;
            } catch (err) {
              process.stderr.write(`[ai-loop WARN] Architectural evaluation failed: ${err.message}\n`);
            }
          }

          atomicSaveState(stateFilePath, nextState);
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(nextState, null, 2) + '\n');
          } else {
            process.stdout.write(`[ai-loop] Transitioned to ${nextState.currentPhase} (Status: ${nextState.status})\n`);
          }
        } finally {
          lock.release();
        }
        break;
      }

      case 'rollback': {
        let revertCode = false;
        for (const arg of cmdArgs) {
          if (arg === '--code') {
            revertCode = true;
          } else {
            throw new LoopError('CONFIG_INVALID', 'configuration', `Unknown rollback option: ${arg}`);
          }
        }

        lock.acquire();
        try {
          const savedState = loadState(stateFilePath);
          const opts = getEngineOptions(savedState.runId, savedState.goldenSha256, targetProjectRoot);
          const engine = new LoopEngine(opts, savedState);
          const nextState = engine.rollback();

          if (revertCode) {
            try {
              execFileSync('git', ['restore', '--staged', '--worktree', '--', '.'], {
                cwd: targetProjectRoot,
                stdio: ['ignore', 'pipe', 'pipe']
              });
            } catch {
              execFileSync('git', ['checkout', '--', '.'], {
                cwd: targetProjectRoot,
                stdio: ['ignore', 'pipe', 'pipe']
              });
            }
          }

          nextState.sandbox = savedState.sandbox || null;
          if (savedState.testSummary) {
            nextState.testSummary = savedState.testSummary;
          }

          atomicSaveState(stateFilePath, nextState);
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(nextState, null, 2) + '\n');
          } else {
            process.stdout.write(`[ai-loop] Rolled back to ${nextState.currentPhase} (Status: ${nextState.status})${revertCode ? ' [Code restored]' : ''}\n`);
          }
        } finally {
          lock.release();
        }
        break;
      }

      case 'retry': {
        const count = cmdArgs[0] ? Number.parseInt(cmdArgs[0], 10) : 1;
        lock.acquire();
        try {
          const savedState = loadState(stateFilePath);
          const opts = getEngineOptions(savedState.runId, savedState.goldenSha256);
          const engine = new LoopEngine(opts, savedState);
          const nextState = engine.consumeRetry(count);

          nextState.sandbox = savedState.sandbox || null;
          if (savedState.testSummary) {
            nextState.testSummary = savedState.testSummary;
          }

          atomicSaveState(stateFilePath, nextState);
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(nextState, null, 2) + '\n');
          } else {
            process.stdout.write(`[ai-loop] Consumed retry (${nextState.usage.retries}/${nextState.budget.maxRetries})\n`);
          }
        } finally {
          lock.release();
        }
        break;
      }

      case 'fail': {
        const [code, ...msgParts] = cmdArgs;
        const message = msgParts.join(' ') || 'Unspecified failure';
        if (!code) {
          throw new LoopError('CONFIG_INVALID', 'configuration', 'Usage: node scripts/ai-loop.mjs fail <code> <message>');
        }
        lock.acquire();
        try {
          const savedState = loadState(stateFilePath);
          const opts = getEngineOptions(savedState.runId, savedState.goldenSha256, targetProjectRoot);
          const engine = new LoopEngine(opts, savedState);
          const nextState = engine.fail(code, message);

          nextState.sandbox = savedState.sandbox || null;
          if (nextState.sandbox?.instance && !nextState.sandbox.teardown) {
            try {
              const tdResult = await teardownEphemeralSandbox(nextState.sandbox.instance);
              nextState.sandbox.teardown = tdResult;
            } catch (tdErr) {
              process.stderr.write(`[ai-loop WARN] Sandbox teardown on fail: ${tdErr.message}\n`);
            }
          }

          if (savedState.testSummary) {
            nextState.testSummary = savedState.testSummary;
          }

          atomicSaveState(stateFilePath, nextState);
          if (jsonOutput) {
            process.stdout.write(JSON.stringify(nextState, null, 2) + '\n');
          } else {
            process.stdout.write(`[ai-loop] Marked FAILED [${code}]: ${message}\n`);
          }
        } finally {
          lock.release();
        }
        break;
      }

      case 'isolate': {
        const taskId = taskArg || cmdArgs[0];
        if (!taskId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(taskId)) {
          throw new LoopError('CONFIG_INVALID', 'configuration', `Invalid task ID: '${taskId}'. Must match ^[a-z0-9][a-z0-9._-]{0,63}$`);
        }

        // Detect unborn HEAD
        let isUnborn = false;
        try {
          execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
            cwd: targetProjectRoot,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch {
          isUnborn = true;
        }

        if (isUnborn) {
          throw new LoopError(
            'STATE_CONFLICT',
            'state',
            'Cannot isolate task in git worktree: repository has no commits yet (unborn HEAD). An initial commit is required for git worktree isolation.'
          );
        }

        const branch = `task/${taskId}`;
        const worktreePath = path.resolve(targetProjectRoot, '.worktrees', taskId);

        let reused = false;
        if (fs.existsSync(worktreePath)) {
          try {
            const wtList = execFileSync('git', ['worktree', 'list', '--porcelain'], {
              cwd: targetProjectRoot,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe']
            });
            const normWt = path.normalize(worktreePath).toLowerCase().replace(/\\/g, '/');
            const normList = wtList.toLowerCase().replace(/\\/g, '/');
            if (normList.includes(normWt)) {
              reused = true;
            } else {
              throw new LoopError('STATE_CONFLICT', 'state', `Directory exists but is not a valid git worktree: ${worktreePath}`);
            }
          } catch (err) {
            if (err instanceof LoopError) throw err;
            throw new LoopError('STATE_CONFLICT', 'state', `Conflicting path exists at ${worktreePath}`);
          }
        } else {
          const wtDir = path.dirname(worktreePath);
          if (!fs.existsSync(wtDir)) {
            fs.mkdirSync(wtDir, { recursive: true });
          }
          let branchExists = false;
          try {
            execFileSync('git', ['rev-parse', '--verify', branch], {
              cwd: targetProjectRoot,
              stdio: ['ignore', 'pipe', 'pipe']
            });
            branchExists = true;
          } catch {
            branchExists = false;
          }

          if (branchExists) {
            execFileSync('git', ['worktree', 'add', worktreePath, branch], {
              cwd: targetProjectRoot,
              stdio: ['ignore', 'pipe', 'pipe']
            });
          } else {
            execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
              cwd: targetProjectRoot,
              stdio: ['ignore', 'pipe', 'pipe']
            });
          }
        }

        const wtStateDir = path.join(worktreePath, '.ai');
        if (!fs.existsSync(wtStateDir)) {
          fs.mkdirSync(wtStateDir, { recursive: true });
        }
        const wtStateFile = path.join(wtStateDir, 'state.json');
        let wtState;
        if (fs.existsSync(wtStateFile)) {
          wtState = loadState(wtStateFile);
        } else {
          const runId = runIdArg || `run-${taskId}-${Date.now()}`;
          const opts = getEngineOptions(runId, goldenShaArg, targetProjectRoot);
          const engine = new LoopEngine(opts);
          engine.transition('SPEC_GATE');
          wtState = engine.transition('ISOLATE');
          atomicSaveState(wtStateFile, wtState);
        }

        const result = {
          reused,
          taskId,
          branch,
          worktree: worktreePath,
          runId: wtState.runId,
          currentPhase: wtState.currentPhase
        };

        if (jsonOutput) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(`[ai-loop] ${reused ? 'Reused' : 'Isolated'} task '${taskId}' in worktree: ${worktreePath} (Phase: ${wtState.currentPhase})\n`);
        }
        break;
      }

      case 'pitfalls': {
        const { matchPitfalls } = await import('./harness/pitfall-matcher.mjs');
        const query = cmdArgs.join(' ') || '';
        const matchResult = matchPitfalls(query, {
          targetProjectRoot,
          appRoot: APP_ROOT
        });
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(matchResult, null, 2) + '\n');
        } else {
          if (matchResult.matches.length === 0) {
            process.stdout.write('[ai-loop] No specific pitfall triggers matched.\n');
          } else {
            process.stdout.write(matchResult.markdown + '\n');
          }
        }
        break;
      }

      case 'verify': {
        let shaPath = path.resolve(targetProjectRoot, '.eval/golden_assertions.sha256');
        let goldenPath = path.resolve(targetProjectRoot, '.eval/golden_assertions.json');
        if (!fs.existsSync(shaPath) || !fs.existsSync(goldenPath)) {
          shaPath = path.resolve(APP_ROOT, '.eval/golden_assertions.sha256');
          goldenPath = path.resolve(APP_ROOT, '.eval/golden_assertions.json');
        }
        if (!fs.existsSync(shaPath) || !fs.existsSync(goldenPath)) {
          throw new LoopError('CONFIG_TRUST_ANCHOR_MISSING', 'configuration', 'Missing .eval/ files for verification');
        }
        const expectedSha = fs.readFileSync(shaPath, 'utf-8').trim().split(/\s+/)[0];
        const results = await validateWorkspace({ goldenPath, expectedSha256: expectedSha });
        if (jsonOutput) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else {
          process.stdout.write(`[ai-loop] Verified ${results.length} golden assertions successfully against SHA-256.\n`);
        }
        break;
      }

      default:
        throw new LoopError('CONFIG_INVALID', 'configuration', `Unknown command: '${command}'. See --help.`);
    }
  } catch (err) {
    const loopErr = classifyUnknownError(err);
    process.stderr.write(`[ai-loop FAILED: ${loopErr.code}] ${loopErr.message}\n`);
    process.exit(1);
  }
}

main();
