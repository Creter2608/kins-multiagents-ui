import { LoopError } from "./errors.js";
import type { Sha256Hex } from "./checksum.js";
import type { ResourceBudget, ResourceUsage } from "./shared/contracts.js";

export type PhaseId =
  | "INITIALIZE"
  | "SPEC_GATE"
  | "ISOLATE"
  | "DETECT_STACKS"
  | "PLAN"
  | "EXECUTE"
  | "VERIFY"
  | "REALITY_CHECK"
  | "RELEASE_GATE"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED";

export interface PhaseDefinition {
  readonly id: PhaseId;
  readonly allowedNext: readonly PhaseId[];
  readonly terminal?: boolean;
}

export interface LoopBudget {
  readonly maxTransitions: number;
  readonly maxRetries: number;
  readonly maxOperations: number;
}

export interface BudgetUsage {
  readonly transitions: number;
  readonly retries: number;
  readonly operations: number;
}

export interface TransitionRecord {
  readonly sequence: number;
  readonly from: PhaseId;
  readonly to: PhaseId;
  readonly triggeredBy?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly autoAdvanced?: boolean | undefined;
}

export type RunStatus = "ready" | "running" | "succeeded" | "failed" | "blocked";

export type AuditStatus =
  | "pending"
  | "running"
  | "accepted"
  | "remediation_required"
  | "closure_pending"
  | "closed"
  | "failed";

export interface AuditFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly description: string;
  readonly failingTestAssertion?: string | undefined;
  readonly resolved?: boolean | undefined;
}

export interface AuditRecord {
  readonly status: AuditStatus;
  readonly invocationKey?: string | undefined;
  readonly auditedTreeHash?: string | undefined;
  readonly findings?: readonly AuditFinding[] | undefined;
  readonly remediationCount: number;
  readonly report?: string | undefined;
  readonly completedAt?: number | undefined;
}

export type BlueprintStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed";

export interface GoldenAssertion {
  readonly in: string;
  readonly out: string;
}

export interface BlueprintRecord {
  readonly status: BlueprintStatus;
  readonly invocationKey: string;
  readonly invocationCount: 0 | 1;
  readonly artifactPath: ".ai/blueprint.md";
  readonly plannedTreeHash: Sha256Hex;
  readonly protectedEvalHash: Sha256Hex;
  readonly artifactSha256?: Sha256Hex | undefined;
  readonly assertionsSha256?: Sha256Hex | undefined;
  readonly goldenAssertions?: readonly GoldenAssertion[] | undefined;
  readonly oracleReceiptSha256?: Sha256Hex | undefined;
  readonly completedAt?: number | undefined;
  readonly failureCode?: string | undefined;
}

export function assertBlueprintAllowsExecution(state: LoopState): void {
  const bp = state.blueprint;
  if (!bp) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      "Cannot transition from PLAN to EXECUTE without a blueprint record in state"
    );
  }
  if (bp.status !== "ready") {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      `Cannot transition from PLAN to EXECUTE: blueprint status is '${bp.status}', expected 'ready'`
    );
  }
  if (bp.invocationCount !== 1) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      `Cannot transition from PLAN to EXECUTE: invocationCount must be 1, found ${bp.invocationCount}`
    );
  }
  if (bp.artifactPath !== ".ai/blueprint.md") {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      `Cannot transition from PLAN to EXECUTE: invalid artifactPath '${bp.artifactPath}'`
    );
  }
  if (!bp.artifactSha256) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      "Cannot transition from PLAN to EXECUTE: artifactSha256 is missing"
    );
  }
  if (!bp.assertionsSha256) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      "Cannot transition from PLAN to EXECUTE: assertionsSha256 is missing"
    );
  }
  if (!bp.goldenAssertions || !Array.isArray(bp.goldenAssertions)) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      "Cannot transition from PLAN to EXECUTE: goldenAssertions array is missing"
    );
  }
  if (bp.goldenAssertions.length < 3 || bp.goldenAssertions.length > 5) {
    throw new LoopError(
      "TRANSITION_INVALID",
      "transition",
      `Cannot transition from PLAN to EXECUTE: goldenAssertions must contain 3-5 items, found ${bp.goldenAssertions.length}`
    );
  }
  for (const [idx, item] of bp.goldenAssertions.entries()) {
    if (!item || typeof item.in !== "string" || !item.in.trim() || typeof item.out !== "string" || !item.out.trim()) {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Cannot transition from PLAN to EXECUTE: goldenAssertion at index ${idx} must have non-empty 'in' and 'out' strings`
      );
    }
  }
}

export type { ResourceBudget, ResourceUsage };

export interface OracleTelemetry {
  readonly invocationKey: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costMicroUsd: number;
}

export const DEFAULT_RESOURCE_BUDGET: ResourceBudget = {
  maxCostMicroUsd: 1_000_000,
  maxTokens: 120_000,
  maxOracleCalls: 2,
  maxGlobalCycles: 2,
  maxVerificationRetries: 1,
  maxQualityRemediations: 1
};

export const EMPTY_RESOURCE_USAGE: ResourceUsage = {
  costMicroUsd: 0,
  promptTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  oracleCalls: 0,
  globalCycles: 0,
  verificationRetries: 0,
  qualityRemediations: 0
};

export interface AuthenticatedBlueprintApproval {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly canonicalWorkspacePath: string;
  readonly blueprintSha256: string;
  readonly approvedAt: string;
  readonly signature: string;
}

export interface LoopState {
  readonly schemaVersion: 1 | 2;
  readonly revision: number;
  readonly runId: string;
  readonly currentPhase: PhaseId;
  readonly status: RunStatus;
  readonly goldenSha256: Sha256Hex;
  readonly budget: LoopBudget;
  readonly usage: BudgetUsage;
  readonly history: readonly TransitionRecord[];
  readonly lastError?: {
    readonly code: string;
    readonly message: string;
  };
  readonly audit?: AuditRecord | undefined;
  readonly blueprint?: BlueprintRecord | undefined;
  readonly blueprintApproval?: AuthenticatedBlueprintApproval | undefined;
  readonly resourceBudget: ResourceBudget;
  readonly resourceUsage: ResourceUsage;
}

export interface LoopEngineOptions {
  readonly phases: readonly PhaseDefinition[];
  readonly initialPhase: PhaseId;
  readonly terminalPhase: PhaseId;
  readonly budget: LoopBudget;
  readonly goldenSha256: Sha256Hex;
  readonly runId: string;
}

export class LoopEngine {
  private readonly phasesMap: ReadonlyMap<PhaseId, PhaseDefinition>;
  private state: LoopState;

  constructor(private readonly options: LoopEngineOptions, initialState?: LoopState) {
    this.phasesMap = new Map(options.phases.map((p) => [p.id, p]));
    if (!this.phasesMap.has(options.initialPhase)) {
      throw new LoopError("STATE_INVALID", "state", `Initial phase ${options.initialPhase} not defined in phases`);
    }
    if (!this.phasesMap.has(options.terminalPhase)) {
      throw new LoopError("STATE_INVALID", "state", `Terminal phase ${options.terminalPhase} not defined in phases`);
    }

    if (initialState) {
      this.state = {
        ...initialState,
        revision: typeof initialState.revision === "number" ? initialState.revision : 1,
        resourceBudget: initialState.resourceBudget ? { ...initialState.resourceBudget } : { ...DEFAULT_RESOURCE_BUDGET },
        resourceUsage: initialState.resourceUsage ? { ...initialState.resourceUsage } : { ...EMPTY_RESOURCE_USAGE },
        blueprint: initialState.blueprint
          ? {
              ...initialState.blueprint,
              goldenAssertions: initialState.blueprint.goldenAssertions
                ? [...initialState.blueprint.goldenAssertions]
                : undefined
            }
          : undefined,
        history: Array.isArray(initialState.history) ? [...initialState.history] : []
      };
    } else {
      this.state = {
        schemaVersion: 2,
        revision: 1,
        runId: options.runId,
        currentPhase: options.initialPhase,
        status: "ready",
        goldenSha256: options.goldenSha256,
        budget: { ...options.budget },
        usage: { transitions: 0, retries: 0, operations: 0 },
        resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
        resourceUsage: { ...EMPTY_RESOURCE_USAGE },
        history: []
      };
    }
  }

  snapshot(): LoopState {
    return {
      ...this.state,
      budget: { ...this.state.budget },
      usage: { ...this.state.usage },
      resourceBudget: { ...this.state.resourceBudget },
      resourceUsage: { ...this.state.resourceUsage },
      history: [...this.state.history],
      blueprint: this.state.blueprint
        ? {
            ...this.state.blueprint,
            goldenAssertions: this.state.blueprint.goldenAssertions
              ? [...this.state.blueprint.goldenAssertions]
              : undefined
          }
        : undefined,
      audit: this.state.audit
        ? {
            ...this.state.audit,
            findings: this.state.audit.findings ? [...this.state.audit.findings] : undefined
          }
        : undefined
    };
  }

  canTransition(to: PhaseId): boolean {
    if (this.state.status === "succeeded" || this.state.status === "failed" || this.state.status === "blocked") {
      return false;
    }
    const currentDef = this.phasesMap.get(this.state.currentPhase);
    if (!currentDef) {
      return false;
    }
    return currentDef.allowedNext.includes(to);
  }

  transition(
    to: PhaseId,
    metadata?: { triggeredBy?: string | undefined; timestamp?: number | undefined; autoAdvanced?: boolean | undefined }
  ): LoopState {
    if (this.state.status === "succeeded" || this.state.status === "failed") {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Cannot transition from terminal status '${this.state.status}'`
      );
    }

    if (!this.canTransition(to)) {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Illegal phase transition: ${this.state.currentPhase} -> ${to}`
      );
    }

    if (this.state.currentPhase === "PLAN" && to === "EXECUTE") {
      assertBlueprintAllowsExecution(this.state);
    }

    if (this.state.currentPhase === "REALITY_CHECK" && to === "RELEASE_GATE") {
      if (!this.state.audit || this.state.audit.status !== "closed") {
        throw new LoopError(
          "TRANSITION_INVALID",
          "transition",
          `Cannot transition from REALITY_CHECK to RELEASE_GATE unless audit is 'closed'. Current audit status: '${this.state.audit?.status ?? "none"}'.`
        );
      }
    }

    if (this.state.usage.transitions >= this.state.budget.maxTransitions) {
      throw new LoopError(
        "BUDGET_EXHAUSTED",
        "budget",
        `Transition budget exhausted (${this.state.usage.transitions}/${this.state.budget.maxTransitions})`
      );
    }

    const nextUsage: BudgetUsage = {
      ...this.state.usage,
      transitions: this.state.usage.transitions + 1
    };

    const nextHistory: TransitionRecord[] = [
      ...this.state.history,
      {
        sequence: this.state.history.length + 1,
        from: this.state.currentPhase,
        to,
        triggeredBy: metadata?.triggeredBy,
        timestamp: metadata?.timestamp ?? Date.now(),
        autoAdvanced: metadata?.autoAdvanced
      }
    ];

    let nextStatus: RunStatus = "running";
    if (to === this.options.terminalPhase) {
      nextStatus = "succeeded";
    } else if (to === "FAILED") {
      nextStatus = "failed";
    } else if (to === "BLOCKED") {
      nextStatus = "blocked";
    }

    let nextBlueprint: BlueprintRecord | undefined = this.state.blueprint;
    if (to === "PLAN" && !nextBlueprint) {
      nextBlueprint = {
        status: "pending",
        invocationKey: `${this.state.runId}:PLAN_ORACLE:v1`,
        invocationCount: 0,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: this.state.goldenSha256,
        protectedEvalHash: this.state.goldenSha256
      };
    }

    let nextAudit: AuditRecord | undefined = this.state.audit;
    if (to === "REALITY_CHECK") {
      if (!this.state.audit) {
        nextAudit = {
          status: "pending",
          remediationCount: 0
        };
      } else if (this.state.audit.status === "remediation_required") {
        nextAudit = {
          ...this.state.audit,
          status: "closure_pending"
        };
      }
    }

    const nextRevision = (this.state.revision ?? 1) + 1;

    this.state = {
      ...this.state,
      revision: nextRevision,
      currentPhase: to,
      status: nextStatus,
      usage: nextUsage,
      history: Object.freeze(nextHistory),
      blueprint: nextBlueprint,
      audit: nextAudit
    };

    return this.snapshot();
  }

  consumeRetry(count: number = 1): LoopState {
    if (!Number.isInteger(count) || count <= 0) {
      throw new LoopError("CONFIG_INVALID", "configuration", "Retry count must be a positive integer");
    }
    if (this.state.usage.retries + count > this.state.budget.maxRetries) {
      throw new LoopError(
        "BUDGET_EXHAUSTED",
        "budget",
        `Retry budget exhausted (${this.state.usage.retries + count} > ${this.state.budget.maxRetries})`
      );
    }
    this.state = {
      ...this.state,
      usage: {
        ...this.state.usage,
        retries: this.state.usage.retries + count
      }
    };
    return this.snapshot();
  }

  fail(code: string, message: string): LoopState {
    this.state = {
      ...this.state,
      currentPhase: "FAILED",
      status: "failed",
      lastError: { code, message }
    };
    return this.snapshot();
  }

  canRollback(): boolean {
    if (this.state.status === "succeeded") {
      return false;
    }
    const history = Array.isArray(this.state.history) ? this.state.history : [];
    if (
      this.state.currentPhase === this.options.initialPhase &&
      history.length === 0 &&
      this.state.status !== "failed" &&
      this.state.status !== "blocked"
    ) {
      return false;
    }
    return true;
  }

  rollback(): LoopState {
    if (this.state.status === "succeeded") {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Cannot rollback from terminal status '${this.state.status}'`
      );
    }

    if (!this.canRollback()) {
      throw new LoopError(
        "STATE_INVALID",
        "state",
        "Cannot rollback: transition history is empty"
      );
    }

    const history = Array.isArray(this.state.history) ? this.state.history : [];
    let priorPhase: PhaseId;
    let nextHistory: TransitionRecord[];

    if (history.length > 0) {
      const lastTransition = history[history.length - 1];
      if (!lastTransition) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          "Cannot rollback: transition history is empty"
        );
      }
      priorPhase = lastTransition.from;
      nextHistory = history.slice(0, -1);
    } else {
      // Fallback target using canonical phase order when history is absent
      const phaseIds = this.options.phases.map((p) => p.id);
      const currentIndex = phaseIds.indexOf(this.state.currentPhase);
      if (currentIndex > 0) {
        priorPhase = phaseIds[currentIndex - 1] ?? this.options.initialPhase;
      } else {
        priorPhase = this.options.initialPhase;
      }
      nextHistory = [];
    }

    const nextStatus: RunStatus =
      nextHistory.length === 0 && priorPhase === this.options.initialPhase ? "ready" : "running";

    const { lastError: _omittedError, ...restState } = this.state;
    this.state = {
      ...restState,
      currentPhase: priorPhase,
      status: nextStatus,
      history: Object.freeze(nextHistory)
    };

    return this.snapshot();
  }

  closeAudit(report?: string): LoopState {
    if (this.state.currentPhase !== "REALITY_CHECK") {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Cannot close audit outside of REALITY_CHECK phase. Current phase: '${this.state.currentPhase}'.`
      );
    }
    const currentAudit = this.state.audit;
    const curStatus = currentAudit?.status;
    if (curStatus !== "accepted" && curStatus !== "closure_pending" && curStatus !== "pending") {
      throw new LoopError(
        "TRANSITION_INVALID",
        "transition",
        `Cannot close audit when status is '${curStatus}' (expected 'accepted', 'closure_pending', or 'pending')`
      );
    }
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      audit: {
        status: "closed",
        remediationCount: currentAudit?.remediationCount ?? 0,
        report: report ?? currentAudit?.report,
        completedAt: Date.now()
      }
    };
    return this.snapshot();
  }

  setBlueprint(record: BlueprintRecord): LoopState {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      blueprint: {
        ...record,
        goldenAssertions: record.goldenAssertions ? [...record.goldenAssertions] : undefined
      }
    };
    return this.snapshot();
  }

  isTerminal(): boolean {
    return this.state.status === "succeeded" || this.state.status === "failed" || this.state.status === "blocked";
  }
}
