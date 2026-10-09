/**
 * test/docker-tool-dispatcher.test.ts
 * Rigorous test suite for Stage 3 Docker-First Capability Seam (DockerToolDispatcher + WorkspacePaths).
 * Verifies all 5 Golden Assertions from Stage 3 Technical Blueprint + Edge Cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { toContainerPath, toHostPath, type WorkspacePaths } from '../src/main/sandbox/workspace-paths.js';
import {
  DockerToolDispatcher,
  type DockerToolDispatcherDependencies
} from '../src/main/sandbox/docker-tool-dispatcher.js';
import type {
  ContainerExecutionSeam,
  ContainerExecutionRequest,
  ContainerExecutionOutcome
} from '../src/main/sandbox/container-execution-seam.js';
import { DockerStatusService } from '../src/main/services/DockerStatusService.js';
import { SandboxPolicy } from '../src/main/harness/SandboxPolicy.js';
import type { DockerSandboxStatus } from '../src/shared/contracts.js';

class MockDockerStatusService extends DockerStatusService {
  private mockStatus: DockerSandboxStatus;

  constructor(status: DockerSandboxStatus) {
    super('mock_container');
    this.mockStatus = status;
  }

  override getStatus(): DockerSandboxStatus {
    return this.mockStatus;
  }

  override async checkStatus(): Promise<DockerSandboxStatus> {
    return this.mockStatus;
  }

  setStatus(status: DockerSandboxStatus): void {
    this.mockStatus = status;
  }
}

class MockContainerExecutionSeam implements ContainerExecutionSeam {
  public executedRequests: ContainerExecutionRequest[] = [];
  public nextOutcome: ContainerExecutionOutcome = {
    exitCode: 0,
    stdout: 'mock docker execution succeeded',
    stderr: '',
    termination: 'exited'
  };

  async execute(request: ContainerExecutionRequest): Promise<ContainerExecutionOutcome> {
    this.executedRequests.push(request);
    return this.nextOutcome;
  }
}

function setupTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dispatcher-test-'));
  const hostRoot = path.resolve(tmpDir, 'workspace');
  fs.mkdirSync(hostRoot, { recursive: true });

  const protectedEvalDir = path.resolve(hostRoot, '.eval');
  fs.mkdirSync(protectedEvalDir, { recursive: true });
  fs.writeFileSync(path.join(protectedEvalDir, 'golden.json'), '{"protected": true}');

  const paths: WorkspacePaths = {
    hostRoot,
    containerRoot: '/workspace'
  };

  const policy = new SandboxPolicy({
    mode: 'workspace-write',
    targetRoot: hostRoot,
    readableRoots: [hostRoot],
    writableRoots: [hostRoot],
    protectedRoots: [protectedEvalDir]
  });

  return { tmpDir, hostRoot, protectedEvalDir, paths, policy };
}

test('Golden Assertion 3: Path Translation round-trip and sibling escape rejection', () => {
  const paths: WorkspacePaths = {
    hostRoot: path.resolve('D:/Workspace/app'),
    containerRoot: '/workspace'
  };

  // 1. Root mapping
  assert.strictEqual(toContainerPath(paths.hostRoot, paths), '/workspace');
  assert.strictEqual(toHostPath('/workspace', paths), paths.hostRoot);

  // 2. Descendant round-trip
  const hostSub = path.resolve(paths.hostRoot, 'src', 'main.ts');
  const containerSub = toContainerPath(hostSub, paths);
  assert.strictEqual(containerSub, '/workspace/src/main.ts');
  assert.strictEqual(toHostPath(containerSub, paths), hostSub);

  // 3. Sibling escape rejection (e.g. D:/Workspace/app-other)
  const sibling = path.resolve('D:/Workspace/app-other/src');
  assert.throws(
    () => toContainerPath(sibling, paths),
    /Path escape rejected/
  );

  // 4. Traversal escape rejection
  assert.throws(
    () => toHostPath('/workspace/../../etc/passwd', paths),
    /Path traversal rejected/
  );
  assert.throws(
    () => toHostPath('/etc/passwd', paths),
    /Path escape rejected/
  );
});

test('Golden Assertion 1: Active, confined shell -> Docker only; no host execution', async () => {
  const env = setupTestEnvironment();
  try {
    const dockerStatus = new MockDockerStatusService('Active');
    const seam = new MockContainerExecutionSeam();
    const dispatcher = new DockerToolDispatcher({
      dockerStatus,
      policy: env.policy,
      seam,
      paths: env.paths
    });

    const result = await dispatcher.dispatch(
      {
        id: 'call_sh_1',
        name: 'run_command',
        arguments: { command: 'npm test', cwd: path.join(env.hostRoot, 'sub') }
      },
      {
        runId: 'run-1',
        stepId: 'step-1',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.tool, 'run_command');
    assert.strictEqual(seam.executedRequests.length, 1);
    assert.strictEqual(seam.executedRequests[0]?.command, 'npm test');
    assert.strictEqual(seam.executedRequests[0]?.cwd, '/workspace/sub');
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 2: Stopped, npm install -> blocked: DOCKER_SANDBOX_UNAVAILABLE', async () => {
  const env = setupTestEnvironment();
  try {
    const dockerStatus = new MockDockerStatusService('Stopped');
    const seam = new MockContainerExecutionSeam();
    const dispatcher = new DockerToolDispatcher({
      dockerStatus,
      policy: env.policy,
      seam,
      paths: env.paths
    });

    const result = await dispatcher.dispatch(
      {
        id: 'call_npm_1',
        name: 'npm',
        arguments: { command: 'npm install express' }
      },
      {
        runId: 'run-2',
        stepId: 'step-2',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.reasonCode, 'DOCKER_SANDBOX_UNAVAILABLE');
    assert.strictEqual(seam.executedRequests.length, 0); // No execution attempted!
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 4: write/delete .eval or outside root -> blocked; files unchanged', async () => {
  const env = setupTestEnvironment();
  try {
    const dockerStatus = new MockDockerStatusService('Active');
    const seam = new MockContainerExecutionSeam();
    const dispatcher = new DockerToolDispatcher({
      dockerStatus,
      policy: env.policy,
      seam,
      paths: env.paths
    });

    // 1. Attempt to overwrite golden assertion inside .eval
    const protectedFile = path.join(env.protectedEvalDir, 'golden.json');
    const resultWrite = await dispatcher.dispatch(
      {
        id: 'call_eval_write',
        name: 'write_file',
        arguments: { path: protectedFile, content: '{"tampered": true}' }
      },
      {
        runId: 'run-sec',
        stepId: 'step-sec-1',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(resultWrite.status, 'blocked');
    assert.strictEqual(resultWrite.reasonCode, 'PROTECTED_ROOT_VIOLATION');
    // Content remains completely unchanged
    assert.strictEqual(fs.readFileSync(protectedFile, 'utf8'), '{"protected": true}');

    // 2. Attempt to delete protected .eval file
    const resultDelete = await dispatcher.dispatch(
      {
        id: 'call_eval_del',
        name: 'delete_file',
        arguments: { path: protectedFile }
      },
      {
        runId: 'run-sec',
        stepId: 'step-sec-2',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(resultDelete.status, 'blocked');
    assert.strictEqual(resultDelete.reasonCode, 'PROTECTED_ROOT_VIOLATION');
    assert.strictEqual(fs.existsSync(protectedFile), true);

    // 3. Attempt to write outside target root
    const outsideFile = path.resolve(env.tmpDir, 'outside.txt');
    const resultOutside = await dispatcher.dispatch(
      {
        id: 'call_outside',
        name: 'write_file',
        arguments: { path: outsideFile, content: 'bad' }
      },
      {
        runId: 'run-sec',
        stepId: 'step-sec-3',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(resultOutside.status, 'blocked');
    assert.strictEqual(fs.existsSync(outsideFile), false);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Golden Assertion 5: abort command handling -> outcome marked aborted and cleanly settled', async () => {
  const env = setupTestEnvironment();
  try {
    const dockerStatus = new MockDockerStatusService('Active');
    const seam = new MockContainerExecutionSeam();
    seam.nextOutcome = {
      exitCode: null,
      stdout: '',
      stderr: 'Process terminated via SIGTERM',
      termination: 'aborted'
    };

    const dispatcher = new DockerToolDispatcher({
      dockerStatus,
      policy: env.policy,
      seam,
      paths: env.paths
    });

    const abortCtrl = new AbortController();
    abortCtrl.abort(); // Pre-aborted

    const result = await dispatcher.dispatch(
      {
        id: 'call_abort_1',
        name: 'run_command',
        arguments: { command: 'sleep 100' }
      },
      {
        runId: 'run-abort',
        stepId: 'step-abort',
        signal: abortCtrl.signal
      }
    );

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.reasonCode, 'aborted');
    assert.strictEqual(seam.executedRequests.length, 0); // Pre-aborted: never reached container
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Safe Host Read Fallback: Confined reading inside allowed root succeeds', async () => {
  const env = setupTestEnvironment();
  try {
    const dockerStatus = new MockDockerStatusService('Unavailable'); // Docker down
    const seam = new MockContainerExecutionSeam();
    const dispatcher = new DockerToolDispatcher({
      dockerStatus,
      policy: env.policy,
      seam,
      paths: env.paths
    });

    const testFile = path.join(env.hostRoot, 'notes.txt');
    fs.writeFileSync(testFile, 'Hello safe read');

    const result = await dispatcher.dispatch(
      {
        id: 'call_read_1',
        name: 'read_file',
        arguments: { path: testFile }
      },
      {
        runId: 'run-read',
        stepId: 'step-read',
        signal: new AbortController().signal
      }
    );

    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.output, 'Hello safe read');
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});
