/**
 * src/main/services/blueprintApprovalAuthenticator.ts
 * Cryptographic HMAC-SHA256 signer and timing-safe validator for Stage 2 Blueprint Approvals.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import type { AuthenticatedBlueprintApproval, LoopState } from "../../engine.js";
import type {
  MutationAuthorization,
  AuthorizationDecision,
  ExistingMutationTarget
} from "../../cli/preToolUseHookHelpers.js";

export interface CreateBlueprintApprovalInput {
  readonly runId: string;
  readonly canonicalWorkspacePath: string;
  readonly blueprintSha256: string;
  readonly approvedAt?: string | undefined;
}

export function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32"
    ? resolved.toLowerCase().replace(/\\/g, "/")
    : resolved;
}

export function buildApprovalSignaturePayload(
  schemaVersion: 1,
  runId: string,
  canonicalWorkspacePath: string,
  blueprintSha256: string,
  approvedAt: string
): string {
  return `${schemaVersion}:${runId}:${canonicalizePath(canonicalWorkspacePath)}:${blueprintSha256.toLowerCase()}:${approvedAt}`;
}

export function createBlueprintApproval(
  input: CreateBlueprintApprovalInput,
  signingKey: Buffer
): AuthenticatedBlueprintApproval {
  const schemaVersion: 1 = 1;
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  const canonicalWorkspace = canonicalizePath(input.canonicalWorkspacePath);
  const blueprintSha256 = input.blueprintSha256.toLowerCase();

  const payload = buildApprovalSignaturePayload(
    schemaVersion,
    input.runId,
    canonicalWorkspace,
    blueprintSha256,
    approvedAt
  );

  const signature = crypto.createHmac("sha256", signingKey).update(payload, "utf-8").digest("hex");

  return Object.freeze({
    schemaVersion,
    runId: input.runId,
    canonicalWorkspacePath: canonicalWorkspace,
    blueprintSha256,
    approvedAt,
    signature
  });
}

export function verifyBlueprintApproval(
  state: LoopState,
  canonicalWorkspacePath: string,
  signingKey: Buffer
): boolean {
  const approval = state.blueprintApproval;
  if (!approval) {
    return false;
  }

  if (approval.schemaVersion !== 1) {
    return false;
  }

  if (approval.runId !== state.runId) {
    return false;
  }

  const expectedWorkspace = canonicalizePath(canonicalWorkspacePath);
  if (canonicalizePath(approval.canonicalWorkspacePath) !== expectedWorkspace) {
    return false;
  }

  if (state.blueprint && state.blueprint.artifactSha256) {
    if (state.blueprint.artifactSha256.toLowerCase() !== approval.blueprintSha256.toLowerCase()) {
      return false;
    }
  }

  const expectedPayload = buildApprovalSignaturePayload(
    approval.schemaVersion,
    approval.runId,
    approval.canonicalWorkspacePath,
    approval.blueprintSha256,
    approval.approvedAt
  );

  const expectedSignature = crypto.createHmac("sha256", signingKey).update(expectedPayload, "utf-8").digest("hex");

  const sigBuf = Buffer.from(approval.signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");

  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export interface ActiveSessionAuthority {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly blueprintDigest: string;
  readonly leaseExpiresAtMs: number;
}

export function buildMutationAuthorizationPayload(
  version: 1,
  sessionId: string,
  runId: string,
  canonicalWorkspacePath: string,
  revision: number,
  phase: "EXECUTE",
  blueprintDigest: string,
  issuedAtMs: number,
  expiresAtMs: number
): string {
  return `${version}:${sessionId}:${runId}:${canonicalizePath(canonicalWorkspacePath)}:${revision}:${phase}:${blueprintDigest.toLowerCase()}:${issuedAtMs}:${expiresAtMs}`;
}

export function signMutationAuthorization(
  auth: Omit<MutationAuthorization, "signature">,
  signingKey: Buffer
): MutationAuthorization {
  const payload = buildMutationAuthorizationPayload(
    auth.version,
    auth.sessionId,
    auth.runId,
    auth.workspaceId,
    auth.revision,
    auth.phase,
    auth.blueprintDigest,
    auth.issuedAtMs,
    auth.expiresAtMs
  );
  const signature = crypto.createHmac("sha256", signingKey).update(payload, "utf-8").digest("hex");
  return Object.freeze({
    ...auth,
    signature
  });
}

export function verifyMutationAuthorizationSignature(
  auth: MutationAuthorization,
  signingKey: Buffer
): boolean {
  if (auth.version !== 1 || auth.phase !== "EXECUTE") {
    return false;
  }
  if (typeof auth.signature !== "string" || !/^[0-9a-f]{64}$/i.test(auth.signature)) {
    return false;
  }
  const payload = buildMutationAuthorizationPayload(
    auth.version,
    auth.sessionId,
    auth.runId,
    auth.workspaceId,
    auth.revision,
    auth.phase,
    auth.blueprintDigest,
    auth.issuedAtMs,
    auth.expiresAtMs
  );
  const expectedSignature = crypto.createHmac("sha256", signingKey).update(payload, "utf-8").digest("hex");
  const sigBuf = Buffer.from(auth.signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export function authorizeMutation(
  authorization: unknown,
  target: ExistingMutationTarget,
  activeSession?: ActiveSessionAuthority | null,
  signingKey?: Buffer | null
): AuthorizationDecision {
  // 1. Target protection invariant
  const canonTarget = canonicalizePath(target.canonicalPath);
  if (
    target.isProtectedTarget ||
    canonTarget.includes("/.eval/") ||
    canonTarget.includes("\\.eval\\") ||
    canonTarget.endsWith("/.eval") ||
    canonTarget.endsWith("\\.eval")
  ) {
    return { allowed: false, reason: "PROTECTED_TARGET" };
  }

  // 2. Shape validation
  if (!authorization || typeof authorization !== "object") {
    return { allowed: false, reason: "MALFORMED" };
  }

  const a = authorization as Partial<MutationAuthorization>;
  if (
    a.version !== 1 ||
    typeof a.sessionId !== "string" || !a.sessionId.trim() ||
    typeof a.runId !== "string" || !a.runId.trim() ||
    typeof a.workspaceId !== "string" || !a.workspaceId.trim() ||
    typeof a.revision !== "number" || !Number.isInteger(a.revision) || a.revision < 1 ||
    typeof a.blueprintDigest !== "string" || !a.blueprintDigest.trim() ||
    typeof a.issuedAtMs !== "number" || !Number.isFinite(a.issuedAtMs) ||
    typeof a.expiresAtMs !== "number" || !Number.isFinite(a.expiresAtMs) ||
    a.issuedAtMs >= a.expiresAtMs ||
    typeof a.signature !== "string" || !/^[0-9a-f]{64}$/i.test(a.signature)
  ) {
    return { allowed: false, reason: "MALFORMED" };
  }

  if (a.phase !== "EXECUTE") {
    return { allowed: false, reason: "PHASE_DENIED" };
  }

  // 3. Active session authority binding
  if (!activeSession) {
    return { allowed: false, reason: "NO_ACTIVE_SESSION" };
  }

  if (a.sessionId !== activeSession.sessionId) {
    return { allowed: false, reason: "SESSION_MISMATCH" };
  }

  if (a.runId !== activeSession.runId) {
    return { allowed: false, reason: "SESSION_MISMATCH" };
  }

  if (canonicalizePath(a.workspaceId) !== canonicalizePath(activeSession.workspaceId)) {
    return { allowed: false, reason: "WORKSPACE_MISMATCH" };
  }

  if (a.revision < activeSession.revision) {
    return { allowed: false, reason: "STALE_REVISION" };
  }

  if (a.blueprintDigest.toLowerCase() !== activeSession.blueprintDigest.toLowerCase()) {
    return { allowed: false, reason: "APPROVAL_MISMATCH" };
  }

  const nowMs = Date.now();
  if (
    nowMs >= a.expiresAtMs ||
    typeof activeSession.leaseExpiresAtMs !== "number" ||
    nowMs >= activeSession.leaseExpiresAtMs
  ) {
    return { allowed: false, reason: "EXPIRED" };
  }

  // 4. Mandatory cryptographic signature verification (Fail-Closed)
  if (!signingKey || signingKey.length === 0) {
    return { allowed: false, reason: "BAD_SIGNATURE" };
  }

  const valid = verifyMutationAuthorizationSignature(a as MutationAuthorization, signingKey);
  if (!valid) {
    return { allowed: false, reason: "BAD_SIGNATURE" };
  }

  return { allowed: true };
}

