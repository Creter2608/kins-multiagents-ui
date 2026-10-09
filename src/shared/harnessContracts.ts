/**
 * src/shared/harnessContracts.ts
 * Core immutable transport contracts and types adapted from DeepSeek Harness patterns.
 */

export type SandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export interface ToolStep {
  readonly id: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolPlan {
  readonly version: 1;
  readonly steps: readonly ToolStep[];
}

export interface ToolResult {
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'timed-out';
  readonly stepId: string;
  readonly tool: string;
  readonly output?: string;
  readonly reasonCode?: string;
}

export interface SessionEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source: 'loop' | 'tool' | 'hook' | 'transcript' | 'guard';
  readonly kind: string;
  readonly stepId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SandboxPolicyConfig {
  readonly mode: SandboxMode;
  readonly targetRoot: string;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly protectedRoots: readonly string[];
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reasonCode?: string;
  readonly resolvedPath?: string;
}

export interface GuardDecision {
  readonly allowed: boolean;
  readonly reasonCode?: string;
  readonly message?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>> | string;
}

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly name?: string;
}

export interface ToolResultPruneConfig {
  readonly enabled?: boolean;
  readonly thresholdChars?: number;
  readonly headChars?: number;
  readonly tailChars?: number;
}

export interface DeriveMessagesOptions {
  readonly includeAttempts?: boolean;
  readonly compaction?: ToolResultPruneConfig;
}

export interface SpillRef {
  readonly locator: string;
  readonly bytes: number;
  readonly retrievalHint: string;
}

export interface SaveSpillInput {
  readonly owner: { readonly sessionId: string };
  readonly source: {
    readonly kind: string;
    readonly toolName: string;
    readonly callId: string;
    readonly label?: string;
  };
  readonly suggestedName: string;
  readonly content: string;
}
