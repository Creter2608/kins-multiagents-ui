/**
 * test/derive-messages-and-recovery.test.ts
 * Comprehensive unit & integration tests verifying:
 * 1. Pure event-sourced deriveMessages projection (anti-context-pollution).
 * 2. ToolCallRecovery tracking and idempotent crash/cancellation closing (anti-dangling-tools).
 * 3. HarnessService end-to-end integration with concurrent replay serialization.
 * 4. Circular JSON resilience & snake_case support.
 * 5. Bidirectional stepId/toolCallId correlation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { deriveMessages, safeStringify } from '../src/shared/deriveMessages.js';
import { ToolCallRecovery } from '../src/main/harness/ToolCallRecovery.js';
import { HarnessService } from '../src/main/services/HarnessService.js';
import type { SessionEvent } from '../src/shared/harnessContracts.js';

interface RecoveredPayload {
  readonly toolCallId?: string;
  readonly status?: string;
  readonly reasonCode?: string;
}

test('Golden Assertion 1: failed assistant stream attempt is omitted from model history by default', () => {
  const events: SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'loop',
      kind: 'system/message',
      data: { content: 'You are an AI assistant.' }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 2,
      timestamp: '2026-10-10T00:00:01.000Z',
      source: 'loop',
      kind: 'user/message',
      data: { content: 'Execute task X' }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 3,
      timestamp: '2026-10-10T00:00:02.000Z',
      source: 'loop',
      kind: 'assistant/attempt',
      data: { content: 'Half-baked stream that was aborted or crashed' }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 4,
      timestamp: '2026-10-10T00:00:03.000Z',
      source: 'loop',
      kind: 'assistant/message',
      data: { content: 'Final accepted message' }
    }
  ];

  const derived = deriveMessages(events);

  // Must contain only system, user, and final accepted assistant message
  assert.strictEqual(derived.length, 3);
  assert.strictEqual(derived[0]!.role, 'system');
  assert.strictEqual(derived[0]!.content, 'You are an AI assistant.');
  assert.strictEqual(derived[1]!.role, 'user');
  assert.strictEqual(derived[1]!.content, 'Execute task X');
  assert.strictEqual(derived[2]!.role, 'assistant');
  assert.strictEqual(derived[2]!.content, 'Final accepted message');

  // When includeAttempts is true, attempt is included
  const withAttempts = deriveMessages(events, { includeAttempts: true });
  assert.strictEqual(withAttempts.length, 4);
  assert.strictEqual(withAttempts[2]!.content, 'Half-baked stream that was aborted or crashed');
});

test('Golden Assertion 2: deriveMessages produces deterministic projection and skips telemetry events', () => {
  const events: SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-2',
      sequence: 1,
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'loop',
      kind: 'turn/start',
      data: { turn: 1 }
    },
    {
      schemaVersion: 1,
      runId: 'run-2',
      sequence: 2,
      timestamp: '2026-10-10T00:00:01.000Z',
      source: 'loop',
      kind: 'user/message',
      data: { content: 'List files' }
    },
    {
      schemaVersion: 1,
      runId: 'run-2',
      sequence: 3,
      timestamp: '2026-10-10T00:00:02.000Z',
      source: 'guard',
      kind: 'guard_check',
      data: { passed: true }
    },
    {
      schemaVersion: 1,
      runId: 'run-2',
      sequence: 4,
      timestamp: '2026-10-10T00:00:03.000Z',
      source: 'loop',
      kind: 'assistant/message',
      data: {
        content: 'Calling ls',
        toolCalls: [{ id: 'call_1', name: 'ls', arguments: { path: '.' } }]
      }
    },
    {
      schemaVersion: 1,
      runId: 'run-2',
      sequence: 5,
      timestamp: '2026-10-10T00:00:04.000Z',
      source: 'tool',
      kind: 'tool/result',
      stepId: 'step_1',
      data: { toolCallId: 'call_1', tool: 'ls', output: 'file1.txt\nfile2.txt' }
    }
  ];

  const runA = deriveMessages(events);
  const runB = deriveMessages(events);

  // Both runs must be identical and deterministic
  assert.deepStrictEqual(runA, runB);
  assert.strictEqual(runA.length, 3);
  assert.strictEqual(runA[0]!.role, 'user');
  assert.strictEqual(runA[1]!.role, 'assistant');
  assert.strictEqual(runA[1]!.toolCalls?.[0]?.id, 'call_1');
  assert.strictEqual(runA[2]!.role, 'tool');
  assert.strictEqual(runA[2]!.toolCallId, 'call_1');
  assert.strictEqual(runA[2]!.content, 'file1.txt\nfile2.txt');
});

test('Golden Assertion 3: ToolCallRecovery closes uncompleted tool calls and is idempotent', () => {
  const recovery = new ToolCallRecovery();

  // Assistant commits two tool calls
  recovery.observe({
    schemaVersion: 1,
    runId: 'run-3',
    sequence: 1,
    timestamp: '2026-10-10T00:00:00.000Z',
    source: 'loop',
    kind: 'assistant/message',
    data: {
      content: 'Running two tools',
      toolCalls: [
        { id: 'call_alpha', name: 'read_file', arguments: { path: 'a.txt' } },
        { id: 'call_beta', name: 'write_file', arguments: { path: 'b.txt' } }
      ]
    }
  });

  // Only tool call alpha succeeds
  recovery.observe({
    schemaVersion: 1,
    runId: 'run-3',
    sequence: 2,
    timestamp: '2026-10-10T00:00:01.000Z',
    source: 'tool',
    kind: 'tool/result',
    data: { toolCallId: 'call_alpha', tool: 'read_file', output: 'content of a' }
  });

  // Tool call beta is still unresolved
  const unresolvedBefore = recovery.unresolved();
  assert.strictEqual(unresolvedBefore.length, 1);
  assert.strictEqual(unresolvedBefore[0]!.id, 'call_beta');

  // Trigger recovery due to session cancellation/crash
  const syntheticEvents1 = recovery.recover('cancelled', 'USER_ABORT');
  assert.strictEqual(syntheticEvents1.length, 1);
  assert.strictEqual(syntheticEvents1[0]!.kind, 'tool/result');

  const payload = syntheticEvents1[0]!.data as RecoveredPayload;
  assert.strictEqual(payload.toolCallId, 'call_beta');
  assert.strictEqual(payload.status, 'cancelled');

  // Unresolved calls must now be empty
  const unresolvedAfter = recovery.unresolved();
  assert.strictEqual(unresolvedAfter.length, 0);

  // Second recover call must be idempotent (returns 0 events, no duplicate writes)
  const syntheticEvents2 = recovery.recover('cancelled', 'USER_ABORT');
  assert.strictEqual(syntheticEvents2.length, 0);
});

test('Golden Assertion 4: HarnessService end-to-end integration with deriveMessages and recoverPendingTools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-service-recovery-test-'));
  const service = new HarnessService(tmpDir, 'recovery-run');

  try {
    // 1. Record user message
    await service.recordEvent({
      source: 'loop',
      kind: 'user/message',
      data: { content: 'Please inspect codebase' }
    });

    // 2. Record assistant message with tool call
    await service.recordEvent({
      source: 'loop',
      kind: 'assistant/message',
      data: {
        content: 'Inspecting...',
        toolCalls: [{ id: 'call_inspect', name: 'search', arguments: { query: 'test' } }]
      }
    });

    // Tool call is unresolved
    assert.strictEqual((await service.getUnresolvedToolCalls()).length, 1);

    // 3. Simulate process crash / cancel -> recover
    const recovered = await service.recoverPendingTools('cancelled', 'CRASH_RECOVERY');
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual((await service.getUnresolvedToolCalls()).length, 0);

    // 4. Derive model messages from durable journal
    const derivedMessages = await service.getDerivedMessages();
    assert.strictEqual(derivedMessages.length, 3);
    assert.strictEqual(derivedMessages[0]!.role, 'user');
    assert.strictEqual(derivedMessages[1]!.role, 'assistant');
    assert.strictEqual(derivedMessages[2]!.role, 'tool');
    assert.strictEqual(derivedMessages[2]!.toolCallId, 'call_inspect');
    assert.match(derivedMessages[2]!.content, /\[RECOVERY\]/);
  } finally {
    await service.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 5: Crash/Restart Recovery: replaying persisted journal on fresh service instance recovers pending tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-crash-restart-test-'));
  const runId = 'crash-restart-run';

  // Instance 1: Starts run, commits tool call, then crashes abruptly (simulated by disposing without recovery)
  const service1 = new HarnessService(tmpDir, runId);
  await service1.recordEvent({
    source: 'loop',
    kind: 'assistant/message',
    data: {
      content: 'I will write the file',
      toolCalls: [{ id: 'call_crash_test', name: 'write_file', arguments: { path: 'test.txt' } }]
    }
  });
  await service1.dispose();

  // Instance 2: Fresh process start after crash. Replays journal from disk and recovers dangling tool
  const service2 = new HarnessService(tmpDir, runId);
  try {
    const unresolvedOnStartup = await service2.getUnresolvedToolCalls();
    assert.strictEqual(unresolvedOnStartup.length, 1);
    assert.strictEqual(unresolvedOnStartup[0]!.id, 'call_crash_test');

    const recovered = await service2.recoverPendingTools('cancelled', 'PROCESS_RESTARTED');
    assert.strictEqual(recovered.length, 1);
    const payload = recovered[0]!.data as RecoveredPayload;
    assert.strictEqual(payload.toolCallId, 'call_crash_test');

    const unresolvedAfterRecovery = await service2.getUnresolvedToolCalls();
    assert.strictEqual(unresolvedAfterRecovery.length, 0);

    // Model history now has clean user/assistant/tool messages with no hanging calls
    const messages = await service2.getDerivedMessages();
    assert.strictEqual(messages.length, 2); // assistant + recovered tool
    assert.strictEqual(messages[0]!.role, 'assistant');
    assert.strictEqual(messages[1]!.role, 'tool');
    assert.strictEqual(messages[1]!.toolCallId, 'call_crash_test');
  } finally {
    await service2.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 6: Circular JSON and BigInt never crash safeStringify or deriveMessages', () => {
  const circularObj: Record<string, unknown> = { key: 'hello' };
  circularObj.self = circularObj; // circular reference!

  const str = safeStringify(circularObj);
  assert.ok(str.includes('[Circular Reference]'));

  const bigintObj = { count: 9007199254740991n };
  const bigintStr = safeStringify(bigintObj);
  assert.ok(bigintStr.includes('9007199254740991n'));

  // Feed circular structure directly to deriveMessages
  const events: SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-circ',
      sequence: 1,
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'tool',
      kind: 'tool/result',
      data: { toolCallId: 'c1', tool: 'my_tool', output: circularObj }
    }
  ];

  const derived = deriveMessages(events);
  assert.strictEqual(derived.length, 1);
  assert.strictEqual(derived[0]!.role, 'tool');
  assert.ok(derived[0]!.content.includes('[Circular Reference]'));
});

test('Golden Assertion 7: snake_case tool_calls and tool_call_id are normalized seamlessly', () => {
  const events: SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-snake',
      sequence: 1,
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'loop',
      kind: 'assistant/message',
      data: {
        content: 'Calling python style',
        tool_calls: [{ id: 'py_call_1', name: 'python_tool', args: { x: 42 } }]
      }
    },
    {
      schemaVersion: 1,
      runId: 'run-snake',
      sequence: 2,
      timestamp: '2026-10-10T00:00:01.000Z',
      source: 'tool',
      kind: 'tool/result',
      data: { tool_call_id: 'py_call_1', result: '42' }
    }
  ];

  const derived = deriveMessages(events);
  assert.strictEqual(derived.length, 2);
  assert.strictEqual(derived[0]!.role, 'assistant');
  assert.strictEqual(derived[0]!.toolCalls?.[0]?.id, 'py_call_1');
  assert.strictEqual(derived[1]!.role, 'tool');
  assert.strictEqual(derived[1]!.toolCallId, 'py_call_1');
  assert.strictEqual(derived[1]!.content, '42');
});

test('Golden Assertion 8: Bidirectional stepId correlation resolves tool call when toolCallId is omitted', () => {
  const recovery = new ToolCallRecovery();

  recovery.observe({
    schemaVersion: 1,
    runId: 'run-step-corr',
    sequence: 1,
    timestamp: '2026-10-10T00:00:00.000Z',
    source: 'loop',
    kind: 'assistant/message',
    stepId: 'step_xyz',
    data: {
      content: 'Call with stepId',
      toolCalls: [{ id: 'call_in_step', name: 'tool_a', arguments: {} }]
    }
  });

  // Check unresolved
  assert.strictEqual(recovery.unresolved().length, 1);

  // Result event arrives with stepId only (no toolCallId in data)
  recovery.observe({
    schemaVersion: 1,
    runId: 'run-step-corr',
    sequence: 2,
    timestamp: '2026-10-10T00:00:01.000Z',
    source: 'tool',
    kind: 'tool/result',
    stepId: 'step_xyz',
    data: { output: 'Step finished' }
  });

  // Call associated with step_xyz must be resolved!
  assert.strictEqual(recovery.unresolved().length, 0);
});

test('Golden Assertion 9: Concurrent calls to HarnessService are serialized without replay race conditions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-concurrency-test-'));
  const service = new HarnessService(tmpDir, 'concurrent-run');

  try {
    // Fire 5 concurrent recordEvent calls at the exact same moment
    const promises = Array.from({ length: 5 }, (_, i) =>
      service.recordEvent({
        source: 'loop',
        kind: 'user/message',
        data: { content: `Message ${i + 1}` }
      })
    );

    const recorded = await Promise.all(promises);
    assert.strictEqual(recorded.length, 5);

    // All 5 sequences must be distinct and monotonic (1, 2, 3, 4, 5)
    const sequences = recorded.map((e) => e.sequence).sort((a, b) => a - b);
    assert.deepStrictEqual(sequences, [1, 2, 3, 4, 5]);

    const messages = await service.getDerivedMessages();
    assert.strictEqual(messages.length, 5);
  } finally {
    await service.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial Test SER-01: safeStringify preserves repeated references that are not cycles', () => {
  const shared = {
    status: 'ok',
    nested: { count: 2 },
  };
  const output = {
    first: shared,
    second: shared,
  };

  assert.deepEqual(
    JSON.parse(safeStringify(output)),
    JSON.parse(JSON.stringify(output)),
  );
});

test('Adversarial Test SER-02: safeStringify does not throw when JSON and string conversion both fail', () => {
  const output = {
    toJSON(): never {
      throw new Error('JSON conversion failed');
    },
    toString(): never {
      throw new Error('String conversion failed');
    },
  };

  let serialized: unknown;

  assert.doesNotThrow(() => {
    serialized = safeStringify(output);
  });
  assert.equal(typeof serialized, 'string');
});

test('Adversarial Test SER-03: safeStringify still terminates and marks a genuine circular reference', () => {
  const output: {
    label: string;
    self?: unknown;
  } = { label: 'root' };
  output.self = output;

  assert.deepEqual(JSON.parse(safeStringify(output)), {
    label: 'root',
    self: '[Circular Reference]',
  });
});
