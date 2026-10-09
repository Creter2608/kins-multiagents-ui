/**
 * test/spill-store-and-compaction.test.ts
 * Verification suite for Stage 4: Spill Storage and Context Compaction.
 * Covers all 5 Golden Assertions from Stage 2 Blueprint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalSpillStore, formatToolOutput, type SaveSpillInput, type SpillOutputOptions } from '../src/main/harness/SpillStore.js';
import { deriveMessages } from '../src/shared/deriveMessages.js';
import type { SessionEvent } from '../src/shared/harnessContracts.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Golden Assertion 1: ASCII output exactly at both inline limits -> original unchanged', async () => {
  const tmpDir = createTempDir('spill-test-');
  try {
    const store = new LocalSpillStore(tmpDir);
    const content = 'hello-world'; // 11 chars, 11 bytes
    const input: SaveSpillInput = {
      owner: { sessionId: 'session-1' },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-1' },
      suggestedName: 'test.txt',
      content
    };
    const options: SpillOutputOptions = {
      maxInlineBytes: 11,
      maxInlineChars: 11,
      headPreviewChars: 5
    };

    const result = await formatToolOutput(store, input, options);
    assert.equal(result, content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 2: éé; maxInlineBytes=3; successful spill -> stored UTF-8 bytes=4; pointer+preview', async () => {
  const tmpDir = createTempDir('spill-test-');
  try {
    const store = new LocalSpillStore(tmpDir);
    const content = 'éé'; // 2 chars, 4 bytes
    const input: SaveSpillInput = {
      owner: { sessionId: 'session-unicode' },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-2' },
      suggestedName: 'unicode.txt',
      content
    };
    const options: SpillOutputOptions = {
      maxInlineBytes: 3, // 4 > 3 -> triggers spill
      maxInlineChars: 10,
      headPreviewChars: 10
    };

    const result = await formatToolOutput(store, input, options);

    // Verify pointer format and preview
    assert.match(result, /\[Output spilled to disk \(4 bytes\)\. Use read_file at: (.*?)\]/);
    assert.match(result, /Preview:\r?\néé/);

    // Extract path and check disk content
    const match = /Use read_file at: (.*?)]/.exec(result);
    assert.ok(match && match[1]);
    const filePath = match[1];
    assert.ok(fs.existsSync(filePath));
    const diskContent = fs.readFileSync(filePath, 'utf-8');
    assert.equal(diskContent, content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 3: oversized output; disk write fails -> bounded inline fallback; no pointer', async () => {
  const tmpDir = createTempDir('spill-test-');
  try {
    const store = new LocalSpillStore(tmpDir);
    // Invalid sessionId to intentionally cause saveText to fail
    const input: SaveSpillInput = {
      owner: { sessionId: '../escape-session' },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-3' },
      suggestedName: 'fail.txt',
      content: 'A'.repeat(500)
    };
    const options: SpillOutputOptions = {
      maxInlineBytes: 100,
      maxInlineChars: 100,
      headPreviewChars: 20
    };

    const result = await formatToolOutput(store, input, options);

    // Must not output disk pointer
    assert.equal(result.includes('Output spilled to disk'), false);
    assert.equal(result.includes('Use read_file at:'), false);

    // Must contain fallback truncation marker
    assert.ok(result.includes('... [output truncated; spill unavailable]'));

    // Bounded within limits
    assert.ok(result.length <= options.maxInlineChars);
    assert.ok(Buffer.byteLength(result, 'utf8') <= options.maxInlineBytes);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 4: completed tool=abcdefghij; threshold=5; head=1; tail=1 -> abcdefghij; pruning marker would expand', () => {
  const events: readonly SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/start',
      data: { turn: 1 }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 2,
      timestamp: new Date().toISOString(),
      source: 'tool',
      kind: 'tool/result',
      data: {
        turn: 1,
        toolCallId: 'call-1',
        output: 'abcdefghij'
      }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 3,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/end',
      data: { turn: 1 }
    }
  ];

  const messages = deriveMessages(events, {
    compaction: {
      enabled: true,
      thresholdChars: 5,
      headChars: 1,
      tailChars: 1
    }
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'tool');
  // Since pruning would expand length from 10 to 35, it must remain unpruned
  assert.equal(messages[0]?.content, 'abcdefghij');
});

test('Golden Assertion 5: active-turn tool above threshold; assistant text -> both unchanged', () => {
  const largeOutput = 'X'.repeat(50000);
  const events: readonly SessionEvent[] = [
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/start',
      data: { turn: 1 }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 2,
      timestamp: new Date().toISOString(),
      source: 'transcript',
      kind: 'assistant/message',
      data: {
        turn: 1,
        content: 'Assistant reasoning that must never be pruned.'
      }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 3,
      timestamp: new Date().toISOString(),
      source: 'tool',
      kind: 'tool/result',
      data: {
        turn: 1,
        toolCallId: 'call-active',
        output: largeOutput
      }
    }
    // No turn/end -> turn 1 is actively open!
  ];

  const messages = deriveMessages(events, {
    compaction: {
      enabled: true,
      thresholdChars: 100,
      headChars: 20,
      tailChars: 20
    }
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.content, 'Assistant reasoning that must never be pruned.');

  assert.equal(messages[1]?.role, 'tool');
  // Active turn tool output must NOT be pruned!
  assert.equal(messages[1]?.content, largeOutput);
});

test('Context Compaction: completed turn tool above threshold is cleanly pruned when shorter', () => {
  const largeOutput = 'A'.repeat(500) + 'MIDDLE_SECTION' + 'Z'.repeat(500);
  const events: readonly SessionEvent[] = [
    // Completed Turn 1
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/start',
      data: { turn: 1 }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 2,
      timestamp: new Date().toISOString(),
      source: 'tool',
      kind: 'tool/result',
      data: {
        turn: 1,
        toolCallId: 'call-turn-1',
        output: largeOutput
      }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 3,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/end',
      data: { turn: 1 }
    },
    // Active Turn 2
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 4,
      timestamp: new Date().toISOString(),
      source: 'loop',
      kind: 'turn/start',
      data: { turn: 2 }
    },
    {
      schemaVersion: 1,
      runId: 'run-1',
      sequence: 5,
      timestamp: new Date().toISOString(),
      source: 'tool',
      kind: 'tool/result',
      data: {
        turn: 2,
        toolCallId: 'call-turn-2',
        output: largeOutput
      }
    }
  ];

  const messages = deriveMessages(events, {
    compaction: {
      enabled: true,
      thresholdChars: 100,
      headChars: 20,
      tailChars: 20
    }
  });

  assert.equal(messages.length, 2);

  // Turn 1 (completed): pruned
  const tool1 = messages[0]!;
  assert.equal(tool1.role, 'tool');
  assert.ok(tool1.content.startsWith('A'.repeat(20)));
  assert.ok(tool1.content.endsWith('Z'.repeat(20)));
  assert.ok(tool1.content.includes('[pruned'));
  assert.ok(tool1.content.length < largeOutput.length);

  // Turn 2 (active): unpruned
  const tool2 = messages[1]!;
  assert.equal(tool2.role, 'tool');
  assert.equal(tool2.content, largeOutput);
});

test('Adversarial Probe 1: saveText rejects symlinked spill and session directories without external writes', async () => {
  const root = createTempDir('spill-symlink-audit-');

  try {
    for (const placement of ['spill-root', 'session-directory'] as const) {
      const userData = path.join(root, placement);
      const outside = path.join(root, `${placement}-outside`);

      fs.mkdirSync(userData, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });

      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      if (placement === 'spill-root') {
        fs.symlinkSync(outside, path.join(userData, 'spill'), linkType);
      } else {
        fs.mkdirSync(path.join(userData, 'spill'), { recursive: true });
        fs.symlinkSync(
          outside,
          path.join(userData, 'spill', 'session-1'),
          linkType
        );
      }

      const store = new LocalSpillStore(userData);

      await assert.rejects(() =>
        store.saveText({
          owner: { sessionId: 'session-1' },
          source: {
            kind: 'tool',
            toolName: 'bash',
            callId: 'symlink-call',
          },
          suggestedName: 'result.txt',
          content: 'must never be written outside application storage',
        })
      );

      assert.deepEqual(
        fs.readdirSync(outside),
        [],
        `${placement} must not permit external writes`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Adversarial Probe 2: invalid formatter limits reject before persistence or fallback', async () => {
  type SaveInput = Parameters<LocalSpillStore['saveText']>[0];

  class PersistenceProbe extends LocalSpillStore {
    attempts = 0;

    override async saveText(_input: SaveInput): ReturnType<LocalSpillStore['saveText']> {
      this.attempts += 1;
      throw new Error('persistence must not be attempted');
    }
  }

  const store = new PersistenceProbe(path.join(os.tmpdir(), 'unused-spill-validation-probe'));

  const input: SaveInput = {
    owner: { sessionId: 'session-1' },
    source: {
      kind: 'tool',
      toolName: 'bash',
      callId: 'validation-call',
    },
    suggestedName: 'result.txt',
    content: 'X'.repeat(100),
  };

  const keys = ['maxInlineBytes', 'maxInlineChars', 'headPreviewChars'] as const;

  for (const key of keys) {
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const options = {
        maxInlineBytes: 1,
        maxInlineChars: 1,
        headPreviewChars: 0,
        [key]: invalid,
      };

      await assert.rejects(
        () => formatToolOutput(store, input, options as any),
        `${key}=${String(invalid)} must reject explicitly`
      );
    }
  }

  assert.equal(store.attempts, 0);
});

test('Adversarial Probe 3: unmatched and ambiguous turn boundaries preserve frozen tool output', () => {
  const content = 'A'.repeat(2048);

  const event = (
    sequence: number,
    kind: SessionEvent['kind'],
    data: SessionEvent['data']
  ): SessionEvent =>
    Object.freeze({
      schemaVersion: 1,
      runId: 'audit-run',
      sequence,
      timestamp: '2026-01-01T00:00:00.000Z',
      source: kind === 'tool/result' ? 'tool' : 'loop',
      kind,
      data: Object.freeze(data),
    });

  const cases: readonly (readonly SessionEvent[])[] = [
    // An end without a matching start cannot establish eligibility.
    Object.freeze([
      event(1, 'tool/result', {
        turn: 1,
        toolCallId: 'missing-start',
        output: content,
      }),
      event(2, 'turn/end', { turn: 1 }),
    ]),
    // Duplicate starts with the same identifier make attribution ambiguous.
    Object.freeze([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/start', { turn: 1 }),
      event(3, 'tool/result', {
        turn: 1,
        toolCallId: 'duplicate-start',
        output: content,
      }),
      event(4, 'turn/end', { turn: 1 }),
    ]),
  ];

  for (const events of cases) {
    const snapshot = JSON.stringify(events);
    const options = {
      compaction: {
        enabled: true,
        thresholdChars: 100,
        headChars: 10,
        tailChars: 0,
      },
    };

    const first = deriveMessages(events, options);
    const second = deriveMessages(events, options);

    assert.equal(first.length, 1);
    assert.equal(first[0]?.role, 'tool');
    assert.equal(first[0]?.content, content);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(events), snapshot);
  }
});

