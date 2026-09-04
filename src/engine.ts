import { LoopError } from "./errors.js";
import type { Sha256Hex } from "./checksum.js";

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

export interface LoopState {
  readonly schemaVersion: 1;
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
        history: Array.isArray(initialState.history) ? [...initialState.history] : []
      };
    } else {
      this.state = {
        schemaVersion: 1,
        runId: options.runId,
        currentPhase: options.initialPhase,
        status: "ready",
        goldenSha256: options.goldenSha256,
        budget: { ...options.budget },
        usage: { transitions: 0, retries: 0, operations: 0 },
        history: []
      };
    }
  }

  snapshot(): LoopState {
    return {
      ...this.state,
      budget: { ...this.state.budget },
      usage: { ...this.state.usage },
      history: [...this.state.history]
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

    this.state = {
      ...this.state,
      currentPhase: to,
      status: nextStatus,
      usage: nextUsage,
      history: Object.freeze(nextHistory)
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

  isTerminal(): boolean {
    return this.state.status === "succeeded" || this.state.status === "failed" || this.state.status === "blocked";
  }
}
