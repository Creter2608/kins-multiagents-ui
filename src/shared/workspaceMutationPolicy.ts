/**
 * src/shared/workspaceMutationPolicy.ts
 * Pure, side-effect-free evaluator for workspace mutation permissions.
 * Shared across in-process WorkspaceWriteGuard and external Antigravity PreToolUse CLI Hook.
 */

import * as path from "node:path";
import type { LoopState } from "../engine.js";

export type WorkspaceMutationPolicyMode =
  | "strict"
  | "documentation-fast-path";

export interface WorkspaceMutationPolicyResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly isFastPath?: boolean;
}

export function isPathInside(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Evaluates whether a workspace-relative normalized path qualifies as an inert documentation target.
 * Hard-blocks sensitive prompt/instruction documents (AGENTS.md, GEMINI.md, CLAUDE.md)
 * and core specification/loop contracts (docs/LOOP.md).
 */
export function isSafeDocumentationTarget(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").trim();
  const basename = path.posix.basename(normalized).toLowerCase();

  // 1. Invariant: Agent instruction and prompt definition files are NEVER exempt
  if (basename === "agents.md" || basename === "gemini.md" || basename === "claude.md") {
    return false;
  }

  // 2. Invariant: Core loop specification and acceptance criteria are NEVER exempt
  if (normalized.toLowerCase() === "docs/loop.md" || normalized.toLowerCase().endsWith("/loop.md")) {
    return false;
  }

  // 3. Root README file
  if (normalized.toLowerCase() === "readme.md") {
    return true;
  }

  // 4. Root license files
  if (basename === "license" || basename === "license.txt" || basename === "license.md") {
    return true;
  }

  // 5. Safe documentation below docs/ (excluding loop.md)
  if (normalized.toLowerCase().startsWith("docs/")) {
    return normalized.endsWith(".md") || normalized.endsWith(".txt");
  }

  return false;
}

export function evaluateWorkspaceMutationPolicy(
  state: LoopState,
  targetPaths: readonly string[],
  workspaceRoot: string = process.cwd(),
  mode: WorkspaceMutationPolicyMode = "strict"
): WorkspaceMutationPolicyResult {
  if (!targetPaths || targetPaths.length === 0) {
    return {
      allowed: false,
      reason: "Mutation denied: targetPaths must contain at least one path"
    };
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const evalDir = path.resolve(normalizedRoot, ".eval");
  const blueprintFile = path.resolve(normalizedRoot, ".ai/blueprint.md");

  // Normalize requested paths
  const resolvedPaths = targetPaths.map((p) => path.resolve(normalizedRoot, p));

  // 1. Workspace escape check: paths must not escape workspace root
  for (const resolved of resolvedPaths) {
    const rel = path.relative(normalizedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        allowed: false,
        reason: `Mutation denied: target path '${resolved}' escapes the workspace root`
      };
    }
  }

  // 2. Invariant: .eval/ is STRICTLY READ-ONLY in all phases and modes
  for (const resolved of resolvedPaths) {
    if (resolved === evalDir || isPathInside(resolved, evalDir)) {
      return {
        allowed: false,
        reason: `Mutation denied: path '${resolved}' is inside protected evaluation directory (.eval/)`
      };
    }
  }

  // 3. Invariant: .ai/blueprint.md is immutable in all phases and modes once committed
  for (const resolved of resolvedPaths) {
    if (resolved === blueprintFile) {
      return {
        allowed: false,
        reason: "Mutation denied: .ai/blueprint.md is an immutable Stage 2 artifact and cannot be modified"
      };
    }
  }

  // 4. Documentation Fast Path evaluation
  if (mode === "documentation-fast-path") {
    const allAreSafeDocs = resolvedPaths.every((resolved) => {
      const rel = path.relative(normalizedRoot, resolved);
      return isSafeDocumentationTarget(rel);
    });

    if (allAreSafeDocs) {
      return {
        allowed: true,
        isFastPath: true,
        reason: "Documentation fast path permitted: safe documentation target"
      };
    }
  }

  // 5. Phase check: Non-exempt workspace mutations only permitted in EXECUTE
  if (state.currentPhase !== "EXECUTE") {
    return {
      allowed: false,
      reason: `Mutation denied: workspace modifications are only permitted during EXECUTE phase (current phase: '${state.currentPhase}')`
    };
  }

  // 6. Blueprint check: Even in EXECUTE, blueprint must be ready
  if (!state.blueprint || state.blueprint.status !== "ready") {
    return {
      allowed: false,
      reason: `Mutation denied: valid ready blueprint required before modifying workspace (current status: '${state.blueprint?.status ?? "none"}')`
    };
  }

  return {
    allowed: true,
    isFastPath: false,
    reason: "Mutation permitted: valid blueprint and active EXECUTE phase"
  };
}
