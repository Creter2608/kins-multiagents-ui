import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SandboxPolicy } from '../src/main/harness/SandboxPolicy.js';

test(
  'POLICY-01: workspace .eval remains protected when configured roots are empty',
  async (t) => {
    const modes = ['workspace-write', 'danger-full-access'] as const;

    for (const mode of modes) {
      await t.test(mode, () => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), 'harness-required-protection-')
        );

        try {
          const evalRoot = path.join(root, '.eval');
          fs.mkdirSync(evalRoot);
          const target = path.join(evalRoot, 'golden.json');
          fs.writeFileSync(target, '{"immutable":true}\n');

          const policy = new SandboxPolicy({
            mode,
            targetRoot: root,
            readableRoots: [root],
            writableRoots: [root],
            protectedRoots: []
          });

          const decision = policy.authorizePath(target, 'write');

          assert.strictEqual(
            decision.allowed,
            false,
            `${mode} must not authorize writes to workspace .eval`
          );
          assert.strictEqual(
            decision.reasonCode,
            'PROTECTED_ROOT_VIOLATION'
          );
          assert.strictEqual(
            fs.readFileSync(target, 'utf8'),
            '{"immutable":true}\n'
          );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
);

test(
  'POLICY-02: a protected-root symlink also protects its real destination',
  () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'harness-protected-root-alias-')
    );

    try {
      const workspace = path.join(root, 'workspace');
      const actualProtectedRoot = path.join(root, 'protected-storage');
      fs.mkdirSync(workspace);
      fs.mkdirSync(actualProtectedRoot);

      const protectedAlias = path.join(root, 'protected-alias');
      fs.symlinkSync(actualProtectedRoot, protectedAlias, 'junction');

      const existingTarget = path.join(actualProtectedRoot, 'golden.txt');
      fs.writeFileSync(existingTarget, 'GOLDEN_BYTES');

      const policy = new SandboxPolicy({
        mode: 'danger-full-access',
        targetRoot: workspace,
        readableRoots: [workspace],
        writableRoots: [workspace],
        protectedRoots: [protectedAlias]
      });

      for (const target of [
        existingTarget,
        path.join(actualProtectedRoot, 'new-file.txt')
      ]) {
        const decision = policy.authorizePath(target, 'write');

        assert.strictEqual(
          decision.allowed,
          false,
          `Canonical protected destination was authorized: ${target}`
        );
        assert.strictEqual(
          decision.reasonCode,
          'PROTECTED_ROOT_VIOLATION'
        );
      }

      assert.strictEqual(
        fs.readFileSync(existingTarget, 'utf8'),
        'GOLDEN_BYTES'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'POLICY-03: read-only confinement follows symlinks without blocking allowed reads',
  () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'harness-read-confinement-')
    );

    try {
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      const explicitlyReadable = path.join(root, 'readable');
      fs.mkdirSync(workspace);
      fs.mkdirSync(outside);
      fs.mkdirSync(explicitlyReadable);

      const localFile = path.join(workspace, 'local.txt');
      const outsideFile = path.join(outside, 'secret.txt');
      const readableFile = path.join(explicitlyReadable, 'public.txt');

      fs.writeFileSync(localFile, 'LOCAL');
      fs.writeFileSync(outsideFile, 'SECRET');
      fs.writeFileSync(readableFile, 'PUBLIC');

      const escapeAlias = path.join(workspace, 'escape');
      fs.symlinkSync(outside, escapeAlias, 'junction');

      let hasFileSymlink = false;
      const localAlias = path.join(workspace, 'local-alias.txt');
      try {
        fs.symlinkSync(localFile, localAlias, 'file');
        hasFileSymlink = true;
      } catch {
        // Windows non-admin accounts disallow file symlinks; junctions handle directory aliases
      }

      const policy = new SandboxPolicy({
        mode: 'read-only',
        targetRoot: workspace,
        readableRoots: [workspace, explicitlyReadable],
        writableRoots: [],
        protectedRoots: []
      });

      assert.strictEqual(
        policy.authorizePath(localFile, 'read').allowed,
        true
      );
      if (hasFileSymlink) {
        assert.strictEqual(
          policy.authorizePath(localAlias, 'read').allowed,
          true
        );
      }
      assert.strictEqual(
        policy.authorizePath(readableFile, 'read').allowed,
        true
      );
      assert.strictEqual(
        policy.authorizePath(outsideFile, 'read').allowed,
        false
      );

      const escapedRead = policy.authorizePath(
        path.join(escapeAlias, 'secret.txt'),
        'read'
      );

      assert.strictEqual(
        escapedRead.allowed,
        false,
        'A workspace symlink must not authorize reading outside allowed roots'
      );
      assert.strictEqual(
        escapedRead.reasonCode,
        'OUTSIDE_READ_ROOTS'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
