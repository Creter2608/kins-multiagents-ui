/**
 * src/main/harness/InnerStepDriver.ts
 * Sequential, bounded inner turn and step execution driver.
 * Operates inside Phase EXECUTE of Kin's Multi-Agents UI Outer FSM.
 * Adapted from DeepSeek Harness agent-loop architecture.
 *
 * Invariants:
 * 1. Event-sourced projection: Always feeds deriveMessages(events) to model.
 * 2. Deterministic lifecycle: Exactly one step/start per step/end, one turn/start per turn/end.
 * 3. Execution hygiene: Bounded steps per turn, consecutive duplicate tool call detection.
 * 4. Resilient recovery: Interrupted or aborted tool calls are cleanly settled via ToolCallRecovery.
 * 5. Precedence: Abort & Error override sticky max-tokens. Sticky max-tokens overrides completed/step-limit.
 */

import type { HarnessService } from '../services/HarnessService.js';
import { ExecutionGuard } from './ExecutionGuard.js';
import type {
  ModelStepProvider,
  ToolDispatcher,
  InnerTurnRequest,
  InnerTurnResult,
  InnerStepDriverOptions,
  TurnEndKind
} from '../../shared/inner-step.js';
import type { ToolCall } from '../../shared/harnessContracts.js';

export interface InnerStepDriverDependencies {
  readonly harness: HarnessService;
  readonly model: ModelStepProvider;
  readonly tools: ToolDispatcher;
}

export class InnerStepDriver {
  private readonly harness: HarnessService;
  private readonly model: ModelStepProvider;
  private readonly tools: ToolDispatcher;
  private readonly maxStepsPerTurn: number;

  constructor(
    dependencies: InnerStepDriverDependencies,
    options?: InnerStepDriverOptions
  ) {
    this.harness = dependencies.harness;
    this.model = dependencies.model;
    this.tools = dependencies.tools;

    const maxSteps = options?.maxStepsPerTurn ?? 15;
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new Error(`Invalid maxStepsPerTurn: ${maxSteps}. Must be a positive safe integer.`);
    }
    this.maxStepsPerTurn = maxSteps;
  }

  async runTurn(request: InnerTurnRequest): Promise<InnerTurnResult> {
    const { runId, turn, signal } = request;

    if (!Number.isSafeInteger(turn) || turn < 0) {
      throw new Error(`Invalid turn index: ${turn}. Must be a non-negative safe integer.`);
    }

    if (!runId || typeof runId !== 'string') {
      throw new Error('Invalid runId. Must be a non-empty string.');
    }

    // 1. Admission check: pre-aborted signal returns immediately without writes
    if (signal.aborted) {
      return {
        runId,
        turn,
        steps: 0,
        reason: { kind: 'aborted' }
      };
    }

    // 2. Replay & verify prior recovery before opening new turn
    await this.harness.ensureRecoveryReplayed();

    if (signal.aborted) {
      return {
        runId,
        turn,
        steps: 0,
        reason: { kind: 'aborted' }
      };
    }

    // 3. Fresh execution guard per turn
    const guard = new ExecutionGuard({ maxPlanSteps: this.maxStepsPerTurn });

    // 4. Open turn boundary
    await this.harness.recordEvent({
      source: 'loop',
      kind: 'turn/start',
      data: { turn }
    });

    let completedSteps = 0;
    let turnEndReason: { kind: TurnEndKind; message?: string } | null = null;

    try {
      while (true) {
        if (signal.aborted) {
          turnEndReason = { kind: 'aborted' };
          break;
        }

        if (!guard.canStartStep(completedSteps)) {
          turnEndReason = { kind: guard.resolveEndKind('step-limit') };
          break;
        }

        const step = completedSteps + 1;
        const stepId = `${runId}:turn:${turn}:step:${step}`;

        await this.harness.recordEvent({
          source: 'loop',
          kind: 'step/start',
          stepId,
          data: { turn, step }
        });

        let stepClosed = false;

        try {
          if (signal.aborted) {
            throw new Error('ABORTED');
          }

          // 5. Pure event-sourced message derivation for model prompt
          const messages = await this.harness.getDerivedMessages();

          // 6. Invoke model step
          const modelResponse = await this.model.modelStep(messages, signal);

          if (signal.aborted) {
            throw new Error('ABORTED');
          }

          // 7. Validate model response contract
          const rawToolCalls = modelResponse.toolCalls ?? [];
          if (modelResponse.finishReason === 'stop' && rawToolCalls.length > 0) {
            throw new Error('Protocol error: model combined "stop" finishReason with non-empty toolCalls.');
          }

          const seenCallIds = new Set<string>();
          for (const call of rawToolCalls) {
            if (!call || typeof call.id !== 'string' || !call.id.trim()) {
              throw new Error('Tool call missing valid non-empty string ID.');
            }
            if (seenCallIds.has(call.id)) {
              throw new Error(`Protocol error: duplicate tool call ID within step: ${call.id}`);
            }
            seenCallIds.add(call.id);
          }

          // 8. Observe finish reason
          guard.observeFinishReason(modelResponse.finishReason);

          // 9. Persist assistant message (before any tool call dispatch)
          await this.harness.recordEvent({
            source: 'loop',
            kind: 'assistant/message',
            stepId,
            data: {
              content: modelResponse.content,
              toolCalls: rawToolCalls
            }
          });

          // 10. Handle step completion or tool dispatch
          if (rawToolCalls.length === 0) {
            await this.harness.recordEvent({
              source: 'loop',
              kind: 'step/end',
              stepId,
              data: { turn, step }
            });
            stepClosed = true;
            completedSteps++;
            turnEndReason = { kind: guard.resolveEndKind('completed') };
            break;
          }

          // 11. Sequential tool dispatch with anti-loop guard
          let batchBlocked = false;

          for (let i = 0; i < rawToolCalls.length; i++) {
            const call = rawToolCalls[i] as ToolCall;

            if (batchBlocked) {
              await this.harness.recordEvent({
                source: 'tool',
                kind: 'tool/result',
                stepId,
                data: {
                  toolCallId: call.id,
                  tool: call.name,
                  status: 'blocked',
                  reasonCode: 'blocked-by-prior-failure',
                  output: 'Blocked without dispatch due to preceding duplicate/failure in batch'
                }
              });
              continue;
            }

            const allowed = guard.acceptToolCall(call);
            if (!allowed) {
              batchBlocked = true;
              await this.harness.recordEvent({
                source: 'tool',
                kind: 'tool/result',
                stepId,
                data: {
                  toolCallId: call.id,
                  tool: call.name,
                  status: 'blocked',
                  reasonCode: 'duplicate-tool-call',
                  output: `Blocked duplicate consecutive tool call (${call.name})`
                }
              });
              continue;
            }

            if (signal.aborted) {
              throw new Error('ABORTED');
            }

            const toolResult = await this.tools.dispatch(call, { runId, stepId, signal });

            await this.harness.recordEvent({
              source: 'tool',
              kind: 'tool/result',
              stepId,
              data: {
                turn,
                step,
                toolCallId: call.id,
                tool: call.name,
                status: toolResult.status,
                reasonCode: toolResult.reasonCode,
                output: toolResult.output
              }
            });
          }

          await this.harness.recordEvent({
            source: 'loop',
            kind: 'step/end',
            stepId,
            data: { turn, step }
          });
          stepClosed = true;
          completedSteps++;

          if (batchBlocked) {
            turnEndReason = { kind: 'error', message: 'Turn stopped due to blocked duplicate tool call.' };
            break;
          }
        } catch (stepErr: unknown) {
          if (!stepClosed) {
            const isAbort = signal.aborted || (stepErr instanceof Error && stepErr.message === 'ABORTED');
            await this.harness.recoverPendingTools(
              isAbort ? 'cancelled' : 'failed',
              isAbort ? 'USER_ABORT' : 'STEP_EXCEPTION'
            );

            await this.harness.recordEvent({
              source: 'loop',
              kind: 'step/end',
              stepId,
              data: { turn, step }
            });
            completedSteps++;
          }

          if (signal.aborted || (stepErr instanceof Error && stepErr.message === 'ABORTED')) {
            turnEndReason = { kind: 'aborted' };
          } else {
            turnEndReason = {
              kind: 'error',
              message: stepErr instanceof Error ? stepErr.message : String(stepErr)
            };
          }
          break;
        }
      }
    } catch (outerErr: unknown) {
      if (signal.aborted) {
        turnEndReason = { kind: 'aborted' };
      } else {
        turnEndReason = {
          kind: 'error',
          message: outerErr instanceof Error ? outerErr.message : String(outerErr)
        };
      }
    } finally {
      // 12. Unconditional single turn/end closure
      const finalKind: TurnEndKind = turnEndReason
        ? turnEndReason.kind
        : guard.resolveEndKind('completed');

      await this.harness.recordEvent({
        source: 'loop',
        kind: 'turn/end',
        data: {
          turn,
          reason: {
            kind: finalKind,
            ...(turnEndReason?.message ? { message: turnEndReason.message } : {})
          }
        }
      });
    }

    const resolvedKind: TurnEndKind = turnEndReason
      ? turnEndReason.kind
      : guard.resolveEndKind('completed');

    return {
      runId,
      turn,
      steps: completedSteps,
      reason: {
        kind: resolvedKind,
        ...(turnEndReason?.message ? { message: turnEndReason.message } : {})
      }
    };
  }
}
