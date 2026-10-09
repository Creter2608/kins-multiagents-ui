/**
 * src/shared/inner-step.ts
 * Core contracts for the Inner Step Loop (AgentDriver / InnerStepDriver)
 * operating inside Phase EXECUTE of Kin's Multi-Agents UI.
 * Adapted from DeepSeek Harness runtime loop patterns.
 */

import type { ModelMessage, ToolCall, ToolResult } from './harnessContracts.js';

export type ModelFinishReason = 'stop' | 'tool-calls' | 'max-tokens';

export interface ModelStepResult {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: ModelFinishReason;
}

export interface ModelStepProvider {
  modelStep(
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ): Promise<ModelStepResult>;
}

export interface ToolDispatchContext {
  readonly runId: string;
  readonly stepId: string;
  readonly signal: AbortSignal;
}

export interface ToolDispatcher {
  dispatch(
    call: ToolCall,
    context: ToolDispatchContext
  ): Promise<ToolResult>;
}

export type TurnEndKind =
  | 'completed'
  | 'max-tokens'
  | 'aborted'
  | 'error'
  | 'step-limit';

export interface InnerTurnRequest {
  readonly runId: string;
  readonly turn: number;
  readonly signal: AbortSignal;
}

export interface InnerTurnResult {
  readonly runId: string;
  readonly turn: number;
  readonly steps: number;
  readonly reason: {
    readonly kind: TurnEndKind;
    readonly message?: string | undefined;
  };
}

export interface InnerStepDriverOptions {
  readonly maxStepsPerTurn?: number | undefined;
}
