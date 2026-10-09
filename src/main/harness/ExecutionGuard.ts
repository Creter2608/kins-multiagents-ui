/**
 * src/main/harness/ExecutionGuard.ts
 * Loop-hygiene guards adapted from DeepSeek Harness:
 * - repeat-tool-reminder / anti-loop guard (detects & blocks 3 consecutive identical tool requests)
 * - plan size validation (rejects plans exceeding max steps)
 * - timeout policy
 */

import type { ToolPlan, GuardDecision } from '../../shared/harnessContracts.js';

export const MAX_PLAN_STEPS = 16;
export const MAX_CONSECUTIVE_IDENTICAL_CALLS = 2; // 3rd is blocked
export const DEFAULT_TOOL_TIMEOUT_MS = 60000;
export const MAX_TOOL_TIMEOUT_MS = 180000;

/**
 * Deterministically serializes JSON arguments with sorted keys for fingerprinting.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k])).join(',') + '}';
}

export class ExecutionGuard {
  private lastCallFingerprint: string | null = null;
  private consecutiveIdenticalCount: number = 0;
  private readonly maxPlanSteps: number;
  private readonly maxIdenticalCalls: number;

  constructor(options?: { maxPlanSteps?: number; maxIdenticalCalls?: number }) {
    this.maxPlanSteps = options?.maxPlanSteps ?? MAX_PLAN_STEPS;
    this.maxIdenticalCalls = options?.maxIdenticalCalls ?? MAX_CONSECUTIVE_IDENTICAL_CALLS;
  }

  /**
   * Evaluates a complete ToolPlan before any step is dispatched.
   */
  checkPlan(plan: ToolPlan): GuardDecision {
    if (!plan || typeof plan !== 'object' || plan.version !== 1 || !Array.isArray(plan.steps)) {
      return {
        allowed: false,
        reasonCode: 'INVALID_PLAN_SCHEMA',
        message: 'Plan must be a valid version 1 object with steps array.'
      };
    }

    if (plan.steps.length > this.maxPlanSteps) {
      return {
        allowed: false,
        reasonCode: 'PLAN_STEP_LIMIT_EXCEEDED',
        message: `Plan exceeds maximum allowable steps of ${this.maxPlanSteps}. Received ${plan.steps.length} steps.`
      };
    }

    // F5: Validate each step structure before admitting plan
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        return {
          allowed: false,
          reasonCode: 'INVALID_STEP_SCHEMA',
          message: `Plan step at index ${i} is not a valid object.`
        };
      }
      if (typeof step.id !== 'string' || !step.id.trim()) {
        return {
          allowed: false,
          reasonCode: 'INVALID_STEP_SCHEMA',
          message: `Plan step at index ${i} has invalid or missing step id.`
        };
      }
      if (typeof step.tool !== 'string' || !step.tool.trim()) {
        return {
          allowed: false,
          reasonCode: 'INVALID_STEP_SCHEMA',
          message: `Plan step at index ${i} has invalid or missing tool name.`
        };
      }
      if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
        return {
          allowed: false,
          reasonCode: 'INVALID_STEP_SCHEMA',
          message: `Plan step at index ${i} has invalid args (expected non-null, non-array object).`
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Pre-dispatch check for an individual tool call.
   * If this is the 3rd consecutive call with identical tool and args, blocks execution.
   */
  checkToolCall(tool: string, args: Readonly<Record<string, unknown>>): GuardDecision {
    if (!tool || typeof tool !== 'string') {
      return {
        allowed: false,
        reasonCode: 'INVALID_TOOL_NAME',
        message: 'Tool name must be a non-empty string.'
      };
    }

    const fingerprint = `${tool}:${canonicalizeJson(args)}`;

    if (this.lastCallFingerprint === fingerprint) {
      if (this.consecutiveIdenticalCount >= this.maxIdenticalCalls) {
        return {
          allowed: false,
          reasonCode: 'REPEAT_TOOL_DETECTED',
          message: `Blocked identical tool call (${tool}) after ${this.consecutiveIdenticalCount} consecutive executions without strategy change.`
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Records that a tool call was dispatched, updating the repetition tracker.
   */
  recordToolDispatch(tool: string, args: Readonly<Record<string, unknown>>): void {
    const fingerprint = `${tool}:${canonicalizeJson(args)}`;
    if (this.lastCallFingerprint === fingerprint) {
      this.consecutiveIdenticalCount++;
    } else {
      this.lastCallFingerprint = fingerprint;
      this.consecutiveIdenticalCount = 1;
    }
  }

  /**
   * Resets guard state (e.g., when a run or cycle resets).
   */
  reset(): void {
    this.lastCallFingerprint = null;
    this.consecutiveIdenticalCount = 0;
    this.lastInnerCallFingerprint = null;
    this.stickyMaxTokens = false;
  }

  // --- INNER STEP LOOP METHODS (STAGE 2) ---

  private lastInnerCallFingerprint: string | null = null;
  private stickyMaxTokens: boolean = false;

  /**
   * Checks whether another step can be initiated given the completed steps in the turn.
   */
  canStartStep(completedSteps: number): boolean {
    return completedSteps < this.maxPlanSteps;
  }

  /**
   * Observes the model finish reason for sticky max-tokens tracking.
   */
  observeFinishReason(reason: 'stop' | 'tool-calls' | 'max-tokens'): void {
    if (reason === 'max-tokens') {
      this.stickyMaxTokens = true;
    }
  }

  /**
   * Evaluates an individual tool call for consecutive duplicate execution.
   * Compares against the immediately preceding attempted call in dispatch order.
   * Blocks on the 2nd consecutive identical call. Intervening different calls reset the tracker.
   */
  acceptToolCall(call: { name: string; arguments?: unknown }): boolean {
    const rawArgs = call.arguments;
    let normalizedArgs: unknown;
    if (typeof rawArgs === 'string') {
      try {
        normalizedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        normalizedArgs = rawArgs;
      }
    } else {
      normalizedArgs = rawArgs ?? {};
    }

    const fingerprint = `${call.name}:${canonicalizeJson(normalizedArgs)}`;
    if (this.lastInnerCallFingerprint === fingerprint) {
      return false;
    }

    this.lastInnerCallFingerprint = fingerprint;
    return true;
  }

  /**
   * Resolves the final turn ending kind, enforcing sticky max-tokens precedence over completed/step-limit.
   * Aborted and error outcomes take precedence over sticky max-tokens.
   */
  resolveEndKind(candidate: 'completed' | 'max-tokens' | 'aborted' | 'error' | 'step-limit'): 'completed' | 'max-tokens' | 'aborted' | 'error' | 'step-limit' {
    if (candidate === 'aborted' || candidate === 'error') {
      return candidate;
    }
    if (this.stickyMaxTokens) {
      return 'max-tokens';
    }
    return candidate;
  }

  isStickyMaxTokens(): boolean {
    return this.stickyMaxTokens;
  }
}
