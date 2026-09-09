import { LoopError } from "../errors.js";
import type { LoopState } from "../engine.js";
import { evaluateWorkspaceMutationPolicy, isPathInside } from "../shared/workspaceMutationPolicy.js";

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

export { isPathInside };

export function assertWorkspaceMutationAllowed(
  state: LoopState,
  targetPaths: readonly string[],
  workspaceRoot?: string
): void;
export function assertWorkspaceMutationAllowed(
  state: LoopState,
  request: WorkspaceMutationRequest,
  workspaceRoot?: string
): void;
export function assertWorkspaceMutationAllowed(
  state: LoopState,
  pathsOrRequest: readonly string[] | WorkspaceMutationRequest,
  workspaceRoot: string = process.cwd()
): void {
  const targetPaths: readonly string[] = Array.isArray(pathsOrRequest)
    ? pathsOrRequest
    : (pathsOrRequest as WorkspaceMutationRequest).paths;
  const result = evaluateWorkspaceMutationPolicy(state, targetPaths, workspaceRoot);
  if (!result.allowed) {
    if (result.reason.includes(".eval/")) {
      throw new LoopError("SPECIFICATION_INTEGRITY", "security", result.reason);
    }
    if (result.reason.includes(".ai/blueprint.md")) {
      throw new LoopError("SPECIFICATION_INTEGRITY", "security", result.reason);
    }
    if (result.reason.includes("current phase:")) {
      throw new LoopError("TRANSITION_INVALID", "transition", result.reason);
    }
    if (result.reason.includes("valid ready blueprint required")) {
      throw new LoopError("BLUEPRINT_REQUIRED", "state", result.reason);
    }
    throw new LoopError("EXECUTION_FAILED", "execution", result.reason);
  }
}
