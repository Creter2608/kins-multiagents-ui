import * as fs from "node:fs";
import * as path from "node:path";
import { computePhaseStatuses, LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import type { LoopStateSnapshot, LoopResetResult } from "../../shared/contracts.js";

export function parseLoopStateJson(content: string): Partial<LoopStateSnapshot> {
  const parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("State root must be an object");
  }
  return parsed as Partial<LoopStateSnapshot>;
}

export class LoopStateService {
  private stateFilePath: string;
  private lastValidSnapshot: LoopStateSnapshot;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: LoopStateSnapshot) => void>();

  constructor(stateFilePath: string = path.resolve(".ai/state.json")) {
    this.stateFilePath = stateFilePath;
    const initialPhase = LOOP_PHASES[0];
    this.lastValidSnapshot = {
      runId: "init",
      schemaVersion: 1,
      currentPhase: initialPhase,
      status: "ready",
      usage: { transitions: 0, retries: 0, operations: 0 },
      budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
      phases: computePhaseStatuses(initialPhase),
      lastUpdated: Date.now()
    };
  }

  getSnapshot(): LoopStateSnapshot {
    return this.lastValidSnapshot;
  }

  /**
   * Reads and parses state.json.
   * Assertion 2: {"in":"state.json malformed mid-write","out":"retain last valid state; emit sync error"}
   */
  readState(): LoopStateSnapshot {
    if (!fs.existsSync(this.stateFilePath)) {
      return this.lastValidSnapshot;
    }

    try {
      const content = fs.readFileSync(this.stateFilePath, "utf-8");
      const parsed = parseLoopStateJson(content);

      if (!parsed.currentPhase || typeof parsed.currentPhase !== "string") {
        throw new Error("State missing valid currentPhase string");
      }

      const phaseStatuses = computePhaseStatuses(parsed.currentPhase);

      this.lastValidSnapshot = {
        runId: String(parsed.runId || this.lastValidSnapshot.runId),
        schemaVersion: Number(parsed.schemaVersion || 1),
        currentPhase: parsed.currentPhase,
        status: (parsed.status as LoopStateSnapshot["status"]) || "running",
        usage: {
          transitions: Number(parsed.usage?.transitions ?? this.lastValidSnapshot.usage.transitions),
          retries: Number(parsed.usage?.retries ?? this.lastValidSnapshot.usage.retries),
          operations: Number(parsed.usage?.operations ?? this.lastValidSnapshot.usage.operations)
        },
        budget: {
          maxTransitions: Number(parsed.budget?.maxTransitions ?? this.lastValidSnapshot.budget.maxTransitions),
          maxRetries: Number(parsed.budget?.maxRetries ?? this.lastValidSnapshot.budget.maxRetries),
          maxOperations: Number(parsed.budget?.maxOperations ?? this.lastValidSnapshot.budget.maxOperations)
        },
        phases: phaseStatuses,
        lastError: parsed.lastError,
        syncError: undefined,
        lastUpdated: Date.now()
      };
    } catch (err) {
      // Assertion 2: Retain last valid state and emit sync error
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        syncError: `Sync Error: ${err instanceof Error ? err.message : String(err)}`,
        lastUpdated: Date.now()
      };
    }

    for (const listener of this.listeners) {
      listener(this.lastValidSnapshot);
    }

    return this.lastValidSnapshot;
  }

  resetLoop(customRunId?: string): LoopResetResult {
    try {
      const initialPhase = LOOP_PHASES[0];
      const runId = customRunId || `run-${Date.now()}`;
      const freshState = {
        schemaVersion: 1,
        runId,
        currentPhase: initialPhase,
        status: "ready" as const,
        budget: {
          maxTransitions: 25,
          maxRetries: 2,
          maxOperations: 50
        },
        usage: {
          transitions: 0,
          retries: 0,
          operations: 0
        },
        history: []
      };

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write atomically via temp file
      const tempPath = `${this.stateFilePath}.tmp-${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(freshState, null, 2), "utf-8");
      fs.renameSync(tempPath, this.stateFilePath);

      // Immediately read back and emit to all listeners
      const state = this.readState();
      return {
        success: true,
        message: `Loop run ${runId} successfully initialized to ${initialPhase}`,
        state
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to reset loop: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  advanceToPhase(targetPhase: LoopPhase): boolean {
    const current = this.readState();
    if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
      return false;
    }

    const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
    const targetIdx = LOOP_PHASES.indexOf(targetPhase);

    if (targetIdx === -1 || currentIdx === -1) {
      return false;
    }

    // Do not regress to an earlier or equal phase
    if (targetIdx <= currentIdx) {
      return false;
    }

    // Sequentially advance through intermediate phases
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const nextPhase = LOOP_PHASES[i];
      if (!nextPhase) break;
      const ok = this.transitionPhase(nextPhase);
      if (!ok) return false;
    }

    return true;
  }

  transitionPhase(to: LoopPhase): boolean {
    try {
      const current = this.readState();
      if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
        return false;
      }
      if (current.currentPhase === to) {
        return true;
      }

      let stateData: any = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8"));
        } catch {
          stateData = {};
        }
      }

      const nextTransitions = (Number(stateData.usage?.transitions) || current.usage.transitions) + 1;
      const history = Array.isArray(stateData.history) ? [...stateData.history] : [];
      history.push({
        sequence: history.length + 1,
        from: current.currentPhase,
        to
      });

      const nextStatus: LoopStateSnapshot["status"] = to === "COMPLETE" ? "succeeded" : "running";

      const updatedState = {
        schemaVersion: 1,
        runId: stateData.runId || current.runId,
        currentPhase: to,
        status: nextStatus,
        budget: stateData.budget || current.budget,
        usage: {
          transitions: nextTransitions,
          retries: stateData.usage?.retries ?? current.usage.retries,
          operations: stateData.usage?.operations ?? current.usage.operations
        },
        history
      };

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.stateFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tempPath, JSON.stringify(updatedState, null, 2), "utf-8");
      fs.renameSync(tempPath, this.stateFilePath);

      this.readState();
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    void this.readState();

    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.includes("state.json")) {
          this.readState();
        }
      });
    } catch {
      // Fallback to polling if fs.watch fails
    }

    this.pollTimer = setInterval(() => {
      this.readState();
    }, 1500);
  }

  subscribe(listener: (snapshot: LoopStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.lastValidSnapshot);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}
