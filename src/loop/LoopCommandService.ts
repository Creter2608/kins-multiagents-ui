import { LoopError } from "../errors.js";
import { parseSha256Hex, type Sha256Hex } from "../checksum.js";
import {
  LoopEngine,
  EMPTY_RESOURCE_USAGE,
  type PhaseId,
  type PhaseDefinition,
  type LoopState,
  type AuditFinding,
  type AuditRecord,
  type OracleTelemetry,
  type ResourceUsage,
  type BlueprintRecord,
  type GoldenAssertion
} from "../engine.js";
import type { LoopStateStore } from "./LoopStateStore.js";
import { FileBlueprintArtifactVerifier, type BlueprintArtifactVerifier } from "./BlueprintArtifactVerifier.js";

export const CANONICAL_PHASES: readonly PhaseDefinition[] = [
  { id: "INITIALIZE", allowedNext: ["SPEC_GATE", "FAILED"] },
  { id: "SPEC_GATE", allowedNext: ["ISOLATE", "BLOCKED"] },
  { id: "ISOLATE", allowedNext: ["DETECT_STACKS", "BLOCKED", "FAILED"] },
  { id: "DETECT_STACKS", allowedNext: ["PLAN", "FAILED"] },
  { id: "PLAN", allowedNext: ["EXECUTE", "BLOCKED", "FAILED"] },
  { id: "EXECUTE", allowedNext: ["VERIFY", "BLOCKED", "FAILED"] },
  { id: "VERIFY", allowedNext: ["REALITY_CHECK", "EXECUTE", "BLOCKED", "FAILED"] },
  { id: "REALITY_CHECK", allowedNext: ["RELEASE_GATE", "EXECUTE", "BLOCKED", "FAILED"] },
  { id: "RELEASE_GATE", allowedNext: ["COMPLETE", "BLOCKED"] },
  { id: "COMPLETE", allowedNext: [], terminal: true },
  { id: "BLOCKED", allowedNext: [], terminal: true },
  { id: "FAILED", allowedNext: [], terminal: true }
];

const CANONICAL_ADVANCEMENT: Readonly<Record<string, PhaseId>> = {
  INITIALIZE: "SPEC_GATE",
  ISOLATE: "DETECT_STACKS",
  DETECT_STACKS: "PLAN",
  PLAN: "EXECUTE",
  EXECUTE: "VERIFY",
  VERIFY: "REALITY_CHECK",
  REALITY_CHECK: "RELEASE_GATE"
};

export type LoopTransitionAction = "advance" | "approve" | "reject";

export interface LoopTransitionCommand {
  readonly runId: string;
  readonly expectedPhase: PhaseId;
  readonly expectedRevision: number;
  readonly action: LoopTransitionAction;
  readonly targetPhase?: PhaseId | undefined;
  readonly reason?: string | undefined;
  readonly actor: "agent" | "human" | "system";
}

export type AuditMutation =
  | {
      readonly kind: "begin";
      readonly invocationKey: string;
      readonly auditedTreeHash: string;
    }
  | {
      readonly kind: "complete";
      readonly invocationKey: string;
      readonly findings: readonly AuditFinding[];
      readonly report: string;
      readonly completedAt: number;
      readonly telemetry?: OracleTelemetry | undefined;
    }
  | {
      readonly kind: "begin_remediation";
    }
  | {
      readonly kind: "close";
      readonly report?: string;
      readonly completedAt: number;
    }
  | {
      readonly kind: "fail";
      readonly report: string;
      readonly completedAt: number;
    };

export type BlueprintMutation =
  | {
      readonly kind: "begin";
      readonly invocationKey: string;
      readonly plannedTreeHash: Sha256Hex;
      readonly protectedEvalHash: Sha256Hex;
    }
  | {
      readonly kind: "complete";
      readonly invocationKey: string;
      readonly artifactSha256: Sha256Hex;
      readonly assertionsSha256: Sha256Hex;
      readonly goldenAssertions: readonly GoldenAssertion[];
      readonly oracleReceiptSha256?: Sha256Hex | undefined;
      readonly completedAt: number;
    }
  | {
      readonly kind: "fail";
      readonly failureCode: string;
    };

export interface BlueprintMutationCommand {
  readonly runId: string;
  readonly expectedPhase: "PLAN";
  readonly expectedRevision: number;
  readonly mutation: BlueprintMutation;
}

export interface AuditMutationCommand {
  readonly runId: string;
  readonly expectedPhase: "REALITY_CHECK";
  readonly expectedRevision: number;
  readonly mutation: AuditMutation;
}

export interface UsageMutationCommand {
  readonly runId: string;
  readonly expectedPhase: PhaseId;
  readonly expectedRevision: number;
  readonly telemetry?: OracleTelemetry | undefined;
  readonly globalCycles?: number | undefined;
  readonly verificationRetries?: number | undefined;
}

export interface LoopTransitionResult {
  readonly previousPhase: PhaseId;
  readonly state: LoopState;
}

export class LoopPhaseConflictError extends Error {
  readonly code = "PHASE_CONFLICT" as const;
  constructor(
    readonly expectedPhase: PhaseId,
    readonly actualPhase: PhaseId,
    message?: string
  ) {
    super(
      message ||
        `Phase conflict: expected '${expectedPhase}', but current phase is '${actualPhase}'`
    );
    this.name = "LoopPhaseConflictError";
  }
}

export class LoopRevisionConflictError extends Error {
  readonly code = "OPTIMISTIC_CONCURRENCY_CONFLICT" as const;
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
    message?: string
  ) {
    super(
      message ||
        `Revision conflict: expected revision ${expectedRevision}, but current revision is ${actualRevision}`
    );
    this.name = "LoopRevisionConflictError";
  }
}

function assertRevisionMatches(expectedRevision: unknown, actualRevision: number): void {
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new LoopError(
      "CONFIG_INVALID",
      "configuration",
      `Invalid expectedRevision: '${expectedRevision}'. Monotonic positive integer required.`
    );
  }
  if (expectedRevision !== actualRevision) {
    throw new LoopRevisionConflictError(expectedRevision, actualRevision);
  }
}

export class LoopCommandService {
  private readonly blueprintVerifier: BlueprintArtifactVerifier;

  constructor(
    private readonly store: LoopStateStore,
    private readonly phases: readonly PhaseDefinition[] = CANONICAL_PHASES,
    blueprintVerifier?: BlueprintArtifactVerifier | undefined
  ) {
    this.blueprintVerifier = blueprintVerifier ?? new FileBlueprintArtifactVerifier();
  }

  async status(): Promise<LoopState> {
    return this.store.read();
  }

  async transition(
    command: LoopTransitionCommand
  ): Promise<LoopTransitionResult> {
    let prevPhase: PhaseId = command.expectedPhase;
    const updatedState = await this.store.update(async (current) => {
      // 1. Validate runId
      if (current.runId !== command.runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${command.runId}'`
        );
      }

      // 2. Validate expectedPhase & expectedRevision (Optimistic Concurrency)
      if (current.currentPhase !== command.expectedPhase) {
        throw new LoopPhaseConflictError(
          command.expectedPhase,
          current.currentPhase
        );
      }

      assertRevisionMatches(command.expectedRevision, current.revision);

      prevPhase = current.currentPhase;
      let targetPhase: PhaseId;

      // 3. Action handling
      if (command.action === "approve") {
        if (current.currentPhase === "SPEC_GATE") {
          targetPhase = "ISOLATE";
        } else if (current.currentPhase === "RELEASE_GATE") {
          targetPhase = "COMPLETE";
        } else {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Action 'approve' is only valid at SPEC_GATE or RELEASE_GATE (current: ${current.currentPhase})`
          );
        }
      } else if (command.action === "reject") {
        if (
          current.currentPhase !== "SPEC_GATE" &&
          current.currentPhase !== "RELEASE_GATE"
        ) {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Action 'reject' is only valid at SPEC_GATE or RELEASE_GATE (current: ${current.currentPhase})`
          );
        }
        if (!command.reason || !command.reason.trim()) {
          throw new LoopError(
            "CONFIG_INVALID",
            "configuration",
            "Rejection requires a non-blank reason"
          );
        }
        targetPhase = "BLOCKED";
      } else if (command.action === "advance") {
        if (
          current.currentPhase === "SPEC_GATE" ||
          current.currentPhase === "RELEASE_GATE"
        ) {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot 'advance' at gates (${current.currentPhase}); must 'approve' or 'reject'`
          );
        }

        const requestedPhase = command.targetPhase ?? CANONICAL_ADVANCEMENT[current.currentPhase];
        if (!requestedPhase) {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `No canonical default advancement defined from phase '${current.currentPhase}'`
          );
        }

        // HARD ENFORCEMENT HOOK: Cannot advance from PLAN to EXECUTE without valid ready blueprint
        if (current.currentPhase === "PLAN" && requestedPhase === "EXECUTE") {
          if (!current.blueprint || current.blueprint.status !== "ready") {
            throw new LoopError(
              "TRANSITION_INVALID",
              "transition",
              `Cannot advance from PLAN to EXECUTE: Stage 2 Technical Blueprint status must be 'ready' (current: '${current.blueprint?.status ?? "none"}'). Call craft_technical_prompt_with_gpt first.`
            );
          }
          await this.blueprintVerifier.verifyReadyBlueprint(current);
        }

        // HARD ENFORCEMENT HOOK: Cannot advance from REALITY_CHECK to RELEASE_GATE without closed audit status
        if (current.currentPhase === "REALITY_CHECK" && requestedPhase === "RELEASE_GATE") {
          if (current.audit?.status !== "closed") {
            throw new LoopError(
              "TRANSITION_INVALID",
              "transition",
              `Cannot advance from REALITY_CHECK to RELEASE_GATE: Stage 4 Adversarial Audit status must be 'closed' (current: '${current.audit?.status ?? "none"}'). Call audit_and_break_code_with_gpt first.`
            );
          }
        }

        targetPhase = requestedPhase;
      } else {
        throw new LoopError(
          "CONFIG_INVALID",
          "configuration",
          `Unknown action: '${String(command.action)}'`
        );
      }

      // 4. Delegate to LoopEngine
      const engine = new LoopEngine(
        {
          phases: this.phases,
          initialPhase: "INITIALIZE",
          terminalPhase: "COMPLETE",
          budget: current.budget,
          goldenSha256: current.goldenSha256,
          runId: current.runId
        },
        current
      );

      const triggerMsg = `${command.actor}: ${command.action}${
        command.reason ? ` (${command.reason.trim()})` : ""
      }`;

      return engine.transition(targetPhase, {
        triggeredBy: triggerMsg
      });
    });

    return {
      previousPhase: prevPhase,
      state: updatedState
    };
  }

  async blueprint(command: BlueprintMutationCommand): Promise<LoopState> {
    return this.store.update((current) => {
      if (current.runId !== command.runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${command.runId}'`
        );
      }
      if (current.currentPhase !== command.expectedPhase) {
        throw new LoopPhaseConflictError(command.expectedPhase, current.currentPhase);
      }
      assertRevisionMatches(command.expectedRevision, current.revision);

      const mut = command.mutation;
      let nextBlueprint: BlueprintRecord;
      const curBp = current.blueprint || {
        status: "pending",
        invocationKey: `${current.runId}:PLAN_ORACLE:v1`,
        invocationCount: 0,
        artifactPath: ".ai/blueprint.md",
        plannedTreeHash: current.goldenSha256,
        protectedEvalHash: current.goldenSha256
      };
      const nextRevision = current.revision + 1;

      if (mut.kind === "begin") {
        if (curBp.invocationCount >= 1) {
          throw new LoopError(
            "BUDGET_EXHAUSTED",
            "budget",
            `Stage 2 Plan Oracle invocation count already reached maximum of 1 for run '${current.runId}'`
          );
        }
        if (curBp.status !== "pending") {
          if (curBp.invocationKey === mut.invocationKey && curBp.status === "running") {
            return current;
          }
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot begin blueprint in status '${curBp.status}' (expected 'pending')`
          );
        }
        nextBlueprint = {
          ...curBp,
          status: "running",
          invocationKey: mut.invocationKey,
          invocationCount: 1,
          plannedTreeHash: mut.plannedTreeHash,
          protectedEvalHash: mut.protectedEvalHash
        };
      } else if (mut.kind === "complete") {
        if (curBp.status !== "running") {
          if (curBp.invocationKey === mut.invocationKey && curBp.status === "ready") {
            return current;
          }
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot complete blueprint when status is '${curBp.status}' (expected 'running')`
          );
        }
        if (curBp.invocationKey && mut.invocationKey !== curBp.invocationKey) {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Blueprint invocationKey mismatch: running '${curBp.invocationKey}', completing '${mut.invocationKey}'`
          );
        }
        if (!mut.goldenAssertions || mut.goldenAssertions.length < 3 || mut.goldenAssertions.length > 5) {
          throw new LoopError(
            "ASSERTION_SCHEMA_INVALID",
            "validation",
            `Blueprint goldenAssertions must contain 3-5 items, received ${mut.goldenAssertions?.length ?? 0}`
          );
        }
        nextBlueprint = {
          ...curBp,
          status: "ready",
          invocationKey: mut.invocationKey,
          artifactSha256: mut.artifactSha256,
          assertionsSha256: mut.assertionsSha256,
          goldenAssertions: [...mut.goldenAssertions],
          oracleReceiptSha256: mut.oracleReceiptSha256,
          completedAt: mut.completedAt
        };
      } else if (mut.kind === "fail") {
        nextBlueprint = {
          ...curBp,
          status: "failed",
          failureCode: mut.failureCode
        };
      } else {
        throw new LoopError(
          "CONFIG_INVALID",
          "configuration",
          `Unknown blueprint mutation kind: '${(mut as { kind: string }).kind}'`
        );
      }

      return {
        ...current,
        revision: nextRevision,
        blueprint: nextBlueprint
      };
    });
  }

  async audit(command: AuditMutationCommand): Promise<LoopState> {
    return this.store.update((current) => {
      if (current.runId !== command.runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${command.runId}'`
        );
      }
      if (current.currentPhase !== command.expectedPhase) {
        throw new LoopPhaseConflictError(command.expectedPhase, current.currentPhase);
      }
      assertRevisionMatches(command.expectedRevision, current.revision);

      const mut = command.mutation;
      let nextAudit: AuditRecord;
      const curAudit = current.audit || { status: "pending", remediationCount: 0 };
      const nextRevision = current.revision + 1;

      if (mut.kind === "begin") {
        if (curAudit.status !== "pending" && curAudit.status !== "closure_pending") {
          if (curAudit.invocationKey === mut.invocationKey && curAudit.status === "running") {
            return current;
          }
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot begin audit in status '${curAudit.status}' (expected 'pending' or 'closure_pending')`
          );
        }
        nextAudit = {
          ...curAudit,
          status: "running",
          invocationKey: mut.invocationKey,
          auditedTreeHash: mut.auditedTreeHash
        };
      } else if (mut.kind === "complete") {
        if (curAudit.status !== "running") {
          if (curAudit.invocationKey === mut.invocationKey && (curAudit.status === "accepted" || curAudit.status === "remediation_required")) {
            return current;
          }
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot complete audit when status is '${curAudit.status}' (expected 'running')`
          );
        }
        if (curAudit.invocationKey && mut.invocationKey !== curAudit.invocationKey) {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Audit invocationKey mismatch: running '${curAudit.invocationKey}', completing '${mut.invocationKey}'`
          );
        }
        const hasBlockers = mut.findings && mut.findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
        const status = hasBlockers ? "remediation_required" : "accepted";
        nextAudit = {
          ...curAudit,
          status,
          invocationKey: mut.invocationKey,
          findings: mut.findings,
          report: mut.report,
          completedAt: mut.completedAt
        };
      } else if (mut.kind === "begin_remediation") {
        if (curAudit.status !== "remediation_required") {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot begin remediation when audit status is '${curAudit.status}' (expected 'remediation_required')`
          );
        }
        if (curAudit.remediationCount >= 1) {
          throw new LoopError(
            "BUDGET_EXHAUSTED",
            "budget",
            "Quality remediation budget exhausted (maximum 1 remediation allowed)"
          );
        }
        nextAudit = {
          ...curAudit,
          status: "closure_pending",
          remediationCount: curAudit.remediationCount + 1
        };
      } else if (mut.kind === "close") {
        if (curAudit.status !== "accepted" && curAudit.status !== "closure_pending") {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot close audit when status is '${curAudit.status}' (expected 'accepted' or 'closure_pending')`
          );
        }
        nextAudit = {
          ...curAudit,
          status: "closed",
          report: mut.report ?? curAudit.report,
          completedAt: mut.completedAt
        };
      } else if (mut.kind === "fail") {
        if (curAudit.status === "closed" || curAudit.status === "failed") {
          throw new LoopError(
            "TRANSITION_INVALID",
            "transition",
            `Cannot fail audit when status is '${curAudit.status}'`
          );
        }
        nextAudit = {
          ...curAudit,
          status: "failed",
          report: mut.report,
          completedAt: mut.completedAt
        };
      } else {
        throw new LoopError("CONFIG_INVALID", "configuration", "Unknown audit mutation kind");
      }

      let nextUsage: ResourceUsage = current.resourceUsage
        ? { ...current.resourceUsage }
        : { ...EMPTY_RESOURCE_USAGE };
      if (mut.kind === "complete" && mut.telemetry) {
        nextUsage = {
          ...nextUsage,
          costMicroUsd: nextUsage.costMicroUsd + mut.telemetry.costMicroUsd,
          promptTokens: nextUsage.promptTokens + mut.telemetry.promptTokens,
          cachedTokens: nextUsage.cachedTokens + mut.telemetry.cachedTokens,
          reasoningTokens: nextUsage.reasoningTokens + mut.telemetry.reasoningTokens,
          completionTokens: nextUsage.completionTokens + mut.telemetry.completionTokens,
          totalTokens: nextUsage.totalTokens + mut.telemetry.totalTokens,
          oracleCalls: nextUsage.oracleCalls + 1
        };
      }

      return {
        ...current,
        revision: nextRevision,
        audit: nextAudit,
        resourceUsage: nextUsage
      };
    });
  }

  async recordUsage(command: UsageMutationCommand): Promise<LoopState> {
    return this.store.update((current) => {
      if (current.runId !== command.runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${command.runId}'`
        );
      }
      if (current.currentPhase !== command.expectedPhase) {
        throw new LoopPhaseConflictError(command.expectedPhase, current.currentPhase);
      }
      assertRevisionMatches(command.expectedRevision, current.revision);

      const cur = current.resourceUsage || {
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

      const tel = command.telemetry;
      const nextUsage = {
        ...cur,
        costMicroUsd: cur.costMicroUsd + (tel?.costMicroUsd ?? 0),
        promptTokens: cur.promptTokens + (tel?.promptTokens ?? 0),
        cachedTokens: cur.cachedTokens + (tel?.cachedTokens ?? 0),
        reasoningTokens: cur.reasoningTokens + (tel?.reasoningTokens ?? 0),
        completionTokens: cur.completionTokens + (tel?.completionTokens ?? 0),
        totalTokens: cur.totalTokens + (tel?.totalTokens ?? 0),
        oracleCalls: cur.oracleCalls + (tel ? 1 : 0),
        globalCycles: cur.globalCycles + (command.globalCycles ?? 0),
        verificationRetries: cur.verificationRetries + (command.verificationRetries ?? 0)
      };

      return {
        ...current,
        revision: current.revision + 1,
        resourceUsage: nextUsage
      };
    });
  }
}
