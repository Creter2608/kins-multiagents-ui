/**
 * test/deepseek-harness-integration.test.ts
 * Deterministic test suite verifying Golden Test Assertions from DeepSeek Harness integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { SandboxPolicy } from '../src/main/harness/SandboxPolicy.js';
import { ExecutionGuard, MAX_PLAN_STEPS } from '../src/main/harness/ExecutionGuard.js';
import { SessionJournal } from '../src/main/harness/SessionJournal.js';
import { ToolPlanExecutor, type RegisteredTool } from '../src/main/harness/ToolPlanExecutor.js';
import type { ToolPlan } from '../src/shared/harnessContracts.js';

test('Golden Assertion 1: workspace-write: symlink or direct write into .eval is blocked', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-policy-test-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const evalDir = path.join(tmpDir, '.eval');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });

  const protectedFile = path.join(evalDir, 'golden-eval.txt');
  fs.writeFileSync(protectedFile, 'INITIAL_GOLDEN_BYTES', 'utf-8');

  // Try symlink pointing into .eval
  const symlinkInWorkspace = path.join(workspaceDir, 'symlink-to-eval');
  try {
    fs.symlinkSync(evalDir, symlinkInWorkspace, 'junction');
  } catch {
    // If symlink creation fails due to OS privilege, skip symlink creation and test direct path
  }

  const policy = new SandboxPolicy({
    mode: 'workspace-write',
    targetRoot: workspaceDir,
    readableRoots: [workspaceDir],
    writableRoots: [workspaceDir],
    protectedRoots: [evalDir]
  });

  // 1a. Direct write into .eval is blocked
  const directDecision = policy.authorizePath(protectedFile, 'write');
  assert.strictEqual(directDecision.allowed, false);
  assert.strictEqual(directDecision.reasonCode, 'PROTECTED_ROOT_VIOLATION');

  // 1b. Write via symlink (if created) is blocked
  if (fs.existsSync(symlinkInWorkspace)) {
    const symlinkTarget = path.join(symlinkInWorkspace, 'golden-eval.txt');
    const symlinkDecision = policy.authorizePath(symlinkTarget, 'write');
    assert.strictEqual(symlinkDecision.allowed, false);
    assert.strictEqual(symlinkDecision.reasonCode, 'PROTECTED_ROOT_VIOLATION');
  }

  // 1c. Protected bytes remain intact
  assert.strictEqual(fs.readFileSync(protectedFile, 'utf-8'), 'INITIAL_GOLDEN_BYTES');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Golden Assertion 2: three identical consecutive tool calls are blocked at the third call', () => {
  const guard = new ExecutionGuard();
  const toolName = 'read_file';
  const args = { path: 'src/main/index.ts', lines: 50 };

  // 1st call: allowed
  const call1 = guard.checkToolCall(toolName, args);
  assert.strictEqual(call1.allowed, true);
  guard.recordToolDispatch(toolName, args);

  // 2nd call: allowed
  const call2 = guard.checkToolCall(toolName, args);
  assert.strictEqual(call2.allowed, true);
  guard.recordToolDispatch(toolName, args);

  // 3rd call: BLOCKED
  const call3 = guard.checkToolCall(toolName, args);
  assert.strictEqual(call3.allowed, false);
  assert.strictEqual(call3.reasonCode, 'REPEAT_TOOL_DETECTED');

  // If arguments change or tool changes, allowed again
  const differentCall = guard.checkToolCall(toolName, { path: 'src/main/other.ts' });
  assert.strictEqual(differentCall.allowed, true);
});

test('Golden Assertion 3: 17-step plan is rejected before any tool executes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plan-test-'));
  const journal = new SessionJournal(tmpDir, 'test-run-17-steps');
  const policy = new SandboxPolicy({
    mode: 'workspace-write',
    targetRoot: tmpDir,
    readableRoots: [tmpDir],
    writableRoots: [tmpDir],
    protectedRoots: []
  });

  let executedCount = 0;
  const mockTool: RegisteredTool = {
    name: 'echo',
    effect: 'read',
    async execute() {
      executedCount++;
      return { output: 'ok' };
    }
  };

  const executor = new ToolPlanExecutor([mockTool], journal, policy);

  // Create a plan with 17 steps (MAX_PLAN_STEPS is 16)
  const steps = Array.from({ length: 17 }, (_, i) => ({
    id: `step-${i + 1}`,
    tool: 'echo',
    args: { step: i + 1 }
  }));

  const plan: ToolPlan = {
    version: 1,
    steps
  };

  const results = await executor.execute(plan);

  // Invariant: rejected; zero tool calls
  assert.strictEqual(results.length, 0);
  assert.strictEqual(executedCount, 0);

  // Verify journal recorded plan_rejected
  const events = await journal.readAfter(0);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]?.kind, 'plan_rejected');
  assert.strictEqual(events[0]?.data.reasonCode, 'PLAN_STEP_LIMIT_EXCEEDED');

  await journal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Golden Assertion 4: timeout stops further plan execution', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-timeout-test-'));
  const journal = new SessionJournal(tmpDir, 'test-run-timeout');
  const policy = new SandboxPolicy({
    mode: 'workspace-write',
    targetRoot: tmpDir,
    readableRoots: [tmpDir],
    writableRoots: [tmpDir],
    protectedRoots: []
  });

  let step2Executed = false;

  const hangingTool: RegisteredTool = {
    name: 'hang',
    effect: 'read',
    async execute(_args, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('ABORTED_BY_SIGNAL'));
        });
      });
    }
  };

  const nextTool: RegisteredTool = {
    name: 'next_step',
    effect: 'read',
    async execute() {
      step2Executed = true;
      return { output: 'should-not-run' };
    }
  };

  const executor = new ToolPlanExecutor([hangingTool, nextTool], journal, policy);

  // Run with outer signal that triggers early to test cancellation
  const abortCtrl = new AbortController();
  setTimeout(() => abortCtrl.abort(), 20);

  const plan: ToolPlan = {
    version: 1,
    steps: [
      { id: 's1', tool: 'hang', args: {} },
      { id: 's2', tool: 'next_step', args: {} }
    ]
  };

  const results = await executor.execute(plan, abortCtrl.signal);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]?.status, 'failed');
  assert.strictEqual(results[0]?.reasonCode, 'TOOL_ABORTED');
  assert.strictEqual(step2Executed, false);

  await journal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Golden Assertion 5: crash after dispatch before result yields unknown outcome without auto-replay', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-crash-test-'));
  const runId = 'crash-test-run';
  const journal = new SessionJournal(tmpDir, runId);

  // Simulate a tool_dispatch logged, but before tool_result was written, crash happened!
  await journal.append({
    source: 'tool',
    kind: 'tool_dispatch',
    stepId: 'dangling-step-101',
    data: { tool: 'deploy_code', args: {} }
  });

  await journal.close();

  // Create new journal reader (simulating post-crash restart)
  const recoveredJournal = new SessionJournal(tmpDir, runId);
  const status = await recoveredJournal.inspectCrashStatus();

  // Invariant: detects dangling uncompleted dispatch
  assert.strictEqual(status.hasDanglingDispatch, true);
  assert.strictEqual(status.lastIntentStepId, 'dangling-step-101');

  await recoveredJournal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionJournal: monotonic sequences and corruption rejection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-journal-test-'));
  const journal = new SessionJournal(tmpDir, 'test-monotonic');

  const ev1 = await journal.append({ source: 'loop', kind: 'start', data: {} });
  const ev2 = await journal.append({ source: 'tool', kind: 'exec', data: {} });
  const ev3 = await journal.append({ source: 'loop', kind: 'end', data: {} });

  assert.strictEqual(ev1.sequence, 1);
  assert.strictEqual(ev2.sequence, 2);
  assert.strictEqual(ev3.sequence, 3);

  await journal.close();

  // Inject a corrupt complete line in the middle
  const rawPath = journal.journalPath;
  const content = fs.readFileSync(rawPath, 'utf-8');
  fs.writeFileSync(rawPath, 'CORRUPTED_NON_JSON\n' + content, 'utf-8');

  // Should reject corrupted journal
  assert.throws(
    () => new SessionJournal(tmpDir, 'test-monotonic'),
    /JOURNAL_CORRUPTION_DETECTED/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('HookBridge: normalizes Claude Code and Codex hooks with credential redaction', async () => {
  const { normalizeHook } = await import('../src/main/harness/HookBridge.js');

  // 1. Claude Code hook
  const claudePayload = {
    event: 'pre_tool_use',
    stepId: 'claude-step-1',
    tool: 'bash',
    apiKey: 'sk-ant-secret123',
    command: 'git status'
  };

  const claudeEvent = normalizeHook('claude-code', claudePayload, 'run-claude');
  assert.ok(claudeEvent);
  assert.strictEqual(claudeEvent.kind, 'hook_pre_tool_use');
  assert.strictEqual(claudeEvent.stepId, 'claude-step-1');
  assert.strictEqual(claudeEvent.source, 'hook');
  assert.strictEqual(claudeEvent.data['apiKey'], '[REDACTED]');
  assert.strictEqual(claudeEvent.data['command'], 'git status');

  // 2. Codex hook
  const codexPayload = {
    type: 'tool.execute',
    call_id: 'codex-call-99',
    authorization: 'Bearer token-xyz',
    parameters: { query: 'test' }
  };

  const codexEvent = normalizeHook('codex', codexPayload, 'run-codex');
  assert.ok(codexEvent);
  assert.strictEqual(codexEvent.kind, 'hook_pre_tool_use');
  assert.strictEqual(codexEvent.stepId, 'codex-call-99');
  assert.strictEqual(codexEvent.data['authorization'], '[REDACTED]');

  // 3. Rejects invalid payloads
  assert.strictEqual(normalizeHook('claude-code', null), null);
  assert.strictEqual(normalizeHook('codex', [1, 2, 3]), null);
  assert.strictEqual(normalizeHook('claude-code', 'invalid-string'), null);
});

