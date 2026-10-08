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
   * Stops immediately on the first non-successful step.
   */
  async execute(plan: ToolPlan, outerSignal?: AbortSignal): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];

    // 1. Guard check whole plan before any tool is dispatched
    const planGuard = this.guard.checkPlan(plan);
    if (!planGuard.allowed) {
      await this.journal.append({
        source: 'guard',
        kind: 'plan_rejected',
        data: {
          reasonCode: planGuard.reasonCode,
          message: planGuard.message,
          requestedSteps: plan.steps.length
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
          reasonCode: 'PLAN_ABORTED'
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

      // 2c. Log execution intent before dispatch
      await this.journal.append({
        source: 'tool',
        kind: 'tool_dispatch',
        stepId: step.id,
        data: { tool: step.tool, args: step.args }
      });

      // Update repetition tracking
      this.guard.recordToolDispatch(step.tool, step.args);

      // 2d. Run tool under timeout and abort signal
      const timeoutController = new AbortController();
      let isTimedOut = false;
      const timeoutTimer = setTimeout(() => {
        isTimedOut = true;
        timeoutController.abort();
      }, DEFAULT_TOOL_TIMEOUT_MS);

      const combinedSignal = outerSignal
        ? AbortSignal.any([outerSignal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const outcome = await registeredTool.execute(step.args, combinedSignal);
        clearTimeout(timeoutTimer);

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
      } catch (execErr: unknown) {
        clearTimeout(timeoutTimer);
        const isAbort = combinedSignal.aborted;
        const status = isTimedOut ? 'timed-out' : 'failed';
        const reasonCode = isTimedOut
          ? 'TOOL_TIMEOUT'
          : isAbort
            ? 'TOOL_ABORTED'
            : execErr instanceof Error
              ? execErr.message
              : String(execErr);

        await this.journal.append({
          source: 'tool',
          kind: 'tool_result',
          stepId: step.id,
          data: { status, reasonCode }
        });

        results.push({
          status,
          stepId: step.id,
          tool: step.tool,
          reasonCode
        });
        break;
      }
    }

    return results;
  }
}
