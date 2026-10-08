/**
 * src/main/harness/HookBridge.ts
 * Normalizes external provider lifecycle hooks (Claude Code / OpenAI Codex)
 * into standardized SessionEvents for cockpit observation without granting execution authority.
 */

import type { SessionEvent } from '../../shared/harnessContracts.js';

export const SENSITIVE_KEY_REGEX = /(?:api[-_]?key|token|secret|authorization|password|credential)/i;
export const SENSITIVE_STRING_REGEX = /(?:--password=|[?&](?:api[-_]?key|token|secret)=|Bearer\s+)(\S+)/gi;

/**
 * Recursively sanitizes an object by stripping sensitive keys and masking credentials in strings.
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[Truncated Depth]';
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_STRING_REGEX, (match, cred) => {
      return match.replace(cred, '[REDACTED]');
    });
  }
  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = sanitizePayload(v, depth + 1);
    }
  }
  return result;
}

export function normalizeHook(
  provider: 'claude-code' | 'codex',
  payload: unknown,
  runId: string = 'external-run'
): SessionEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const raw = payload as Record<string, unknown>;
  const rawEvent = typeof raw['event'] === 'string' ? raw['event'] : typeof raw['type'] === 'string' ? raw['type'] : '';

  let normalizedKind = 'hook_event';
  let stepId: string | undefined = undefined;

  if (typeof raw['stepId'] === 'string') {
    stepId = raw['stepId'];
  } else if (typeof raw['call_id'] === 'string') {
    stepId = raw['call_id'];
  }

  if (provider === 'claude-code') {
    switch (rawEvent) {
      case 'session_start':
        normalizedKind = 'hook_session_start';
        break;
      case 'prompt_submit':
        normalizedKind = 'hook_prompt_submit';
        break;
      case 'pre_tool_use':
        normalizedKind = 'hook_pre_tool_use';
        break;
      case 'post_tool_use':
        normalizedKind = 'hook_post_tool_use';
        break;
      case 'stop':
        normalizedKind = 'hook_session_stop';
        break;
      default:
        normalizedKind = `hook_${rawEvent || 'unknown'}`;
    }
  } else if (provider === 'codex') {
    switch (rawEvent) {
      case 'session.init':
        normalizedKind = 'hook_session_start';
        break;
      case 'turn.request':
        normalizedKind = 'hook_prompt_submit';
        break;
      case 'tool.execute':
        normalizedKind = 'hook_pre_tool_use';
        break;
      case 'tool.response':
        normalizedKind = 'hook_post_tool_use';
        break;
      case 'turn.finish':
        normalizedKind = 'hook_session_stop';
        break;
      default:
        normalizedKind = `hook_${rawEvent.replace(/\./g, '_') || 'unknown'}`;
    }
  }

  const sanitized = sanitizePayload(raw) as Record<string, unknown>;

  return {
    schemaVersion: 1,
    runId,
    sequence: 0,
    timestamp: new Date().toISOString(),
    source: 'hook',
    kind: normalizedKind,
    ...(stepId ? { stepId } : {}),
    data: sanitized
  };
}
