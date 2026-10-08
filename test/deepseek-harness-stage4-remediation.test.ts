import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SandboxPolicy } from '../src/main/harness/SandboxPolicy.js';
import { SessionJournal } from '../src/main/harness/SessionJournal.js';
import {
  ToolPlanExecutor,
  type RegisteredTool
} from '../src/main/harness/ToolPlanExecutor.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  canonicalizeJson
} from '../src/main/harness/ExecutionGuard.js';
import type { ToolPlan } from '../src/shared/harnessContracts.js';

async function fixture(
  mode: 'read-only' | 'workspace-write' = 'workspace-write'
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-audit-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);

  const journal = new SessionJournal(path.join(root, 'user-data'), 'audit');
  const policy = new SandboxPolicy({
    mode,
    targetRoot: workspace,
    readableRoots: [],
    writableRoots: [],
    protectedRoots: []
  });

  return {
    root,
    workspace,
    journal,
    policy,
    async dispose() {
      await journal.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function singleStep(tool: string, id = 's1', args: Record<string, unknown> = {}): ToolPlan {
  return {
    version: 1,
    steps: [{ id, tool, args }]
  };
}

test('sandbox enforcement covers registered effects and dangling aliases (F1, F2)',
  async (t) => {
    await t.test('read-only policy blocks a registered write tool (F1)', async () => {
      const f = await fixture('read-only');
      let calls = 0;

      try {
        const tool: RegisteredTool = {
          name: 'write',
          effect: 'write',
          async execute() {
            calls++;
            return {};
          }
        };
        const executor = new ToolPlanExecutor(
          [tool], f.journal, f.policy
        );

        const results = await executor.execute(singleStep('write'));

        assert.equal(calls, 0, 'write tool must not dispatch in read-only mode');
        assert.equal(
          results.some((result) => result.status === 'succeeded'),
          false
        );
        assert.equal(
          (await f.journal.readAfter()).some(
            (event) => event.kind === 'tool_dispatch'
          ),
          false
        );
      } finally {
        await f.dispose();
      }
    });

    await t.test('dangling symlink into .eval is denied (F2)', async (st) => {
      const f = await fixture();

      try {
        const alias = path.join(f.workspace, 'alias');
        const protectedDestination = path.join(
          f.workspace, '.eval', 'not-created.txt'
        );

        // Creates only the alias, never the protected destination.
        try {
          await fs.symlink(protectedDestination, alias);
        } catch (symlinkErr: any) {
          if (process.platform === 'win32' && symlinkErr?.code === 'EPERM') {
            st.skip('Skipping dangling symlink test on Windows without symlink privileges');
            return;
          }
          throw symlinkErr;
        }

        assert.equal(
          f.policy.authorizePath(alias, 'write').allowed,
          false,
          'a dangling alias must not bypass protected-root checks'
        );
      } finally {
        await f.dispose();
      }
    });
  }
);

test('executor preserves bounded execution and runtime plan rejection (F3, F4, F5)',
  async (t) => {
    await t.test('concurrent identical requests dispatch at most twice (F4)',
      async () => {
        const f = await fixture();
        let calls = 0;

        try {
          const tool: RegisteredTool = {
            name: 'read',
            effect: 'read',
            async execute() {
              calls++;
              return {};
            }
          };
          const executor = new ToolPlanExecutor(
            [tool], f.journal, f.policy
          );

          await Promise.all([
            executor.execute(singleStep('read', 'a')),
            executor.execute(singleStep('read', 'b')),
            executor.execute(singleStep('read', 'c'))
          ]);

          assert.equal(calls, 2);
          const events = await f.journal.readAfter();
          assert.equal(
            events.filter((event) => event.kind === 'tool_dispatch').length,
            2
          );
          assert.equal(
            events.some((event) =>
              event.kind === 'tool_blocked' &&
              event.data.reasonCode === 'REPEAT_TOOL_DETECTED'
            ),
            true
          );
        } finally {
          await f.dispose();
        }
      }
    );

    await t.test('timeout settles without waiting for cooperative execution (F3)',
      async (context) => {
        const f = await fixture();
        context.mock.timers.enable({ apis: ['setTimeout'] });

        let finish!: () => void;
        let announceStart!: () => void;
        const started = new Promise<void>((resolve) => {
          announceStart = resolve;
        });
        const toolCompletion = new Promise<{ output: string }>((resolve) => {
          finish = () => resolve({ output: 'late result' });
        });

        let execution:
          Promise<readonly {
            status: string;
            reasonCode?: string;
          }[]> | undefined;

        try {
          const tool: RegisteredTool = {
            name: 'slow',
            effect: 'read',
            execute() {
              announceStart();
              return toolCompletion;
            }
          };
          const executor = new ToolPlanExecutor(
            [tool], f.journal, f.policy
          );

          let settled = false;
          execution = executor.execute(singleStep('slow'));
          void execution.then(
            () => { settled = true; },
            () => { settled = true; }
          );

          await started;
          context.mock.timers.tick(DEFAULT_TOOL_TIMEOUT_MS);

          // Drain journal I/O and promise continuations without advancing time.
          await f.journal.flush();
          await new Promise<void>((resolve) => setImmediate(resolve));

          const settledBeforeToolFinished = settled;

          // Always release the fixture tool
          finish();
          const results = await execution;

          assert.equal(
            settledBeforeToolFinished,
            true,
            'timeout must settle execution independently of the tool'
          );
          assert.equal(results[0]?.status, 'timed-out');
          assert.equal(results[0]?.reasonCode, 'TOOL_TIMEOUT');
        } finally {
          finish();
          if (execution) await execution;
          context.mock.timers.reset();
          await f.dispose();
        }
      }
    );

    await t.test('invalid plans reject without throwing or dispatching (F5)',
      async () => {
        const f = await fixture();
        let calls = 0;

        try {
          const tool: RegisteredTool = {
            name: 'read',
            effect: 'read',
            async execute() {
              calls++;
              return {};
            }
          };
          const executor = new ToolPlanExecutor(
            [tool], f.journal, f.policy
          );

          // Simulate untrusted transport inputs
          const invalidInputs: unknown[] = [
            { version: 1 },
            { version: 1, steps: [null] },
            {
              version: 1,
              steps: [{ id: 'bad', tool: 'read', args: null }]
            }
          ];

          for (const input of invalidInputs) {
            const results = await executor.execute(input as ToolPlan);
            assert.deepEqual(results, []);
          }

          assert.equal(calls, 0);
          const events = await f.journal.readAfter();
          assert.equal(
            events.filter((event) => event.kind === 'plan_rejected').length,
            invalidInputs.length
          );
          assert.equal(
            events.some((event) => event.kind === 'tool_dispatch'),
            false
          );
        } finally {
          await f.dispose();
        }
      }
    );
  }
);

test('journal recovery and failed appends preserve committed ordering (F6, F7)',
  async (t) => {
    await t.test('recovered incomplete tail cannot hide new records (F6)',
      async () => {
        const f = await fixture();
        let reopened: SessionJournal | undefined;

        try {
          await f.journal.append({
            source: 'loop',
            kind: 'first',
            data: {}
          });
          await f.journal.close();

          const committed = await fs.readFile(f.journal.journalPath);
          await fs.appendFile(
            f.journal.journalPath,
            '{"schemaVersion":1,"sequence":2'
          );

          reopened = new SessionJournal(
            path.join(f.root, 'user-data'), 'audit'
          );
          const next = await reopened.append({
            source: 'loop',
            kind: 'second',
            data: {}
          });

          assert.equal(next.sequence, 2);
          assert.deepEqual(
            (await reopened.readAfter()).map((event) => event.sequence),
            [1, 2]
          );

          const recovered = await fs.readFile(reopened.journalPath);
          assert.deepEqual(
            recovered.subarray(0, committed.length),
            committed,
            'recovery must preserve every committed byte'
          );
        } finally {
          if (reopened) await reopened.close();
          await f.dispose();
        }
      }
    );

    await t.test('serialization failure does not consume a sequence (F7)',
      async () => {
        const f = await fixture();
        let reopened: SessionJournal | undefined;

        try {
          await f.journal.append({
            source: 'loop',
            kind: 'first',
            data: {}
          });

          const circular: Record<string, unknown> = {};
          circular.self = circular;

          await assert.rejects(
            f.journal.append({
              source: 'loop',
              kind: 'invalid',
              data: circular
            }),
            /circular/i
          );

          const next = await f.journal.append({
            source: 'loop',
            kind: 'second',
            data: {}
          });

          assert.equal(next.sequence, 2);
          await f.journal.close();

          reopened = new SessionJournal(
            path.join(f.root, 'user-data'), 'audit'
          );
          assert.deepEqual(
            (await reopened.readAfter()).map((event) => event.sequence),
            [1, 2]
          );
        } finally {
          if (reopened) await reopened.close();
          await f.dispose();
        }
      }
    );
  }
);

test('dispatch keys distinguish nested argument values (A2 counterexample)', () => {
  const first = canonicalizeJson({ payload: { value: 1 } });
  const second = canonicalizeJson({ payload: { value: 2 } });
  assert.notEqual(
    first,
    second,
    'Distinct nested argument values must not share a dispatch fingerprint'
  );

  const arrayFirst = canonicalizeJson({ items: [1, 2] });
  const arraySecond = canonicalizeJson({ items: [2, 1] });
  assert.notEqual(
    arrayFirst,
    arraySecond,
    'Array order must be preserved deterministically'
  );
});

