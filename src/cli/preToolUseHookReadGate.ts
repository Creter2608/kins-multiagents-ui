/**
 * src/cli/preToolUseHookReadGate.ts
 * Read-Gate Anti-Token-Drain protocol implementation for Antigravity CLI PreToolUse Hook.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalizePath } from "../main/services/blueprintApprovalAuthenticator.js";
import {
  PreToolUseHookService,
  verifyRegistryEntryHmac,
  verifyExplorationEvidenceHmac,
  type WorkspaceRegistryEntry,
  type CodeGraphExplorationEvidence
} from "../main/services/preToolUseHookService.js";
import {
  type PreToolUseHookInput,
  type PreToolUseHookDecision,
  DEFAULT_SOURCE_READ_TOKEN_THRESHOLD,
  isSourceCodePath,
  estimateFileTokens
} from "./preToolUseHookHelpers.js";

export interface ReadGateContext {
  readonly userDataPath: string;
  readonly registryPath: string;
  readonly customAuthKeyPath?: string | undefined;
}

export async function evaluateReadGate(
  payload: PreToolUseHookInput,
  canonicalTarget: string,
  context: ReadGateContext
): Promise<PreToolUseHookDecision> {
  const { userDataPath, registryPath, customAuthKeyPath } = context;

  if (!isSourceCodePath(canonicalTarget)) {
    return { decision: "allow", reason: "Read permitted: target is not a source code file" };
  }

  let sizeBytes = 0;
  try {
    const stat = await fs.stat(canonicalTarget);
    sizeBytes = stat.size;
  } catch {
    return { decision: "allow", reason: "Read permitted: target file not found on disk" };
  }

  const estimatedTokens = estimateFileTokens(sizeBytes);
  if (estimatedTokens <= DEFAULT_SOURCE_READ_TOKEN_THRESHOLD) {
    return {
      decision: "allow",
      reason: `Read permitted: file size within low-token threshold (${estimatedTokens} <= ${DEFAULT_SOURCE_READ_TOKEN_THRESHOLD})`
    };
  }

  let registry: { workspaces?: Record<string, WorkspaceRegistryEntry> } = {};
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    registry = JSON.parse(raw);
  } catch {
    return {
      decision: "allow",
      reason: `Read permitted: workspace registry not found at '${registryPath}'`
    };
  }

  let matchedWorkspace: WorkspaceRegistryEntry | null = null;
  let longestMatchLen = -1;
  for (const [wsPath, entry] of Object.entries(registry.workspaces ?? {})) {
    const canonWs = canonicalizePath(wsPath);
    if (canonicalTarget === canonWs || canonicalTarget.startsWith(canonWs.endsWith("/") ? canonWs : `${canonWs}/`)) {
      if (canonWs.length > longestMatchLen) {
        longestMatchLen = canonWs.length;
        matchedWorkspace = entry;
      }
    }
  }

  if (!matchedWorkspace) {
    return {
      decision: "allow",
      reason: `Read permitted: target file '${canonicalTarget}' is outside any registered Cockpit workspace.`
    };
  }

  let signingKey: Buffer;
  try {
    if (customAuthKeyPath) {
      signingKey = await fs.readFile(customAuthKeyPath);
    } else {
      signingKey = await PreToolUseHookService.getOrCreateSigningKey(userDataPath);
    }
  } catch {
    return {
      decision: "deny",
      reason: "Hook denied: failed to access installation signing key"
    };
  }

  if (!matchedWorkspace.entryHmac || !verifyRegistryEntryHmac(matchedWorkspace, signingKey)) {
    return {
      decision: "deny",
      reason: "Hook denied: workspace registry entry HMAC verification failed"
    };
  }

  const codeGraphDir = path.join(matchedWorkspace.canonicalWorkspacePath, ".codegraph");
  let codeGraphActive = false;
  try {
    const stat = await fs.stat(codeGraphDir);
    codeGraphActive = stat.isDirectory();
  } catch {
    codeGraphActive = false;
  }

  if (!codeGraphActive) {
    return {
      decision: "allow",
      reason: `Read permitted: CodeGraph is not active in workspace '${matchedWorkspace.canonicalWorkspacePath}'`
    };
  }

  let authoritativeRunId: string | null = null;
  const sidecarDir = path.dirname(matchedWorkspace.sidecarStatePath);
  try {
    const stateRaw = await fs.readFile(matchedWorkspace.sidecarStatePath, "utf-8");
    const state = JSON.parse(stateRaw);
    if (typeof state.runId === "string" && state.runId.trim()) {
      authoritativeRunId = state.runId;
    }
  } catch {
    // cannot load state
  }

  if (!authoritativeRunId) {
    return {
      decision: "deny",
      reason: `Anti-Token-Drain Protocol: sidecar state or authoritative runId missing for workspace '${matchedWorkspace.canonicalWorkspacePath}'.`
    };
  }

  if (payload.runId && payload.runId !== authoritativeRunId) {
    return {
      decision: "deny",
      reason: `Anti-Token-Drain Protocol: payload runId '${payload.runId}' does not match authoritative workspace runId '${authoritativeRunId}'.`
    };
  }

  let explored = false;
  // 1. Check sidecar codegraph-evidence.json
  const evidencePath = path.join(sidecarDir, "codegraph-evidence.json");
  try {
    const evRaw = await fs.readFile(evidencePath, "utf-8");
    const ev: CodeGraphExplorationEvidence = JSON.parse(evRaw);
    if (
      ev.runId === authoritativeRunId &&
      canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
      verifyExplorationEvidenceHmac(ev, signingKey)
    ) {
      explored = true;
    }
  } catch {
    // not found
  }

  // 2. Check state.json
  if (!explored) {
    try {
      const stateRaw = await fs.readFile(matchedWorkspace.sidecarStatePath, "utf-8");
      const state = JSON.parse(stateRaw);
      if (state.codeGraphExploration) {
        const ev: CodeGraphExplorationEvidence = state.codeGraphExploration;
        if (
          ev.runId === authoritativeRunId &&
          canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
          verifyExplorationEvidenceHmac(ev, signingKey)
        ) {
          explored = true;
        }
      }
    } catch {
      // not found
    }
  }

  // 3. Check fallback userData/hooks/evidence/<authoritativeRunId>.json
  if (!explored) {
    const fallbackEvidencePath = path.join(userDataPath, "hooks", "evidence", `${authoritativeRunId}.json`);
    try {
      const evRaw = await fs.readFile(fallbackEvidencePath, "utf-8");
      const ev: CodeGraphExplorationEvidence = JSON.parse(evRaw);
      if (
        ev.runId === authoritativeRunId &&
        canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
        verifyExplorationEvidenceHmac(ev, signingKey)
      ) {
        explored = true;
      }
    } catch {
      // not found
    }
  }

  if (explored) {
    return {
      decision: "allow",
      reason: `Read permitted: CodeGraph exploration verified for run '${authoritativeRunId}'`
    };
  }

  return {
    decision: "deny",
    reason: `Anti-Token-Drain Protocol: view_file denied for a large source file in a CodeGraph-enabled workspace; run codegraph_explore in the current run before requesting the full file (estimatedTokens=${estimatedTokens}, threshold=${DEFAULT_SOURCE_READ_TOKEN_THRESHOLD}).`
  };
}
