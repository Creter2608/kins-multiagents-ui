/**
 * Shared contracts for ECC (Everything Claude Code) capability absorption.
 * Defines read-only catalog summaries, snapshots, dispatch requests, and IPC channel constants.
 */

export type EccAssetKind = "agent" | "skill";
export type EccAssetType = EccAssetKind;
export type EccAssetStatus = "available" | "quarantined";

export interface EccAssetSummary {
  readonly id: string;
  readonly kind: EccAssetKind;
  readonly type?: EccAssetKind | undefined;
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly digest?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly status: EccAssetStatus;
  readonly reasons: readonly string[];
  readonly category?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly model?: string | undefined;
}

export interface EccCatalogSnapshot {
  readonly revision: string;
  readonly sourceRoot: string;
  readonly availableCount: number;
  readonly quarantinedCount: number;
  readonly assets: readonly EccAssetSummary[];
  readonly diagnostics: readonly string[];
  readonly refreshedAt: number;
}

export interface EccDispatchRequest {
  readonly catalogRevision: string;
  readonly agentId: string;
  readonly skillIds: readonly string[];
  readonly task: string;
}

export type EccDispatchRejectReason =
  | "STALE_CATALOG"
  | "INVALID_SELECTION"
  | "QUARANTINED"
  | "CONTEXT_LIMIT"
  | "POLICY_DENIED"
  | "STALE_PROJECT";

export interface EccSkillOptimizationMetrics {
  readonly originalBytes: number;
  readonly compactedBytes: number;
  readonly savingsRatio: number;
  readonly includedSkillCount: number;
  readonly truncatedSkillCount: number;
}

export interface EccDispatchedMetadata {
  readonly source: "ecc";
  readonly agentId: string;
  readonly skillIds: readonly string[];
  readonly optimization?: EccSkillOptimizationMetrics | undefined;
}

export type EccDispatchResult =
  | {
      readonly accepted: true;
      readonly invocationId: string;
      readonly optimization?: EccSkillOptimizationMetrics | undefined;
    }
  | {
      readonly accepted: false;
      readonly reason: EccDispatchRejectReason;
      readonly message?: string;
    };

export interface EccApi {
  readonly getCatalog: () => Promise<EccCatalogSnapshot>;
  readonly refreshCatalog: () => Promise<EccCatalogSnapshot>;
  readonly dispatch?: (request: EccDispatchRequest) => Promise<EccDispatchResult>;
}

export const ECC_IPC_CHANNELS = {
  GET_CATALOG: "ecc:get-catalog",
  REFRESH_CATALOG: "ecc:refresh-catalog",
  DISPATCH: "ecc:dispatch"
} as const;
