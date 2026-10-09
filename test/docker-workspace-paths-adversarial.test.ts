import test from 'node:test';
import assert from 'node:assert/strict';
import { toContainerPath, toHostPath, type WorkspacePaths } from '../src/main/sandbox/workspace-paths.js';

test('Adversarial Path Probe 1: Windows UNC and device paths are strictly rejected', () => {
  const paths: WorkspacePaths = {
    hostRoot: 'D:\\Workspace\\kins-multiagents-ui',
    containerRoot: '/workspace'
  };

  assert.throws(
    () => toContainerPath('\\\\server\\share\\secret.txt', paths),
    /Ambiguous UNC or device path rejected/
  );

  assert.throws(
    () => toContainerPath('//server/share/secret.txt', paths),
    /Ambiguous UNC or device path rejected/
  );

  assert.throws(
    () => toContainerPath('\\\\?\\D:\\Workspace\\kins-multiagents-ui\\file.txt', paths),
    /Ambiguous UNC or device path rejected/
  );
});

test('Adversarial Path Probe 2: Multi-drive and sibling directory escapes are rejected', () => {
  const paths: WorkspacePaths = {
    hostRoot: 'D:\\Workspace\\kins-multiagents-ui',
    containerRoot: '/workspace'
  };

  // Cross-drive access
  assert.throws(
    () => toContainerPath('C:\\Windows\\System32\\cmd.exe', paths),
    /Path escape rejected/
  );

  // Sibling folder with same prefix
  assert.throws(
    () => toContainerPath('D:\\Workspace\\kins-multiagents-ui-sibling\\index.ts', paths),
    /Path escape rejected/
  );

  // Parent traversal escape
  assert.throws(
    () => toContainerPath('D:\\Workspace\\kins-multiagents-ui\\..\\other\\file.txt', paths),
    /Path escape rejected/
  );
});

test('Adversarial Path Probe 3: Container path traversal and foreign prefixes are rejected', () => {
  const paths: WorkspacePaths = {
    hostRoot: 'D:\\Workspace\\kins-multiagents-ui',
    containerRoot: '/workspace'
  };

  // Outside prefix
  assert.throws(
    () => toHostPath('/etc/passwd', paths),
    /Path escape rejected/
  );

  // Sibling container prefix
  assert.throws(
    () => toHostPath('/workspace-other/secret.txt', paths),
    /Path escape rejected/
  );

  // Traversal within container path
  assert.throws(
    () => toHostPath('/workspace/../etc/passwd', paths),
    /Path traversal rejected/
  );

  assert.throws(
    () => toHostPath('/workspace/sub/../../etc/passwd', paths),
    /Path traversal rejected/
  );
});
