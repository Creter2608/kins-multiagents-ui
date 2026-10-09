/**
 * src/main/sandbox/docker-tool-dispatcher.ts
 * Docker-first ToolDispatcher routing shell commands to kins_autonomous_sandbox
 * and confining file operations under SandboxPolicy invariants.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDispatcher, ToolDispatchContext } from '../../shared/inner-step.js';
import type { ToolCall, ToolResult } from '../../shared/harnessContracts.js';
import type { DockerStatusService } from '../services/DockerStatusService.js';
import type { SandboxPolicy } from '../harness/SandboxPolicy.js';
import type { ContainerExecutionSeam } from './container-execution-seam.js';
import { toContainerPath, type WorkspacePaths } from './workspace-paths.js';

export interface DockerToolDispatcherDependencies {
  readonly dockerStatus: DockerStatusService;
  readonly policy: SandboxPolicy;
  readonly seam: ContainerExecutionSeam;
  readonly paths: WorkspacePaths;
}

const SHELL_TOOLS = new Set([
  'run_command',
  'exec_command',
  'bash',
  'sh',
  'powershell',
  'pwsh',
  'npm',
  'pnpm'
]);

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'create_file',
  'delete_file',
  'replace_file_content',
  'modify_file'
]);

const FILE_READ_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_dir',
  'read_dir',
  'file_search'
]);

function parseToolArguments(rawArgs: unknown): Record<string, unknown> {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export class DockerToolDispatcher implements ToolDispatcher {
  private readonly dockerStatus: DockerStatusService;
  private readonly policy: SandboxPolicy;
  private readonly seam: ContainerExecutionSeam;
  private readonly paths: WorkspacePaths;

  constructor(dependencies: DockerToolDispatcherDependencies) {
    this.dockerStatus = dependencies.dockerStatus;
    this.policy = dependencies.policy;
    this.seam = dependencies.seam;
    this.paths = dependencies.paths;
  }

  async dispatch(call: ToolCall, context: ToolDispatchContext): Promise<ToolResult> {
    const { stepId, signal } = context;
    const toolName = call.name;
    const args = parseToolArguments(call.arguments);

    // 1. Check signal before dispatch
    if (signal.aborted) {
      return {
        status: 'failed',
        stepId,
        tool: toolName,
        reasonCode: 'aborted',
        output: 'Operation aborted prior to execution.'
      };
    }

    // 2. Shell & Command Tools (Docker-First Mandate)
    if (SHELL_TOOLS.has(toolName)) {
      const dockerStatus = await this.dockerStatus.checkStatus();
      if (dockerStatus !== 'Active') {
        return {
          status: 'blocked',
          stepId,
          tool: toolName,
          reasonCode: 'DOCKER_SANDBOX_UNAVAILABLE',
          output: `Execution blocked: Docker sandbox container is not active (current status: ${dockerStatus}). Untrusted shell execution requires active Docker isolation.`
        };
      }

      const rawCommand = args['command'] ?? args['cmd'] ?? args['CommandLine'];
      if (typeof rawCommand !== 'string' || !rawCommand.trim()) {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'INVALID_ARGUMENTS',
          output: 'Missing or empty command string in tool arguments.'
        };
      }

      let containerCwd: string = this.paths.containerRoot;
      const rawCwd = args['cwd'] ?? args['Cwd'];
      if (typeof rawCwd === 'string' && rawCwd.trim()) {
        try {
          containerCwd = toContainerPath(rawCwd, this.paths);
        } catch (pathErr) {
          return {
            status: 'blocked',
            stepId,
            tool: toolName,
            reasonCode: 'SANDBOX_POLICY_VIOLATION',
            output: pathErr instanceof Error ? pathErr.message : String(pathErr)
          };
        }
      }

      const outcome = await this.seam.execute({
        command: rawCommand,
        cwd: containerCwd,
        runId: context.runId,
        stepId,
        signal
      });

      if (outcome.termination === 'aborted') {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'aborted',
          output: outcome.stderr || outcome.stdout || 'Command aborted.'
        };
      }

      if (outcome.termination === 'timed-out') {
        return {
          status: 'timed-out',
          stepId,
          tool: toolName,
          reasonCode: 'COMMAND_TIMEOUT',
          output: outcome.stderr || outcome.stdout || 'Command execution timed out.'
        };
      }

      if (outcome.exitCode === 0) {
        return {
          status: 'succeeded',
          stepId,
          tool: toolName,
          output: outcome.stdout
        };
      } else {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: `EXIT_CODE_${outcome.exitCode ?? 1}`,
          output: outcome.stderr || outcome.stdout
        };
      }
    }

    // 3. File Mutation Tools (Strict SandboxPolicy Confinement)
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const rawPath = args['path'] ?? args['file'] ?? args['TargetFile'];
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'INVALID_ARGUMENTS',
          output: 'Missing required target file path.'
        };
      }

      const decision = this.policy.authorizePath(rawPath, 'write');
      if (!decision.allowed) {
        return {
          status: 'blocked',
          stepId,
          tool: toolName,
          reasonCode: decision.reasonCode ?? 'SANDBOX_POLICY_VIOLATION',
          output: `Access denied by SandboxPolicy: target path is protected or outside writable roots (${decision.reasonCode}).`
        };
      }

      try {
        const resolvedPath = path.resolve(rawPath);
        if (toolName === 'delete_file') {
          if (fs.existsSync(resolvedPath)) {
            fs.rmSync(resolvedPath, { recursive: true, force: true });
          }
          return {
            status: 'succeeded',
            stepId,
            tool: toolName,
            output: `Deleted ${resolvedPath}`
          };
        } else {
          const content = String(args['content'] ?? args['CodeContent'] ?? '');
          fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
          fs.writeFileSync(resolvedPath, content, 'utf8');
          return {
            status: 'succeeded',
            stepId,
            tool: toolName,
            output: `Successfully wrote ${content.length} bytes to ${resolvedPath}`
          };
        }
      } catch (ioErr) {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'IO_ERROR',
          output: ioErr instanceof Error ? ioErr.message : String(ioErr)
        };
      }
    }

    // 4. File Read Tools (Confined Host Read Fallback)
    if (FILE_READ_TOOLS.has(toolName)) {
      const rawPath = args['path'] ?? args['file'] ?? args['AbsolutePath'];
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'INVALID_ARGUMENTS',
          output: 'Missing required path for read operation.'
        };
      }

      const decision = this.policy.authorizePath(rawPath, 'read');
      if (!decision.allowed) {
        return {
          status: 'blocked',
          stepId,
          tool: toolName,
          reasonCode: decision.reasonCode ?? 'SANDBOX_POLICY_VIOLATION',
          output: `Access denied by SandboxPolicy: path is outside readable roots (${decision.reasonCode}).`
        };
      }

      try {
        const resolvedPath = path.resolve(rawPath);
        if (!fs.existsSync(resolvedPath)) {
          return {
            status: 'failed',
            stepId,
            tool: toolName,
            reasonCode: 'NOT_FOUND',
            output: `File not found: ${resolvedPath}`
          };
        }

        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(resolvedPath);
          return {
            status: 'succeeded',
            stepId,
            tool: toolName,
            output: JSON.stringify(files)
          };
        } else {
          const content = fs.readFileSync(resolvedPath, 'utf8');
          return {
            status: 'succeeded',
            stepId,
            tool: toolName,
            output: content
          };
        }
      } catch (readErr) {
        return {
          status: 'failed',
          stepId,
          tool: toolName,
          reasonCode: 'IO_ERROR',
          output: readErr instanceof Error ? readErr.message : String(readErr)
        };
      }
    }

    // 5. Unknown / Unsupported Tool
    return {
      status: 'blocked',
      stepId,
      tool: toolName,
      reasonCode: 'UNSUPPORTED_TOOL',
      output: `Capability '${toolName}' is not registered or supported by DockerToolDispatcher.`
    };
  }
}
