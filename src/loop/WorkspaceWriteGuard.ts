import * as path from "node:path";
import { LoopError } from "../errors.js";
import type { LoopState } from "../engine.js";

export type WorkspaceMutationKind =
  | "create"
  | "modify"
  | "delete"
  | "rename"
  | "command";

export interface WorkspaceMutationRequest {
  readonly kind: WorkspaceMutationKind;
  readonly paths: readonly string[];
}

export function isPathInside(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function assertWorkspaceMutationAllowed(
  state: LoopState,
  request: WorkspaceMutationRequest,
  workspaceRoot: string = process.cwd()
): void {
  const normalizedRoot = path.resolve(workspaceRoot);
  const evalDir = path.resolve(normalizedRoot, ".eval");
  const blueprintFile = path.resolve(normalizedRoot, ".ai/blueprint.md");

  // Normalize requested paths
  const resolvedPaths = request.paths.map((p) => path.resolve(normalizedRoot, p));

  // 1. Invariant: .eval/ is STRICTLY READ-ONLY in all phases
  for (const resolved of resolvedPaths) {
    if (resolved === evalDir || isPathInside(resolved, evalDir)) {
      throw new LoopError(
        "SPECIFICATION_INTEGRITY",
        "security",
        `Mutation denied: path '${resolved}' is inside protected evaluation directory (.eval/)`
      );
    }
  }

  // 2. Invariant: .ai/blueprint.md is immutable in all phases once committed
  for (const resolved of resolvedPaths) {
    if (resolved === blueprintFile) {
      throw new LoopError(
        "SPECIFICATION_INTEGRITY",
        "security",
        "Mutation denied: .ai/blueprint.md is an immutable Stage 2 artifact and cannot be modified"
      );
    }
  }

  // 3. Phase check: Workspace mutations only permitted in EXECUTE
  if (state.currentPhase !== "EXECUTE") {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      `Mutation denied: workspace modifications are only permitted during EXECUTE phase (current phase: '${state.currentPhase}')`
    );
  }

  // 4. Blueprint check: Even in EXECUTE, blueprint must be ready
  if (!state.blueprint || state.blueprint.status !== "ready") {
    throw new LoopError(
      "BLUEPRINT_REQUIRED",
      "state",
      `Mutation denied: valid ready blueprint required before modifying workspace (current status: '${state.blueprint?.status ?? "none"}')`
    );
  }
}
