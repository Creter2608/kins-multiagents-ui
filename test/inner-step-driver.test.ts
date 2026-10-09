/**
 * test/inner-step-driver.test.ts
 * Rigorous test suite for Stage 2 Inner Step Loop (InnerStepDriver + ExecutionGuard).
 * Verifies all 5 Golden Assertions from Stage 2 Technical Blueprint + Edge Cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { InnerStepDriver } from '../src/main/harness/InnerStepDriver.js';
import { ExecutionGuard } from '../src/main/harness/ExecutionGuard.js';
import { HarnessService } from '../src/main/services/HarnessService.js';
import type {
  ModelStepProvider,
  ToolDispatcher,
  ModelStepResult,
  ToolDispatchContext
} from '../src/shared/inner-step.js';
import type { ModelMessage, ToolCall, ToolResult } from '../src/shared/harnessContracts.js';

test('Golden Assertion 1: tool A succeeds; next model stops -> 2 steps, ordered lifecycle, completed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-ga1-'));
  const runId = 'run-ga1';
  const harness = new HarnessService(tmpDir, runId);

  try {
    let modelCallCount = 0;
    const model: ModelStepProvider = {
      async modelStep(messages: readonly ModelMessage[]): Promise<ModelStepResult> {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: 'Step 1: executing tool A',
            toolCalls: [{ id: 'call_A', name: 'tool_A', arguments: { target: 'file.txt' } }],
            finishReason: 'tool-calls'
          };
        } else {
          return {
            content: 'Step 2: task finished',
            toolCalls: [],
            finishReason: 'stop'
          };
        }
      }
    };

    const dispatchedCalls: string[] = [];
    const tools: ToolDispatcher = {
      async dispatch(call: ToolCall, _ctx: ToolDispatchContext): Promise<ToolResult> {
        dispatchedCalls.push(call.id);
        return {
          status: 'succeeded',
          stepId: 'step-1',
          tool: call.name,
          output: 'tool A output content'
        };
      }
    };

    const driver = new InnerStepDriver({ harness, model, tools }, { maxStepsPerTurn: 5 });
    const abortCtrl = new AbortController();

    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: abortCtrl.signal
    });

    assert.strictEqual(result.runId, runId);
    assert.strictEqual(result.turn, 1);
    assert.strictEqual(result.steps, 2);
    assert.strictEqual(result.reason.kind, 'completed');
    assert.deepStrictEqual(dispatchedCalls, ['call_A']);

    // Verify persisted event sequence and 1:1 lifecycle pairing
    const events = await harness.getEvents(100);
    const kinds = events.map(e => e.kind);

    assert.deepStrictEqual(kinds, [
      'turn/start',
      'step/start',
      'assistant/message',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end'
    ]);
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 2: limit=2; every step requests distinct tools -> 2 model calls, step-limit', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-ga2-'));
  const runId = 'run-ga2';
  const harness = new HarnessService(tmpDir, runId);

  try {
    let stepCounter = 0;
    const model: ModelStepProvider = {
      async modelStep(): Promise<ModelStepResult> {
        stepCounter++;
        return {
          content: `Step ${stepCounter} requesting distinct tool`,
          toolCalls: [{ id: `call_${stepCounter}`, name: `tool_${stepCounter}`, arguments: { step: stepCounter } }],
          finishReason: 'tool-calls'
        };
      }
    };

    const tools: ToolDispatcher = {
      async dispatch(call: ToolCall): Promise<ToolResult> {
        return {
          status: 'succeeded',
          stepId: call.id,
          tool: call.name,
          output: `Output of ${call.name}`
        };
      }
    };

    // Strict limit: 2 steps max
    const driver = new InnerStepDriver({ harness, model, tools }, { maxStepsPerTurn: 2 });
    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: new AbortController().signal
    });

    assert.strictEqual(result.steps, 2);
    assert.strictEqual(result.reason.kind, 'step-limit');
    assert.strictEqual(stepCounter, 2);

    const events = await harness.getEvents(100);
    const lastEvent = events[events.length - 1];
    assert.strictEqual(lastEvent?.kind, 'turn/end');
    const reasonData = lastEvent?.data?.reason as { kind?: string } | undefined;
    assert.strictEqual(reasonData?.kind, 'step-limit');
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 3: A({x:1,y:2}), A({y:2,x:1}) -> 1 dispatch, duplicate blocked, error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-ga3-'));
  const runId = 'run-ga3';
  const harness = new HarnessService(tmpDir, runId);

  try {
    const model: ModelStepProvider = {
      async modelStep(): Promise<ModelStepResult> {
        return {
          content: 'Model attempting duplicate consecutive calls with reordered keys',
          toolCalls: [
            { id: 'call_1', name: 'search_code', arguments: { x: 1, y: 2 } },
            { id: 'call_2', name: 'search_code', arguments: { y: 2, x: 1 } }
          ],
          finishReason: 'tool-calls'
        };
      }
    };

    const dispatched: string[] = [];
    const tools: ToolDispatcher = {
      async dispatch(call: ToolCall): Promise<ToolResult> {
        dispatched.push(call.id);
        return {
          status: 'succeeded',
          stepId: call.id,
          tool: call.name,
          output: 'search results'
        };
      }
    };

    const driver = new InnerStepDriver({ harness, model, tools }, { maxStepsPerTurn: 5 });
    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: new AbortController().signal
    });

    // Only 1 dispatch permitted before duplicate blocked
    assert.deepStrictEqual(dispatched, ['call_1']);
    assert.strictEqual(result.reason.kind, 'error');

    const events = await harness.getEvents(100);
    const toolResults = events.filter(e => e.kind === 'tool/result');

    assert.strictEqual(toolResults.length, 2);
    assert.strictEqual(toolResults[0]?.data?.status, 'succeeded');
    assert.strictEqual(toolResults[1]?.data?.status, 'blocked');
    assert.strictEqual(toolResults[1]?.data?.reasonCode, 'duplicate-tool-call');
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 4: max-tokens+tool; next step stops -> sticky max-tokens turn outcome', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-ga4-'));
  const runId = 'run-ga4';
  const harness = new HarnessService(tmpDir, runId);

  try {
    let stepCount = 0;
    const model: ModelStepProvider = {
      async modelStep(): Promise<ModelStepResult> {
        stepCount++;
        if (stepCount === 1) {
          return {
            content: 'Step 1 truncated by token budget',
            toolCalls: [{ id: 'call_trunc', name: 'fetch_data', arguments: { id: 101 } }],
            finishReason: 'max-tokens'
          };
        } else {
          return {
            content: 'Step 2 completes normally',
            toolCalls: [],
            finishReason: 'stop'
          };
        }
      }
    };

    const tools: ToolDispatcher = {
      async dispatch(call: ToolCall): Promise<ToolResult> {
        return {
          status: 'succeeded',
          stepId: call.id,
          tool: call.name,
          output: 'data fetched'
        };
      }
    };

    const driver = new InnerStepDriver({ harness, model, tools }, { maxStepsPerTurn: 5 });
    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: new AbortController().signal
    });

    assert.strictEqual(result.steps, 2);
    // Sticky max-tokens wins over completed
    assert.strictEqual(result.reason.kind, 'max-tokens');

    const events = await harness.getEvents(100);
    const turnEnd = events.find(e => e.kind === 'turn/end');
    const turnEndReason = turnEnd?.data?.reason as { kind?: string } | undefined;
    assert.strictEqual(turnEndReason?.kind, 'max-tokens');
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 5: abort during first of 2 pending tools -> no second dispatch, 2 terminal results, aborted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-ga5-'));
  const runId = 'run-ga5';
  const harness = new HarnessService(tmpDir, runId);

  try {
    const abortCtrl = new AbortController();

    const model: ModelStepProvider = {
      async modelStep(): Promise<ModelStepResult> {
        return {
          content: 'Model issues 2 tools',
          toolCalls: [
            { id: 'call_long_1', name: 'heavy_op_1', arguments: {} },
            { id: 'call_long_2', name: 'heavy_op_2', arguments: {} }
          ],
          finishReason: 'tool-calls'
        };
      }
    };

    const dispatched: string[] = [];
    const tools: ToolDispatcher = {
      async dispatch(call: ToolCall): Promise<ToolResult> {
        dispatched.push(call.id);
        // Abort while first tool is in-flight
        abortCtrl.abort();
        return {
          status: 'failed',
          stepId: call.id,
          tool: call.name,
          reasonCode: 'aborted'
        };
      }
    };

    const driver = new InnerStepDriver({ harness, model, tools }, { maxStepsPerTurn: 5 });
    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: abortCtrl.signal
    });

    assert.strictEqual(result.reason.kind, 'aborted');
    assert.deepStrictEqual(dispatched, ['call_long_1']); // Call 2 never dispatched

    // Verify ToolCallRecovery cleanly settled both tool calls with terminal results
    const unresolved = await harness.getUnresolvedToolCalls();
    assert.strictEqual(unresolved.length, 0);

    const derived = await harness.getDerivedMessages();
    const toolMessages = derived.filter(m => m.role === 'tool');
    assert.strictEqual(toolMessages.length, 2);
    assert.strictEqual(toolMessages[0]?.toolCallId, 'call_long_1');
    assert.strictEqual(toolMessages[1]?.toolCallId, 'call_long_2');
    assert.match(toolMessages[1]?.content ?? '', /\[RECOVERY\]/);
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Edge Case: Pre-aborted signal returns 0 steps and emits no events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-step-pre-abort-'));
  const runId = 'run-pre-abort';
  const harness = new HarnessService(tmpDir, runId);

  try {
    const model: ModelStepProvider = {
      async modelStep(): Promise<ModelStepResult> {
        throw new Error('Should not be called');
      }
    };
    const tools: ToolDispatcher = {
      async dispatch(): Promise<ToolResult> {
        throw new Error('Should not be called');
      }
    };

    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const driver = new InnerStepDriver({ harness, model, tools });
    const result = await driver.runTurn({
      runId,
      turn: 1,
      signal: abortCtrl.signal
    });

    assert.strictEqual(result.steps, 0);
    assert.strictEqual(result.reason.kind, 'aborted');

    const events = await harness.getEvents(10);
    assert.strictEqual(events.length, 0);
  } finally {
    await harness.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Edge Case: ExecutionGuard fingerprint handles nested objects and arrays correctly', () => {
  const guard = new ExecutionGuard();

  // Object keys reordered -> considered identical
  const callA1 = { name: 'calc', arguments: { a: 1, b: { inner: 'val', num: 42 } } };
  const callA2 = { name: 'calc', arguments: { b: { num: 42, inner: 'val' }, a: 1 } };
  assert.strictEqual(guard.acceptToolCall(callA1), true);
  assert.strictEqual(guard.acceptToolCall(callA2), false); // 2nd consecutive -> blocked!

  // Intervening distinct call resets
  const callB = { name: 'diff_tool', arguments: {} };
  assert.strictEqual(guard.acceptToolCall(callB), true);

  // Now callA is permitted again
  assert.strictEqual(guard.acceptToolCall(callA1), true);

  // Array elements in different order -> NOT identical!
  guard.reset();
  const arr1 = { name: 'sort', arguments: { list: [1, 2, 3] } };
  const arr2 = { name: 'sort', arguments: { list: [3, 2, 1] } };
  assert.strictEqual(guard.acceptToolCall(arr1), true);
  assert.strictEqual(guard.acceptToolCall(arr2), true); // Different array order -> allowed!
});
