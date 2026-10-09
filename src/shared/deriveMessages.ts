/**
 * src/shared/deriveMessages.ts
 * Pure projection from append-only SessionEvents to model-visible ModelMessages.
 * Adapted from DeepSeek Harness event-sourcing principles.
 * 
 * Invariants:
 * 1. Model-visible means logged: Replaying the same event log produces deterministic messages.
 * 2. Uncommitted / failed streams (assistant/attempt) are excluded from model context by default.
 * 3. Lifecycle & non-message telemetry events (loop, hook, guard) are skipped without error.
 * 4. Tool results map directly to { role: 'tool', toolCallId, content } in sequence.
 * 5. Resilient serialization: circular structures or non-string outputs never crash projection.
 */

import type { SessionEvent, ModelMessage, ToolCall, DeriveMessagesOptions } from './harnessContracts.js';

/**
 * Safely stringifies arbitrary outputs without throwing on circular structures, BigInts,
 * or throwing toString()/toJSON() methods.
 * Correctly distinguishes genuine circular references (ancestors) from shared DAG references.
 */
export function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;

  const ancestors = new Set<unknown>();

  function sanitize(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === 'bigint') return `${val.toString()}n`;
    if (typeof val !== 'object') return val;

    if (ancestors.has(val)) {
      return '[Circular Reference]';
    }

    ancestors.add(val);
    try {
      if (Array.isArray(val)) {
        return val.map((item) => sanitize(item));
      }
      const record = val as Record<string, unknown>;
      const clone: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        try {
          clone[k] = sanitize(v);
        } catch {
          clone[k] = '[Unserializable Field]';
        }
      }
      return clone;
    } finally {
      ancestors.delete(val);
    }
  }

  try {
    const sanitized = sanitize(value);
    return JSON.stringify(sanitized);
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unstringifiable Object]';
    }
  }
}

/**
 * Normalizes raw tool call inputs from both camelCase (toolCalls) and snake_case (tool_calls).
 */
function normalizeToolCalls(rawCalls: unknown): readonly ToolCall[] | undefined {
  if (!Array.isArray(rawCalls)) return undefined;

  const validCalls: ToolCall[] = [];
  for (const item of rawCalls) {
    if (item && typeof item === 'object') {
      const call = item as Record<string, unknown>;
      const id = typeof call.id === 'string' && call.id ? call.id : undefined;
      const name = typeof call.name === 'string' && call.name ? call.name : 'unknown_tool';
      const rawArgs = call.arguments ?? call.args ?? {};
      const args: Readonly<Record<string, unknown>> | string =
        typeof rawArgs === 'string'
          ? rawArgs
          : (typeof rawArgs === 'object' && rawArgs !== null
              ? Object.freeze({ ...(rawArgs as Record<string, unknown>) })
              : {});

      if (id) {
        validCalls.push(
          Object.freeze({
            id,
            name,
            arguments: args
          })
        );
      }
    }
  }

  return validCalls.length > 0 ? Object.freeze(validCalls) : undefined;
}

export function deriveMessages(
  events: readonly SessionEvent[],
  options: DeriveMessagesOptions = {}
): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];
  const includeAttempts = options.includeAttempts ?? false;
  const compactionEnabled = options.compaction?.enabled ?? false;

  const thresholdChars = options.compaction?.thresholdChars ?? 20_000;
  const headChars = options.compaction?.headChars ?? 2_000;
  const tailChars = options.compaction?.tailChars ?? 2_000;

  if (compactionEnabled) {
    if (
      !Number.isInteger(thresholdChars) || thresholdChars < 0 ||
      !Number.isInteger(headChars) || headChars < 0 ||
      !Number.isInteger(tailChars) || tailChars < 0
    ) {
      throw new Error('Invalid compaction settings: thresholdChars, headChars, and tailChars must be non-negative integers.');
    }
  }

  // Pass 1: Unambiguous turn lifecycle analysis
  const completedTurns = new Set<string | number>();
  const openTurns = new Map<string | number, number>();
  const ambiguousTurns = new Set<string | number>();

  for (const event of events) {
    if (!event.data) continue;
    if (event.kind === 'turn/start') {
      const turnId = event.data.turn;
      if (turnId !== undefined && turnId !== null && (typeof turnId === 'string' || typeof turnId === 'number')) {
        if (openTurns.has(turnId)) {
          ambiguousTurns.add(turnId);
        } else {
          openTurns.set(turnId, event.sequence);
        }
      }
    } else if (event.kind === 'turn/end') {
      const turnId = event.data.turn;
      if (turnId !== undefined && turnId !== null && (typeof turnId === 'string' || typeof turnId === 'number')) {
        if (openTurns.has(turnId)) {
          openTurns.delete(turnId);
          if (!ambiguousTurns.has(turnId)) {
            completedTurns.add(turnId);
          }
        } else {
          ambiguousTurns.add(turnId);
        }
      }
    }
  }

  // Pass 2: Projection with compaction
  let currentTurnId: string | number | null = null;

  for (const event of events) {
    const { kind, data } = event;
    if (!data) continue;

    if (kind === 'turn/start') {
      const turnId = data.turn;
      if (turnId !== undefined && turnId !== null && (typeof turnId === 'string' || typeof turnId === 'number')) {
        currentTurnId = turnId;
      }
    } else if (kind === 'turn/end') {
      const turnId = data.turn;
      if (turnId !== undefined && turnId === currentTurnId) {
        currentTurnId = null;
      }
    }

    switch (kind) {
      case 'system/message': {
        const content = typeof data.content === 'string' ? data.content : '';
        messages.push(Object.freeze({ role: 'system', content }));
        break;
      }

      case 'user/message': {
        const content = typeof data.content === 'string' ? data.content : '';
        messages.push(Object.freeze({ role: 'user', content }));
        break;
      }

      case 'assistant/message': {
        const content = typeof data.content === 'string' ? data.content : '';
        const rawToolCalls = data.toolCalls ?? data.tool_calls;
        const toolCalls = normalizeToolCalls(rawToolCalls);
        messages.push(
          Object.freeze({
            role: 'assistant',
            content,
            ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {})
          })
        );
        break;
      }

      case 'assistant/attempt': {
        // By default, failed or cancelled stream attempts do NOT pollute model history.
        if (includeAttempts) {
          const content = typeof data.content === 'string' ? data.content : '';
          messages.push(Object.freeze({ role: 'assistant', content }));
        }
        break;
      }

      case 'tool/result': {
        const toolCallId =
          (typeof data.toolCallId === 'string' && data.toolCallId) ||
          (typeof data.tool_call_id === 'string' && data.tool_call_id) ||
          (typeof data.stepId === 'string' && data.stepId) ||
          event.stepId ||
          'unknown-tool-call';

        const rawContent = data.output ?? data.result ?? data;
        let content = safeStringify(rawContent);
        const name = typeof data.tool === 'string' ? data.tool : undefined;

        // Apply compaction only to unambiguously completed historical turns
        const eventTurn = (data.turn !== undefined && data.turn !== null && (typeof data.turn === 'string' || typeof data.turn === 'number'))
          ? data.turn
          : currentTurnId;

        const isEligible =
          compactionEnabled &&
          eventTurn !== null &&
          eventTurn !== undefined &&
          completedTurns.has(eventTurn) &&
          !openTurns.has(eventTurn) &&
          !ambiguousTurns.has(eventTurn);

        if (isEligible) {
          const L = content.length;
          const headCount = Math.min(headChars, L);
          const tailCount = Math.min(tailChars, L - headCount);
          const removedCount = L - headCount - tailCount;

          if (L > thresholdChars && removedCount > 0) {
            const pruned =
              content.slice(0, headCount) +
              `\n... [pruned ${removedCount} characters] ...\n` +
              (tailCount === 0 ? '' : content.slice(L - tailCount));

            if (pruned.length < L) {
              content = pruned;
            }
          }
        }

        messages.push(
          Object.freeze({
            role: 'tool',
            content,
            toolCallId,
            ...(name ? { name } : {})
          })
        );
        break;
      }

      default:
        // Ignore telemetry / lifecycle events (e.g. turn/start, step/start, guard_check, etc.)
        break;
    }
  }

  return Object.freeze(messages);
}
