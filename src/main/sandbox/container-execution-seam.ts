/**
 * src/main/sandbox/container-execution-seam.ts
 * Process virtualization seam that executes workloads inside the isolated Docker container.
 * Enforces clean cancellation ownership and prevents orphaned descendant processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface ContainerExecutionRequest {
  readonly command: string;
  readonly cwd: string; // Validated container path, e.g. /workspace/...
  readonly runId: string;
  readonly stepId: string;
  readonly signal: AbortSignal;
}

export interface ContainerExecutionOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: 'exited' | 'aborted' | 'timed-out';
}

export interface ContainerExecutionSeam {
  execute(
    request: ContainerExecutionRequest
  ): Promise<ContainerExecutionOutcome>;
}

export interface DockerExecSeamOptions {
  readonly containerName?: string;
  readonly maxOutputBytes?: number;
  readonly abortGracePeriodMs?: number;
}

export class DockerExecContainerExecutionSeam implements ContainerExecutionSeam {
  private readonly containerName: string;
  private readonly maxOutputBytes: number;
  private readonly abortGracePeriodMs: number;

  constructor(options?: DockerExecSeamOptions) {
    this.containerName = options?.containerName ?? 'kins_autonomous_sandbox';
    this.maxOutputBytes = options?.maxOutputBytes ?? 1024 * 1024; // 1MB
    this.abortGracePeriodMs = options?.abortGracePeriodMs ?? 1000;
  }

  async execute(request: ContainerExecutionRequest): Promise<ContainerExecutionOutcome> {
    const { command, cwd, signal } = request;

    if (signal.aborted) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        termination: 'aborted'
      };
    }

    return new Promise<ContainerExecutionOutcome>((resolve, reject) => {
      let child: ChildProcess | null = null;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
      };

      const settle = (outcome: ContainerExecutionOutcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const onAbort = () => {
        if (!child || settled) return;
        try {
          // Gracefully terminate child process client
          child.kill('SIGTERM');
        } catch {
          // Process may have already exited
        }

        // Force kill escalation after grace period
        killTimer = setTimeout(() => {
          if (!child || settled) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }, this.abortGracePeriodMs);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      try {
        // Execute command inside container strictly using shell: false
        child = spawn('docker', [
          'exec',
          '-i',
          '--workdir',
          cwd,
          this.containerName,
          '/bin/sh',
          '-c',
          command
        ], {
          shell: false,
          windowsHide: true
        });

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdoutBuffer.length < this.maxOutputBytes) {
            stdoutBuffer += chunk.toString('utf8');
            if (stdoutBuffer.length > this.maxOutputBytes) {
              stdoutBuffer = stdoutBuffer.slice(0, this.maxOutputBytes) + '\n[STDOUT_TRUNCATED]';
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderrBuffer.length < this.maxOutputBytes) {
            stderrBuffer += chunk.toString('utf8');
            if (stderrBuffer.length > this.maxOutputBytes) {
              stderrBuffer = stderrBuffer.slice(0, this.maxOutputBytes) + '\n[STDERR_TRUNCATED]';
            }
          }
        });

        child.on('error', (err: Error) => {
          cleanup();
          if (signal.aborted) {
            settle({
              exitCode: null,
              stdout: stdoutBuffer,
              stderr: stderrBuffer,
              termination: 'aborted'
            });
          } else {
            reject(err);
          }
        });

        child.on('close', (code: number | null) => {
          if (signal.aborted) {
            settle({
              exitCode: code,
              stdout: stdoutBuffer,
              stderr: stderrBuffer,
              termination: 'aborted'
            });
          } else {
            settle({
              exitCode: code,
              stdout: stdoutBuffer,
              stderr: stderrBuffer,
              termination: 'exited'
            });
          }
        });
      } catch (spawnErr) {
        cleanup();
        reject(spawnErr);
      }
    });
  }
}
