/**
 * src/main/harness/ToolCallRecovery.ts
 * Manages in-flight tool call lifecycle and crash/cancellation recovery.
 * Adapted from DeepSeek Harness ToolCallRecovery pattern.
 * 
 * Invariants:
 * 1. Every committed tool call in assistant/message MUST have a corresponding terminal tool/result.
 * 2. Unresolved tool calls upon interruption/crash are closed with synthetic terminal results.
 * 3. Bidirectional correlation: correlates by both toolCallId and stepId.
 * 4. Durable completion: in-memory state only marks completed once persisted or explicitly confirmed.
 * 5. Idempotent: multiple calls to recover() return each unresolved tool call exactly once.
 * 6. Never re-execute side-effecting tools upon recovery.
 */

import type { SessionEvent, ToolCall } from '../../shared/harnessContracts.js';
import type { JournalEventInput } from './SessionJournal.js';

export interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  readonly stepId?: string | undefined;
  readonly arguments: unknown;
}

export type TerminalRecoveryStatus = 'cancelled' | 'failed' | 'timed-out' | 'unknown';

export class ToolCallRecovery {
  private readonly committedCalls = new Map<string, PendingToolCall>();
  private readonly completedResults = new Set<string>();
  private readonly stepIdToCallIds = new Map<string, Set<string>>();
  private readonly inFlightRecoveries = new Set<string>();

  /**
   * Observes a session event to track opened tool calls and settled tool results.
   */
  observe(event: SessionEvent): void {
    const { kind, data, stepId } = event;
    if (!data) return;

    if (kind === 'assistant/message') {
      const rawToolCalls = data.toolCalls ?? data.tool_calls;
      const toolCalls = Array.isArray(rawToolCalls) ? (rawToolCalls as readonly ToolCall[]) : [];
      const effectiveStepId = stepId || (typeof data.stepId === 'string' ? data.stepId : undefined);

      for (const call of toolCalls) {
        if (call && typeof call.id === 'string' && call.id) {
          this.committedCalls.set(call.id, {
            id: call.id,
            name: call.name || 'unknown-tool',
            stepId: effectiveStepId,
            arguments: call.arguments
          });

          if (effectiveStepId) {
            let callSet = this.stepIdToCallIds.get(effectiveStepId);
            if (!callSet) {
              callSet = new Set<string>();
              this.stepIdToCallIds.set(effectiveStepId, callSet);
            }
            callSet.add(call.id);
          }
        }
      }
    } else if (kind === 'tool/result') {
      const callId =
        (typeof data.toolCallId === 'string' && data.toolCallId) ||
        (typeof data.tool_call_id === 'string' && data.tool_call_id);

      const effectiveStepId =
        (typeof data.stepId === 'string' && data.stepId) ||
        stepId;

      if (callId) {
        this.completedResults.add(callId);
        this.inFlightRecoveries.delete(callId);
      } else if (effectiveStepId) {
        // Correlate with stepId ONLY if toolCallId is omitted (step-level result)
        const associatedCalls = this.stepIdToCallIds.get(effectiveStepId);
        if (associatedCalls) {
          for (const id of associatedCalls) {
            this.completedResults.add(id);
            this.inFlightRecoveries.delete(id);
          }
        }
      }
    }
  }

  /**
   * Returns list of tool calls that were committed by the assistant but have no matching result.
   */
  unresolved(): readonly PendingToolCall[] {
    const unresolvedCalls: PendingToolCall[] = [];
    for (const [id, call] of this.committedCalls.entries()) {
      if (!this.completedResults.has(id) && !this.inFlightRecoveries.has(id)) {
        unresolvedCalls.push(call);
      }
    }
    return Object.freeze(unresolvedCalls);
  }

  /**
   * Generates synthetic terminal tool/result events to close all dangling tool calls cleanly.
   * Tracks in-flight recoveries to avoid duplicate emissions until persistence completes.
   */
  recover(
    status: TerminalRecoveryStatus = 'cancelled',
    reasonCode: string = 'SESSION_INTERRUPTED'
  ): readonly JournalEventInput[] {
    const syntheticEvents: JournalEventInput[] = [];

    for (const [id, call] of this.committedCalls.entries()) {
      if (!this.completedResults.has(id) && !this.inFlightRecoveries.has(id)) {
        this.inFlightRecoveries.add(id);
        syntheticEvents.push({
          source: 'guard',
          kind: 'tool/result',
          stepId: call.stepId || id,
          data: {
            toolCallId: id,
            tool: call.name,
            status,
            reasonCode,
            output: `[RECOVERY]: Tool execution terminated prematurely (${status}: ${reasonCode}).`,
            recoveredAt: new Date().toISOString()
          }
        });
      }
    }

    return Object.freeze(syntheticEvents);
  }

  /**
   * Marks a callId as completed once persistent write succeeds.
   */
  markCompleted(id: string): void {
    this.completedResults.add(id);
    this.inFlightRecoveries.delete(id);
  }

  /**
   * Releases an in-flight reservation if persistence failed, enabling retry.
   */
  releaseInFlight(id: string): void {
    this.inFlightRecoveries.delete(id);
  }

  /**
   * Clears all internal tracking state.
   */
  reset(): void {
    this.committedCalls.clear();
    this.completedResults.clear();
    this.stepIdToCallIds.clear();
    this.inFlightRecoveries.clear();
  }
}
