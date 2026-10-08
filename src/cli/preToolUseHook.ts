/**
 * src/cli/preToolUseHook.ts
 * Physical CLI PreToolUse hook for Antigravity / Gemini.
 * Intercepts replace_file_content and write_to_file, reading JSON from stdin
 * and emitting deterministic { decision: "allow" | "deny", reason: "..." } to stdout.
 */

import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import {
  canonicalizePath,
  verifyBlueprintApproval,
  authorizeMutation,
  type ActiveSessionAuthority
} from "../main/services/blueprintApprovalAuthenticator.js";
import {
  evaluateWorkspaceMutationPolicy,
  type WorkspaceMutationPolicyMode
} from "../shared/workspaceMutationPolicy.js";
import {
  PreToolUseHookService,
  verifyRegistryEntryHmac,
  type WorkspaceRegistryEntry
} from "../main/services/preToolUseHookService.js";
import type { LoopState } from "../engine.js";
import {
  type PreToolUseHookInput,
  type PreToolUseHookOutput,
  type PreToolUseHookDecision,
  type PreToolUseHookOptions,
  parseCliHookArgs,
  resolveDefaultUserDataPath,
  DEFAULT_SOURCE_READ_TOKEN_THRESHOLD,
  SOURCE_FILE_EXTENSIONS,
  isSourceCodePath,
  estimateFileTokens,
  isFullFileReadTool,
  isMutationTool
} from "./preToolUseHookHelpers.js";
import { evaluateReadGate } from "./preToolUseHookReadGate.js";

export {
  type PreToolUseHookInput,
  type PreToolUseHookOutput,
  type PreToolUseHookDecision,
  type PreToolUseHookOptions,
  parseCliHookArgs,
  resolveDefaultUserDataPath,
  DEFAULT_SOURCE_READ_TOKEN_THRESHOLD,
  SOURCE_FILE_EXTENSIONS,
  isSourceCodePath,
  estimateFileTokens,
  isFullFileReadTool,
  isMutationTool
};

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
  const isMutation = isMutationTool(toolName);
  const isRead = isFullFileReadTool(toolName);

  // A-03: Safely extract and validate raw target parameter type
  const rawTargetArg = payload.toolCall?.args
    ? (payload.toolCall.args.TargetFile ??
       payload.toolCall.args.targetFile ??
       payload.toolCall.args.AbsolutePath ??
       payload.toolCall.args.path)
    : undefined;

  if (rawTargetArg !== undefined && typeof rawTargetArg !== "string") {
    if (isMutation || isRead) {
      return {
        decision: "deny",
        reason: `Hook denied: invalid ${isMutation ? "TargetFile" : "AbsolutePath"} parameter type (expected string, got ${typeof rawTargetArg})`
      };
    }
  }

  const targetFileRaw = typeof rawTargetArg === "string" ? rawTargetArg.trim() : undefined;

  // Resolve target file path against workspacePaths if relative
  let resolvedTarget = "";
  if (targetFileRaw) {
    if (!path.isAbsolute(targetFileRaw)) {
      const baseDir = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) || process.cwd();
      resolvedTarget = path.resolve(baseDir, targetFileRaw);
    } else {
      resolvedTarget = targetFileRaw;
    }
  }
  const canonicalTarget = resolvedTarget ? canonicalizePath(resolvedTarget) : "";

  // F-01 / A-01: Resolve candidate workspace and evaluate active stealth rules BEFORE deciding non-mutation tools
  // Treat empty/absent resolvedTarget as absent so fallback reaches process.cwd()
  const candidateWorkspacePath = (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) ||
    (resolvedTarget || undefined) ||
    process.cwd();
  let activeStealth = PreToolUseHookService.findActiveStealthRulesForPath(candidateWorkspacePath);

  // Determine paths and options
  let customRegistryPath: string | undefined;
  let customAuthKeyPath: string | undefined;
  let customUserDataPath: string | undefined;
  let env: NodeJS.ProcessEnv = process.env;

  if (optionsOrEnv && typeof optionsOrEnv === "object") {
    if (
      "registryPath" in optionsOrEnv ||
      "authKeyPath" in optionsOrEnv ||
      "userDataPath" in optionsOrEnv ||
      "env" in optionsOrEnv
    ) {
      const opts = optionsOrEnv as PreToolUseHookOptions;
      customRegistryPath = opts.registryPath;
      customAuthKeyPath = opts.authKeyPath;
      customUserDataPath = opts.userDataPath;
      if (opts.env) {
        env = opts.env;
      }
    } else {
      env = optionsOrEnv as NodeJS.ProcessEnv;
    }
  }

  const userDataPath = customUserDataPath ?? resolveDefaultUserDataPath(env);
  const registryPath = customRegistryPath ?? path.join(userDataPath, "hooks", "workspaces.json");

  let cachedSigningKey: Buffer | null = null;
  const loadSigningKey = async (): Promise<Buffer> => {
    if (cachedSigningKey) return cachedSigningKey;
    if (customAuthKeyPath) {
      cachedSigningKey = await fs.readFile(customAuthKeyPath);
    } else {
      cachedSigningKey = await PreToolUseHookService.getOrCreateSigningKey(userDataPath);
    }
    return cachedSigningKey;
  };

  // Fallback disk lookup for active stealth rules if not present in memory
  if (!activeStealth) {
    try {
      if (syncFs.existsSync(registryPath)) {
        let authKey: Buffer | null = null;
        try {
          authKey = await loadSigningKey();
        } catch {
          authKey = null;
        }

        if (authKey) {
          const raw = await fs.readFile(registryPath, "utf-8");
          const reg = JSON.parse(raw);
          for (const [wsPath, entry] of Object.entries((reg.workspaces ?? {}) as Record<string, WorkspaceRegistryEntry>)) {
            const canonWs = canonicalizePath(wsPath);
            const canonCandidate = canonicalizePath(candidateWorkspacePath);
            if (canonCandidate === canonWs || canonCandidate.startsWith(canonWs.endsWith("/") ? canonWs : `${canonWs}/`)) {
              // A-02: Mandatory authentication before sidecar state/manifest reads
              if (!entry.entryHmac || !verifyRegistryEntryHmac(entry, authKey)) {
                continue;
              }

              const sidecarDir = path.dirname(entry.sidecarStatePath);
              const manifestPath = path.join(sidecarDir, "stealth", "manifest.json");
              if (syncFs.existsSync(manifestPath)) {
                const manRaw = await fs.readFile(manifestPath, "utf-8");
                const man = JSON.parse(manRaw);
                activeStealth = {
                  workspaceId: man.workspaceId ?? entry.canonicalWorkspacePath,
                  policyRevision: man.policyRevision ?? "default",
                  protectedPaths: [
                    manifestPath,
                    man.excludePath,
                    ...(man.files ?? []).map((f: { path: string }) => f.path)
                  ],
                  verificationCommandIds: ["npm test"],
                  includeDesignPack: man.includeDesignPack
                };
                break;
              }
            }
          }
        }
      }
    } catch {
      // Ignore disk manifest read failure
    }
  }

  // F-01 Enforcement: Active stealth rules gate opaque tools and release actions
  if (activeStealth) {
    if (toolName === "bash" || toolName === "run_command" || toolName === "run_command_opaque") {
      return {
        decision: "deny",
        reason: `[KINS_STEALTH] Denied (UNSUPPORTED_TOOL): Tool '${toolName}' is an unsupported opaque mutation under active stealth rules. Remediation: Use standard surgical file editing tools (replace_file_content, write_to_file) or sandboxed execution.`
      };
    }
    if (toolName === "release_gate_approval" || (payload as { isReleaseAction?: boolean }).isReleaseAction || toolName === "release_action") {
      const hookService = new PreToolUseHookService();
      if (!hookService.isVerificationFresh(activeStealth.workspaceId)) {
        return {
          decision: "deny",
          reason: "[KINS_STEALTH] Denied (VERIFICATION_REQUIRED): Release action blocked: Verification suite has not confirmed passing status for current code revision. Remediation: Execute local tests and verification commands before releasing."
        };
      }
    }
  }

  if (!isMutation && !isRead) {
    // If neither mutation nor full-file read tool, allow it through
    return { decision: "allow", reason: `Tool '${toolName}' is not a mutation tool` };
  }

  if (!targetFileRaw || typeof targetFileRaw !== "string") {
    if (isMutation) {
      return { decision: "deny", reason: `Mutation tool '${toolName}' missing TargetFile parameter` };
    } else {
      return { decision: "deny", reason: `Read tool '${toolName}' missing AbsolutePath parameter` };
    }
  }

  // Read-Gate: Anti-Token-Drain protocol for view_file
  if (isRead) {
    return await evaluateReadGate(payload, canonicalTarget, {
      userDataPath,
      registryPath,
      customAuthKeyPath
    });
  }

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
    signingKey = await loadSigningKey();
  } catch (err) {
    return {
      decision: "deny",
      reason: `Hook denied: failed to access installation signing key: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // AUTH-001: Authenticate registry entry before reading sidecar state (Mandatory Full Entry HMAC)
  if (!matchedWorkspace.entryHmac) {
    return {
      decision: "deny",
      reason: "Hook denied: workspace registry entry has no entry HMAC signature (unsigned registry entry)"
    };
  }

  const isEntryValid = verifyRegistryEntryHmac(matchedWorkspace, signingKey);
  if (!isEntryValid) {
    return {
      decision: "deny",
      reason: "Hook denied: workspace registry entry HMAC signature verification failed (tampered registry entry)"
    };
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

  // Invariant 1: Protected Evaluation Zone (.eval/) is strictly read-only
  if (
    canonicalTarget.includes("/.eval/") ||
    canonicalTarget.includes("\\.eval\\") ||
    canonicalTarget.endsWith("/.eval") ||
    canonicalTarget.endsWith("\\.eval")
  ) {
    return {
      decision: "deny",
      reason: "[KINS_STEALTH] Denied: Protected evaluation zone (.eval/) is strictly read-only for all agents."
    };
  }

  // Invariant 2: Host-enforced Stealth Rules Gatekeeper
  const sidecarDir = path.dirname(matchedWorkspace.sidecarStatePath);
  const stealthManifestPath = path.join(sidecarDir, "stealth", "manifest.json");
  try {
    if (syncFs.existsSync(stealthManifestPath)) {
      const manifestRaw = await fs.readFile(stealthManifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw);
      const stealthPaths = [
        canonicalizePath(stealthManifestPath),
        canonicalizePath(manifest.excludePath),
        ...(manifest.files ?? []).map((f: { path: string }) => canonicalizePath(f.path))
      ];

      if (stealthPaths.includes(canonicalTarget)) {
        return {
          decision: "deny",
          reason: `[KINS_STEALTH] Denied: Target path '${canonicalTarget}' is protected under active stealth rules. Remediation: Never tamper with stealth rules or exclude configuration.`
        };
      }

      if (manifest.includeDesignPack) {
        const normTarget = canonicalTarget.replace(/\\/g, "/");
        if (
          (normTarget.endsWith(".tsx") || normTarget.endsWith(".jsx") || normTarget.endsWith(".css")) &&
          !normTarget.includes("TerminalStage.tsx")
        ) {
          const toolArgs = payload.toolCall?.args;
          const content = String(toolArgs?.CodeContent || toolArgs?.ReplacementContent || "");
          for (const banned of PreToolUseHookService.BANNED_LEGACY_HEXES) {
            if (content.includes(banned)) {
              return {
                decision: "deny",
                reason: `[KINS_STEALTH] Denied: Prohibited legacy color hex '${banned}' introduced in UI file. Remediation: Replace with approved Zinc tokens (bg-zinc-950, bg-zinc-900, bg-zinc-800, border-zinc-800, text-zinc-100).`
              };
            }
          }
        }
      }
    }
  } catch {
    // Ignore error reading stealth manifest
  }

  // 1. If fast-path mode is active, check if target is an inert documentation file
  // 1. Active Session & Mutation Authorization check (Mandatory for ALL mutations, including fast paths)
  const activeSession: ActiveSessionAuthority | null =
    PreToolUseHookService.getActiveSession(matchedWorkspace.canonicalWorkspacePath) ??
    matchedWorkspace.activeSession ??
    null;

  if (!activeSession) {
    return {
      decision: "deny",
      reason: "VIOLATION: Mutation authorization denied (NO_ACTIVE_SESSION): No active mutation session authority registered for workspace."
    };
  }

  const candidateAuth = (payload as { authorization?: unknown }).authorization ?? matchedWorkspace.sessionAuthorization;
  if (!candidateAuth) {
    return {
      decision: "deny",
      reason: "VIOLATION: Mutation authorization denied (MISSING_AUTHORIZATION): Mutation payload missing authorization envelope."
    };
  }

  const authDecision = authorizeMutation(
    candidateAuth,
    { canonicalPath: canonicalTarget },
    activeSession,
    signingKey
  );
  if (!authDecision.allowed) {
    return {
      decision: "deny",
      reason: `VIOLATION: Mutation authorization denied (${authDecision.reason}): Invalid, expired, or mismatched session authorization.`
    };
  }

  // Verify that state runId matches activeSession runId
  if (state.runId !== activeSession.runId) {
    return {
      decision: "deny",
      reason: `VIOLATION: Mutation denied (SESSION_MISMATCH): State runId '${state.runId}' does not match active session runId '${activeSession.runId}'.`
    };
  }

  // 2. If fast-path mode is active, check if target is an inert documentation file
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

  // 3. For non-fast-path mutations, verify HMAC Blueprint approval first
  const isApproved = verifyBlueprintApproval(state, matchedWorkspace.canonicalWorkspacePath, signingKey);
  if (!isApproved) {
    return {
      decision: "deny",
      reason: "VIOLATION: Mutation denied! Stage 2 Blueprint has not been approved and authenticated with a valid signature. Gemini cannot mutate files without GPT planning."
    };
  }

  // Verify blueprint digest matches activeSession
  if (state.blueprint?.artifactSha256) {
    if (state.blueprint.artifactSha256.toLowerCase() !== activeSession.blueprintDigest.toLowerCase()) {
      return {
        decision: "deny",
        reason: "VIOLATION: Mutation denied (APPROVAL_MISMATCH): Blueprint digest does not match active approved blueprint."
      };
    }
  }

  // 4. Verify shared mutation policy (phase, .eval, blueprint immutability)
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

export async function runPreToolUseHookCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    let inputStr = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) {
      inputStr += chunk;
    }

    const inputJson = JSON.parse(inputStr);
    const cliOptions: PreToolUseHookOptions = { ...parseCliHookArgs(argv), env: process.env };
    const result = await evaluatePreToolUseHook(inputJson, cliOptions);
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
