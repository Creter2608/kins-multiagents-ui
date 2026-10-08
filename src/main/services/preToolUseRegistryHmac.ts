/**
 * src/main/services/preToolUseRegistryHmac.ts
 * Cryptographic HMAC generation and timing-safe verification for
 * PreToolUse hook workspace registry and exploration evidence.
 */

import * as crypto from "node:crypto";
import { canonicalizePath } from "./blueprintApprovalAuthenticator.js";
import type { WorkspaceMutationPolicyMode } from "../../shared/workspaceMutationPolicy.js";

import type { ActiveSessionAuthority } from "./blueprintApprovalAuthenticator.js";
import type { MutationAuthorization } from "../../cli/preToolUseHookHelpers.js";

export interface WorkspaceRegistryEntry {
  readonly canonicalWorkspacePath: string;
  readonly sidecarStatePath: string;
  readonly schemaVersion: 1;
  readonly registeredAt: string;
  readonly mutationPolicyMode?: WorkspaceMutationPolicyMode;
  readonly modeHmac?: string;
  readonly entryHmac?: string;
  readonly activeSession?: ActiveSessionAuthority;
  readonly sessionAuthorization?: MutationAuthorization;
}

export interface WorkspaceRegistryFile {
  readonly version: 1;
  readonly workspaces: Record<string, WorkspaceRegistryEntry>;
}

export interface CodeGraphExplorationEvidence {
  readonly runId: string;
  readonly canonicalWorkspacePath: string;
  readonly completedAt: string;
  readonly evidenceHmac: string;
}

export function computeModeHmac(
  mode: WorkspaceMutationPolicyMode,
  canonicalWorkspace: string,
  signingKey: Buffer
): string {
  return crypto
    .createHmac("sha256", signingKey)
    .update(`${canonicalWorkspace}:${mode}`)
    .digest("hex");
}

export function verifyModeHmac(
  mode: WorkspaceMutationPolicyMode,
  canonicalWorkspace: string,
  modeHmac: string | undefined,
  signingKey: Buffer
): boolean {
  if (!modeHmac || typeof modeHmac !== "string") return false;
  const expected = computeModeHmac(mode, canonicalWorkspace, signingKey);
  if (expected.length !== modeHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(modeHmac, "hex"));
}

export function computeRegistryEntryHmac(
  entry: {
    readonly canonicalWorkspacePath: string;
    readonly sidecarStatePath: string;
    readonly schemaVersion: number;
    readonly mutationPolicyMode?: WorkspaceMutationPolicyMode;
  },
  signingKey: Buffer
): string {
  const payload = [
    entry.canonicalWorkspacePath,
    entry.sidecarStatePath,
    entry.mutationPolicyMode ?? "strict",
    String(entry.schemaVersion)
  ].join("::");
  return crypto.createHmac("sha256", signingKey).update(payload).digest("hex");
}

export function verifyRegistryEntryHmac(
  entry: WorkspaceRegistryEntry,
  signingKey: Buffer
): boolean {
  if (!entry.entryHmac || typeof entry.entryHmac !== "string") return false;
  const expected = computeRegistryEntryHmac(entry, signingKey);
  if (expected.length !== entry.entryHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(entry.entryHmac, "hex"));
}

export function computeExplorationEvidenceHmac(
  evidence: Omit<CodeGraphExplorationEvidence, "evidenceHmac">,
  signingKey: Buffer
): string {
  const payload = [
    evidence.runId,
    canonicalizePath(evidence.canonicalWorkspacePath),
    evidence.completedAt
  ].join(":");
  return crypto.createHmac("sha256", signingKey).update(payload, "utf-8").digest("hex");
}

export function verifyExplorationEvidenceHmac(
  evidence: CodeGraphExplorationEvidence,
  signingKey: Buffer
): boolean {
  if (!evidence.evidenceHmac) return false;
  const expected = computeExplorationEvidenceHmac(evidence, signingKey);
  if (expected.length !== evidence.evidenceHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(evidence.evidenceHmac, "hex"));
}
