/**
 * src/main/services/blueprintApprovalAuthenticator.ts
 * Cryptographic HMAC-SHA256 signer and timing-safe validator for Stage 2 Blueprint Approvals.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import type { AuthenticatedBlueprintApproval, LoopState } from "../../engine.js";

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
