/**
 * src/cli/preToolUseHook.ts
 * Physical CLI PreToolUse hook for Antigravity / Gemini.
 * Intercepts replace_file_content and write_to_file, reading JSON from stdin
 * and emitting deterministic { decision: "allow" | "deny", reason: "..." } to stdout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { canonicalizePath, verifyBlueprintApproval } from "../main/services/blueprintApprovalAuthenticator.js";
import {
  evaluateWorkspaceMutationPolicy,
  type WorkspaceMutationPolicyMode
} from "../shared/workspaceMutationPolicy.js";
import {
  PreToolUseHookService,
  verifyModeHmac,
  verifyRegistryEntryHmac,
  type WorkspaceRegistryEntry
} from "../main/services/preToolUseHookService.js";
import type { LoopState } from "../engine.js";

export interface PreToolUseHookInput {
  readonly toolCall?: {
    readonly name?: string;
    readonly args?: {
      readonly TargetFile?: string;
      readonly targetFile?: string;
    };
  };
  readonly workspacePaths?: readonly string[];
}

export interface PreToolUseHookOutput {
  readonly decision: "allow" | "deny" | "ask";
  readonly reason: string;
}

export type PreToolUseHookDecision = PreToolUseHookOutput;

export interface PreToolUseHookOptions {
  readonly registryPath?: string;
  readonly authKeyPath?: string;
}

export function isMutationTool(name?: string): boolean {
  return name === "replace_file_content" || name === "write_to_file";
}

export async function evaluatePreToolUseHook(
  input: PreToolUseHookInput | unknown,
  optionsOrEnv?: PreToolUseHookOptions | NodeJS.ProcessEnv
): Promise<PreToolUseHookDecision> {
  // Fail-closed by default
  if (!input || typeof input !== "object") {
    return { decision: "deny", reason: "Invalid hook input payload: expected JSON object" };
  }

  const payload = input as PreToolUseHookInput;
  const toolName = payload.toolCall?.name;

  if (!isMutationTool(toolName)) {
    // If not a mutation tool, allow it through
    return { decision: "allow", reason: `Tool '${toolName}' is not a mutation tool` };
  }

  const targetFileRaw = payload.toolCall?.args?.TargetFile ?? payload.toolCall?.args?.targetFile;
  if (!targetFileRaw || typeof targetFileRaw !== "string") {
    return { decision: "deny", reason: `Mutation tool '${toolName}' missing TargetFile parameter` };
  }

  // Resolve target file path against workspacePaths if relative
  let resolvedTarget = targetFileRaw;
  if (!path.isAbsolute(resolvedTarget)) {
    const baseDir = payload.workspacePaths?.[0] ?? process.cwd();
    resolvedTarget = path.resolve(baseDir, resolvedTarget);
  }
  const canonicalTarget = canonicalizePath(resolvedTarget);

  // Determine paths and options
  let customRegistryPath: string | undefined;
  let customAuthKeyPath: string | undefined;
  let env: NodeJS.ProcessEnv = process.env;

  if (optionsOrEnv && typeof optionsOrEnv === "object") {
    if ("registryPath" in optionsOrEnv || "authKeyPath" in optionsOrEnv) {
      customRegistryPath = optionsOrEnv.registryPath;
      customAuthKeyPath = optionsOrEnv.authKeyPath;
    } else {
      env = optionsOrEnv as NodeJS.ProcessEnv;
    }
  }

  const userDataPath = env.ANTIGRAVITY_HOOK_USER_DATA ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "userData");
  const registryPath = customRegistryPath ?? path.join(userDataPath, "hooks", "workspaces.json");

  let registry: { workspaces?: Record<string, WorkspaceRegistryEntry> } = {};
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    registry = JSON.parse(raw);
  } catch {
    return {
      decision: "deny",
      reason: `Hook denied: workspace registry not found at '${registryPath}'. Target repo is not equipped with Cockpit sidecar.`
    };
  }

  // Find containing workspace with longest prefix match
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
      decision: "deny",
      reason: `Hook denied: target file '${canonicalTarget}' is outside any registered Cockpit workspace.`
    };
  }

  // Load signing key before inspecting state
  let signingKey: Buffer;
  try {
    if (customAuthKeyPath) {
      signingKey = await fs.readFile(customAuthKeyPath);
    } else {
      signingKey = await PreToolUseHookService.getOrCreateSigningKey(userDataPath);
    }
  } catch (err) {
    return {
      decision: "deny",
      reason: `Hook denied: failed to access installation signing key: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // AUTH-001: Authenticate registry entry before reading sidecar state
  if (matchedWorkspace.entryHmac) {
    const isEntryValid = verifyRegistryEntryHmac(matchedWorkspace, signingKey);
    if (!isEntryValid) {
      return {
        decision: "deny",
        reason: "Hook denied: workspace registry entry HMAC signature verification failed (tampered registry entry)"
      };
    }
  } else if (matchedWorkspace.modeHmac) {
    const isModeValid = verifyModeHmac(
      matchedWorkspace.mutationPolicyMode ?? "strict",
      matchedWorkspace.canonicalWorkspacePath,
      matchedWorkspace.modeHmac,
      signingKey
    );
    if (!isModeValid) {
      return {
        decision: "deny",
        reason: "Hook denied: mutation policy mode HMAC signature verification failed (tampered registry entry)"
      };
    }
  }

  let mode: WorkspaceMutationPolicyMode = "strict";
  if (matchedWorkspace.mutationPolicyMode !== undefined) {
    const rawMode = matchedWorkspace.mutationPolicyMode;
    if (rawMode !== "strict" && rawMode !== "documentation-fast-path") {
      return {
        decision: "deny",
        reason: `Hook denied: invalid mutation policy mode '${String(rawMode)}' in workspace registry`
      };
    }
    mode = rawMode;
  }

  // Load sidecar state.json after verifying registry authentication
  let state: LoopState;
  try {
    const stateRaw = await fs.readFile(matchedWorkspace.sidecarStatePath, "utf-8");
    state = JSON.parse(stateRaw);
  } catch (err) {
    return {
      decision: "deny",
      reason: `Hook denied: failed to read sidecar state at '${matchedWorkspace.sidecarStatePath}': ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 1. If fast-path mode is active, check if target is an inert documentation file
  if (mode === "documentation-fast-path") {
    const fastPathResult = evaluateWorkspaceMutationPolicy(
      state,
      [canonicalTarget],
      matchedWorkspace.canonicalWorkspacePath,
      mode
    );
    if (fastPathResult.allowed && fastPathResult.isFastPath) {
      return {
        decision: "allow",
        reason: fastPathResult.reason
      };
    }
  }

  // 2. For non-fast-path mutations, verify HMAC Blueprint approval first
  const isApproved = verifyBlueprintApproval(state, matchedWorkspace.canonicalWorkspacePath, signingKey);
  if (!isApproved) {
    return {
      decision: "deny",
      reason: "VIOLATION: Mutation denied! Stage 2 Blueprint has not been approved and authenticated with a valid signature. Gemini cannot mutate files without GPT planning."
    };
  }

  // 3. Verify shared mutation policy (phase, .eval, blueprint immutability)
  const policyResult = evaluateWorkspaceMutationPolicy(
    state,
    [canonicalTarget],
    matchedWorkspace.canonicalWorkspacePath,
    mode
  );
  if (!policyResult.allowed) {
    return {
      decision: "deny",
      reason: policyResult.reason
    };
  }

  return {
    decision: "allow",
    reason: "Mutation permitted: Stage 2 Blueprint approved, valid HMAC signature, active EXECUTE phase"
  };
}

export async function runPreToolUseHookCli(): Promise<number> {
  try {
    let inputStr = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) {
      inputStr += chunk;
    }

    const inputJson = JSON.parse(inputStr);
    const result = await evaluatePreToolUseHook(inputJson);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (err) {
    const fallback: PreToolUseHookOutput = {
      decision: "deny",
      reason: `Hook internal failure: ${err instanceof Error ? err.message : String(err)}`
    };
    process.stdout.write(JSON.stringify(fallback) + "\n");
    return 0;
  }
}

// Auto-run if executed directly as CLI script
if (process.argv[1] && (process.argv[1].endsWith("preToolUseHook.js") || process.argv[1].endsWith("preToolUseHook.ts"))) {
  runPreToolUseHookCli().catch(() => process.exit(1));
}
