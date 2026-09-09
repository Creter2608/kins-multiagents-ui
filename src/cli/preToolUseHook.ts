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
import { evaluateWorkspaceMutationPolicy } from "../shared/workspaceMutationPolicy.js";
import { PreToolUseHookService } from "../main/services/preToolUseHookService.js";
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

export function isMutationTool(name?: string): boolean {
  return name === "replace_file_content" || name === "write_to_file";
}

export async function evaluatePreToolUseHook(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env
): Promise<PreToolUseHookOutput> {
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

  // Determine userDataPath
  const userDataPath = environment.ANTIGRAVITY_HOOK_USER_DATA ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "userData");
  const registryPath = path.join(userDataPath, "hooks", "workspaces.json");

  let registry: { workspaces?: Record<string, { canonicalWorkspacePath: string; sidecarStatePath: string }> } = {};
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
  let matchedWorkspace: { canonicalWorkspacePath: string; sidecarStatePath: string } | null = null;
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

  // Load sidecar state.json
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

  // Load signing key
  let signingKey: Buffer;
  try {
    signingKey = await PreToolUseHookService.getOrCreateSigningKey(userDataPath);
  } catch (err) {
    return {
      decision: "deny",
      reason: `Hook denied: failed to access installation signing key: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // Verify HMAC Blueprint approval
  const isApproved = verifyBlueprintApproval(state, matchedWorkspace.canonicalWorkspacePath, signingKey);
  if (!isApproved) {
    return {
      decision: "deny",
      reason: "VIOLATION: Mutation denied! Stage 2 Blueprint has not been approved and authenticated with a valid signature. Gemini cannot mutate files without GPT planning."
    };
  }

  // Verify shared mutation policy (phase, .eval, blueprint immutability)
  const policyResult = evaluateWorkspaceMutationPolicy(state, [canonicalTarget], matchedWorkspace.canonicalWorkspacePath);
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
