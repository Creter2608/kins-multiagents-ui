/**
 * src/shared/stealthRules.ts
 * Core contracts and data structures for Immortal Stealth Rules enforcement.
 */

export const STEALTH_TRANSPARENCY_TAG = "[KINS_STEALTH]" as const;

export type StealthViolationCode =
  | "PROTECTED_PATH"
  | "LEGACY_COLOR"
  | "VERIFICATION_REQUIRED"
  | "POLICY_UNAVAILABLE"
  | "POLICY_STALE"
  | "UNSUPPORTED_TOOL";

export interface ActiveStealthRules {
  readonly workspaceId: string;
  readonly policyRevision: string;
  readonly protectedPaths: readonly string[];
  readonly colorRuleId?: string;
  readonly verificationCommandIds: readonly string[];
  readonly includeDesignPack?: boolean;
}

export interface StealthViolation {
  readonly code: StealthViolationCode;
  readonly message: string;
  readonly remediation: string;
}

export interface StealthDecisionMetadata {
  readonly transparencyTag: typeof STEALTH_TRANSPARENCY_TAG;
  readonly workspaceId: string;
  readonly policyRevision: string;
  readonly violations: readonly StealthViolation[];
}

export interface StealthEvaluationRequest {
  readonly toolName: string;
  readonly targetPath?: string;
  readonly projectedContent?: string;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly isReleaseAction?: boolean;
}

export interface StealthEvaluationDecision {
  readonly allowed: boolean;
  readonly metadata: StealthDecisionMetadata;
  readonly denialMessage?: string;
}
