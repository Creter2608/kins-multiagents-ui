/**
 * src/shared/workspaceMutationPolicy.ts
 * Pure, side-effect-free evaluator for workspace mutation permissions.
 * Shared across in-process WorkspaceWriteGuard and external Antigravity PreToolUse CLI Hook.
 */

import * as path from "node:path";
import type { LoopState } from "../engine.js";

export interface WorkspaceMutationPolicyResult {
  readonly allowed: boolean;
  readonly reason: string;
}

export function isPathInside(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function evaluateWorkspaceMutationPolicy(
  state: LoopState,
  targetPaths: readonly string[],
  workspaceRoot: string = process.cwd()
): WorkspaceMutationPolicyResult {
  const normalizedRoot = path.resolve(workspaceRoot);
  const evalDir = path.resolve(normalizedRoot, ".eval");
  const blueprintFile = path.resolve(normalizedRoot, ".ai/blueprint.md");

  // Normalize requested paths
  const resolvedPaths = targetPaths.map((p) => path.resolve(normalizedRoot, p));

  // 1. Invariant: .eval/ is STRICTLY READ-ONLY in all phases
  for (const resolved of resolvedPaths) {
    if (resolved === evalDir || isPathInside(resolved, evalDir)) {
      return {
        allowed: false,
        reason: `Mutation denied: path '${resolved}' is inside protected evaluation directory (.eval/)`
      };
    }
  }

  // 2. Invariant: .ai/blueprint.md is immutable in all phases once committed
  for (const resolved of resolvedPaths) {
    if (resolved === blueprintFile) {
      return {
        allowed: false,
        reason: "Mutation denied: .ai/blueprint.md is an immutable Stage 2 artifact and cannot be modified"
      };
    }
  }

  // 3. Phase check: Workspace mutations only permitted in EXECUTE
  if (state.currentPhase !== "EXECUTE") {
    return {
      allowed: false,
      reason: `Mutation denied: workspace modifications are only permitted during EXECUTE phase (current phase: '${state.currentPhase}')`
    };
  }

  // 4. Blueprint check: Even in EXECUTE, blueprint must be ready
  if (!state.blueprint || state.blueprint.status !== "ready") {
    return {
      allowed: false,
      reason: `Mutation denied: valid ready blueprint required before modifying workspace (current status: '${state.blueprint?.status ?? "none"}')`
    };
  }

  return {
    allowed: true,
    reason: "Mutation permitted: valid blueprint and active EXECUTE phase"
  };
}
