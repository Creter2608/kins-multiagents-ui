/**
 * src/main/harness/ToolPlanExecutor.ts
 * Programmatic Tool Calling (PTC) bounded executor adapted from DeepSeek Harness.
 * Executes validated sequential tool plans within Sandbox and Guard invariants.
 */

import type { ToolPlan, ToolResult } from '../../shared/harnessContracts.js';
import type { SessionJournal } from './SessionJournal.js';
import type { SandboxPolicy } from './SandboxPolicy.js';
import { ExecutionGuard, DEFAULT_TOOL_TIMEOUT_MS } from './ExecutionGuard.js';

export interface RegisteredTool {
  readonly name: string;
  readonly effect: 'read' | 'write' | 'execute';
  execute(
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<{ output?: string; error?: string }>;
}

export class ToolPlanExecutor {
  private readonly toolRegistry: Map<string, RegisteredTool> = new Map();
  private readonly journal: SessionJournal;
  private readonly policy: SandboxPolicy;
  private readonly guard: ExecutionGuard;
  private executionLock: Promise<void> = Promise.resolve();

  constructor(
    tools: readonly RegisteredTool[],
    journal: SessionJournal,
    policy: SandboxPolicy,
    guard?: ExecutionGuard
  ) {
    for (const tool of tools) {
      if (this.toolRegistry.has(tool.name)) {
        throw new Error(`Duplicate tool registration: '${tool.name}'`);
      }
      this.toolRegistry.set(tool.name, tool);
    }
    this.journal = journal;
    this.policy = policy;
    this.guard = guard ?? new ExecutionGuard();
  }

  /**
   * Executes a bounded tool plan sequentially.
   * Serializes plan executions to guarantee deterministic repetition guard tracking (F4).
   */
  async execute(plan: ToolPlan, outerSignal?: AbortSignal): Promise<readonly ToolResult[]> {
    return new Promise<readonly ToolResult[]>((resolve, reject) => {
      this.executionLock = this.executionLock.then(async () => {
        try {
          const results = await this.executeInternal(plan, outerSignal);
          resolve(results);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private async executeInternal(plan: ToolPlan, outerSignal?: AbortSignal): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];

    // 1. Guard check whole plan before any tool is dispatched
    const planGuard = this.guard.checkPlan(plan);
    if (!planGuard.allowed) {
      // F5: Safely access requestedSteps even if plan.steps is missing
      const requestedSteps = Array.isArray(plan?.steps) ? plan.steps.length : 0;
      await this.journal.append({
        source: 'guard',
        kind: 'plan_rejected',
        data: {
          reasonCode: planGuard.reasonCode,
          message: planGuard.message,
          requestedSteps
        }
      });
      // Plan rejected: zero tool calls executed
      return results;
    }

    // 1b. Pre-validate that all tools in the plan are registered before any execution
    for (const step of plan.steps) {
      if (!this.toolRegistry.has(step.tool)) {
        await this.journal.append({
          source: 'guard',
          kind: 'plan_rejected',
          ...(step.id ? { stepId: step.id } : {}),
          data: {
            reasonCode: 'TOOL_NOT_FOUND',
            tool: step.tool,
            message: `Unregistered tool '${step.tool}' in plan step '${step.id}'`
          }
        });
        throw new Error(`PLAN_VALIDATION_FAILED: Unregistered tool '${step.tool}'`);
      }
    }

    // 2. Execute each step sequentially
    for (const step of plan.steps) {
      if (outerSignal?.aborted) {
        results.push({
          status: 'failed',
          stepId: step.id,
          tool: step.tool,
          reasonCode: 'TOOL_ABORTED'
        });
        break;
      }

      // 2a. Guard check for individual tool call (repeat-tool detection)
      const toolGuard = this.guard.checkToolCall(step.tool, step.args);
      if (!toolGuard.allowed) {
        await this.journal.append({
          source: 'guard',
          kind: 'tool_blocked',
          stepId: step.id,
          data: {
            tool: step.tool,
            reasonCode: toolGuard.reasonCode,
            message: toolGuard.message
          }
        });

        results.push({
          status: 'blocked',
          stepId: step.id,
          tool: step.tool,
          ...(toolGuard.reasonCode ? { reasonCode: toolGuard.reasonCode } : {})
        });
        // Stop plan on blocked step
        break;
      }

      // 2b. Check tool registration
      const registeredTool = this.toolRegistry.get(step.tool);
      if (!registeredTool) {
        await this.journal.append({
          source: 'tool',
          kind: 'tool_not_found',
          stepId: step.id,
          data: { tool: step.tool }
        });

        results.push({
          status: 'failed',
          stepId: step.id,
          tool: step.tool,
          reasonCode: 'TOOL_NOT_FOUND'
        });
        break;
      }

      // F1: Check sandbox policy before dispatch
      if (registeredTool.effect === 'write' && this.policy.config.mode === 'read-only') {
        await this.journal.append({
          source: 'guard',
          kind: 'tool_blocked',
          stepId: step.id,
          data: {
            tool: step.tool,
            reasonCode: 'READ_ONLY_MODE',
            message: 'Write tool blocked in read-only sandbox mode'
          }
        });
        results.push({
          status: 'blocked',
          stepId: step.id,
          tool: step.tool,
          reasonCode: 'READ_ONLY_MODE'
        });
        break;
      }

      // F1: Inspect any filesystem target arguments against sandbox policy
      const targetPath = step.args.path ?? step.args.targetPath ?? step.args.filePath ?? step.args.target;
      if (typeof targetPath === 'string' && targetPath.trim()) {
        const op = registeredTool.effect === 'write' ? 'write' : 'read';
        const pathDecision = this.policy.authorizePath(targetPath, op);
        if (!pathDecision.allowed) {
          const reasonCode = pathDecision.reasonCode ?? 'SANDBOX_POLICY_VIOLATION';
          await this.journal.append({
            source: 'guard',
            kind: 'tool_blocked',
            stepId: step.id,
            data: {
              tool: step.tool,
              reasonCode,
              message: `Path '${targetPath}' disallowed: ${reasonCode}`
            }
          });
          results.push({
            status: 'blocked',
            stepId: step.id,
            tool: step.tool,
            reasonCode
          });
          break;
        }
      }

      // 2c. Log execution intent before dispatch
      await this.journal.append({
        source: 'tool',
        kind: 'tool_dispatch',
        stepId: step.id,
        data: { tool: step.tool, args: step.args }
      });

      // Update repetition tracking
      this.guard.recordToolDispatch(step.tool, step.args);

      // 2d. Run tool under timeout and abort signal (F3: race against timeout independently of tool cooperation)
      const timeoutController = new AbortController();
      let timeoutTimer: NodeJS.Timeout | undefined;
      let isTimedOut = false;
      let timeoutAppendPromise: Promise<unknown> | undefined;

      const combinedSignal = outerSignal
        ? AbortSignal.any([outerSignal, timeoutController.signal])
        : timeoutController.signal;

      const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
        timeoutTimer = setTimeout(() => {
          isTimedOut = true;
          timeoutController.abort();
          timeoutAppendPromise = this.journal.append({
            source: 'tool',
            kind: 'tool_result',
            stepId: step.id,
            data: { status: 'timed-out', reasonCode: 'TOOL_TIMEOUT' }
          });
          resolve({ isTimeout: true });
        }, DEFAULT_TOOL_TIMEOUT_MS);
      });

      const abortPromise = new Promise<{ isAbort: true }>((resolve) => {
        if (outerSignal?.aborted) {
          resolve({ isAbort: true });
        } else if (outerSignal) {
          outerSignal.addEventListener('abort', () => resolve({ isAbort: true }), { once: true });
        }
      });

      const toolPromise = (async () => {
        try {
          const outcome = await registeredTool.execute(step.args, combinedSignal);
          return { isTool: true as const, outcome };
        } catch (execErr: unknown) {
          return { isTool: true as const, error: execErr };
        }
      })();

      try {
        const raceResult = await Promise.race([toolPromise, timeoutPromise, abortPromise]);
        if (timeoutTimer) clearTimeout(timeoutTimer);

        if ('isTimeout' in raceResult) {
          if (!timeoutAppendPromise) {
            timeoutAppendPromise = this.journal.append({
              source: 'tool',
              kind: 'tool_result',
              stepId: step.id,
              data: { status: 'timed-out', reasonCode: 'TOOL_TIMEOUT' }
            });
          }
          results.push({
            status: 'timed-out',
            stepId: step.id,
            tool: step.tool,
            reasonCode: 'TOOL_TIMEOUT'
          });
          break;
        }

        if ('isAbort' in raceResult) {
          await this.journal.append({
            source: 'tool',
            kind: 'tool_result',
            stepId: step.id,
            data: { status: 'failed', reasonCode: 'TOOL_ABORTED' }
          });
          results.push({
            status: 'failed',
            stepId: step.id,
            tool: step.tool,
            reasonCode: 'TOOL_ABORTED'
          });
          break;
        }

        if ('isTool' in raceResult) {
          if (raceResult.error) {
            const reasonCode = raceResult.error instanceof Error ? raceResult.error.message : String(raceResult.error);
            await this.journal.append({
              source: 'tool',
              kind: 'tool_result',
              stepId: step.id,
              data: { status: 'failed', reasonCode }
            });
            results.push({
              status: 'failed',
              stepId: step.id,
              tool: step.tool,
              reasonCode
            });
            break;
          }

          const outcome = raceResult.outcome ?? {};
          if (outcome.error) {
            await this.journal.append({
              source: 'tool',
              kind: 'tool_result',
              stepId: step.id,
              data: { status: 'failed', error: outcome.error }
            });
            results.push({
              status: 'failed',
              stepId: step.id,
              tool: step.tool,
              reasonCode: outcome.error
            });
            break;
          }

          await this.journal.append({
            source: 'tool',
            kind: 'tool_result',
            stepId: step.id,
            data: { status: 'succeeded', output: outcome.output }
          });
          results.push({
            status: 'succeeded',
            stepId: step.id,
            tool: step.tool,
            ...(outcome.output !== undefined ? { output: outcome.output } : {})
          });
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    }

    return results;
  }
}
