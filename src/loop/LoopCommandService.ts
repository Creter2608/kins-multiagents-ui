import { LoopError } from "../errors.js";
import {
  LoopEngine,
  type PhaseId,
  type PhaseDefinition,
  type LoopState
} from "../engine.js";
import type { LoopStateStore } from "./LoopStateStore.js";

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
  readonly action: LoopTransitionAction;
  readonly targetPhase?: PhaseId | undefined;
  readonly reason?: string | undefined;
  readonly actor: "agent" | "human" | "system";
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

export class LoopCommandService {
  constructor(
    private readonly store: LoopStateStore,
    private readonly phases: readonly PhaseDefinition[] = CANONICAL_PHASES
  ) {}

  async status(): Promise<LoopState> {
    return this.store.read();
  }

  async transition(
    command: LoopTransitionCommand
  ): Promise<LoopTransitionResult> {
    let prevPhase: PhaseId = command.expectedPhase;
    const updatedState = await this.store.update((current) => {
      // 1. Validate runId
      if (current.runId !== command.runId) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Run ID mismatch: expected '${current.runId}', received '${command.runId}'`
        );
      }

      // 2. Validate expectedPhase (Optimistic Concurrency)
      if (current.currentPhase !== command.expectedPhase) {
        throw new LoopPhaseConflictError(
          command.expectedPhase,
          current.currentPhase
        );
      }

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

        if (command.targetPhase) {
          targetPhase = command.targetPhase;
        } else {
          const defaultNext = CANONICAL_ADVANCEMENT[current.currentPhase];
          if (!defaultNext) {
            throw new LoopError(
              "TRANSITION_INVALID",
              "transition",
              `No canonical default advancement defined from phase '${current.currentPhase}'`
            );
          }
          targetPhase = defaultNext;
        }
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
}
