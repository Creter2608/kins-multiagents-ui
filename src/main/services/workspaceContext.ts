/**
 * src/main/services/workspaceContext.ts
 * Canonical immutable workspace context contracts for multi-project sidecar architecture.
 */

export type {
  RuleSource,
  ResolvedRuleBlock,
  WorkspaceRecord,
  WorkspaceContext,
  GlobalIdeTarget,
  StealthRuleTarget,
  GlobalIdeSyncResult,
  StealthEquipResult,
  StealthUnequipResult,
  WorkspaceStealthStatus
} from "../../shared/contracts.js";

import type { WorkspaceContext, ResolvedRuleBlock } from "../../shared/contracts.js";

export interface AgentWorkspaceInput {
  readonly context: WorkspaceContext;
  readonly ruleBlocks: readonly ResolvedRuleBlock[];
}

