import type { PhaseId, LoopState } from "../engine.js";
import {
  LoopCommandService,
  LoopPhaseConflictError,
  type LoopTransitionAction
} from "./LoopCommandService.js";
import { LoopError } from "../errors.js";

export interface AgentLoopStatusInput {
  readonly runId?: string | undefined;
}

export interface AgentLoopStatusSuccess {
  readonly ok: true;
  readonly state: LoopState;
}

export interface AgentLoopStatusError {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type AgentLoopStatusResult =
  | AgentLoopStatusSuccess
  | AgentLoopStatusError;

export interface AgentLoopTransitionInput {
  readonly runId: string;
  readonly expectedPhase: PhaseId;
  readonly action: LoopTransitionAction;
  readonly targetPhase?: PhaseId | undefined;
  readonly reason?: string | undefined;
}

export interface AgentLoopTransitionSuccess {
  readonly ok: true;
  readonly previousPhase: PhaseId;
  readonly state: LoopState;
}

export interface AgentLoopTransitionConflict {
  readonly ok: false;
  readonly error: {
    readonly code: "PHASE_CONFLICT" | "INVALID_ACTION" | "RUN_ID_MISMATCH" | string;
    readonly message: string;
    readonly expectedPhase?: string;
    readonly actualPhase?: string;
  };
}

export type AgentLoopTransitionResult =
  | AgentLoopTransitionSuccess
  | AgentLoopTransitionConflict;

export async function handleAgentLoopStatus(
  commands: LoopCommandService,
  input?: AgentLoopStatusInput
): Promise<AgentLoopStatusResult> {
  try {
    const state = await commands.status();
    if (input?.runId && state.runId !== input.runId) {
      return {
        ok: false,
        error: {
          code: "RUN_ID_MISMATCH",
          message: `Run ID mismatch: expected '${input.runId}', but active state has '${state.runId}'`
        }
      };
    }
    return { ok: true, state };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof LoopError ? err.code : "EXECUTION_FAILED";
    return {
      ok: false,
      error: { code, message }
    };
  }
}

export async function handleAgentLoopTransition(
  commands: LoopCommandService,
  input: AgentLoopTransitionInput
): Promise<AgentLoopTransitionResult> {
  try {
    if (!input || typeof input !== "object") {
      return {
        ok: false,
        error: {
          code: "CONFIG_INVALID",
          message: "Transition input must be an object"
        }
      };
    }

    if (!input.runId || typeof input.runId !== "string") {
      return {
        ok: false,
        error: {
          code: "RUN_ID_MISMATCH",
          message: "A valid runId is required for transition"
        }
      };
    }

    if (!input.expectedPhase || typeof input.expectedPhase !== "string") {
      return {
        ok: false,
        error: {
          code: "INVALID_ACTION",
          message: "expectedPhase is required for transition"
        }
      };
    }

    if (
      input.action !== "advance" &&
      input.action !== "approve" &&
      input.action !== "reject"
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_ACTION",
          message: `Invalid action: '${String(input.action)}'. Allowed: advance, approve, reject`
        }
      };
    }

    const res = await commands.transition({
      runId: input.runId,
      expectedPhase: input.expectedPhase,
      action: input.action,
      targetPhase: input.targetPhase,
      reason: input.reason,
      actor: "agent"
    });

    return {
      ok: true,
      previousPhase: res.previousPhase,
      state: res.state
    };
  } catch (err: unknown) {
    if (err instanceof LoopPhaseConflictError) {
      return {
        ok: false,
        error: {
          code: "PHASE_CONFLICT",
          message: err.message,
          expectedPhase: err.expectedPhase,
          actualPhase: err.actualPhase
        }
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof LoopError ? err.code : "EXECUTION_FAILED";

    return {
      ok: false,
      error: {
        code,
        message
      }
    };
  }
}
