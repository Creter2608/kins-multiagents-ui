import * as fs from "node:fs";
import * as path from "node:path";
import { computePhaseStatuses, LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import type {
  LoopStateSnapshot,
  LoopResetResult,
  LoopHistoryEntry,
  RollbackResult,
  StepForwardResult,
  LoopTestSummary,
  LoopTestStatus
} from "../../shared/contracts.js";

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
      history: [],
      testSummary: {
        status: "idle",
        passCount: 0,
        failCount: 0,
        lastRunAt: null
      },
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

      // Safe normalization for legacy snapshots without metadata
      const rawHistory = Array.isArray((parsed as Record<string, unknown>).history)
        ? ((parsed as Record<string, unknown>).history as Array<Record<string, unknown>>)
        : [];
      const history: LoopHistoryEntry[] = rawHistory.map((h, idx) => ({
        sequence: typeof h.sequence === "number" ? h.sequence : idx + 1,
        from: String(h.from || "UNKNOWN"),
        to: String(h.to || "UNKNOWN"),
        triggeredBy: typeof h.triggeredBy === "string" ? h.triggeredBy : "Unknown trigger",
        timestamp: typeof h.timestamp === "number" ? h.timestamp : Date.now(),
        autoAdvanced: Boolean(h.autoAdvanced)
      }));

      const rawTest = (parsed as Record<string, unknown>).testSummary as Record<string, unknown> | undefined;
      const testSummary: LoopTestSummary = rawTest
        ? {
            status: (rawTest.status as LoopTestStatus) || "idle",
            passCount: Number(rawTest.passCount) || 0,
            failCount: Number(rawTest.failCount) || 0,
            lastRunAt: typeof rawTest.lastRunAt === "string" ? rawTest.lastRunAt : null
          }
        : (this.lastValidSnapshot.testSummary || {
            status: "idle",
            passCount: 0,
            failCount: 0,
            lastRunAt: null
          });

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
        history,
        testSummary,
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

  updateTestSummary(summary: LoopTestSummary): void {
    try {
      this.readState();
      let stateData: Record<string, unknown> = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          stateData = {};
        }
      }

      const updatedState = {
        runId: this.lastValidSnapshot.runId,
        schemaVersion: this.lastValidSnapshot.schemaVersion,
        currentPhase: this.lastValidSnapshot.currentPhase,
        status: this.lastValidSnapshot.status,
        usage: this.lastValidSnapshot.usage,
        budget: this.lastValidSnapshot.budget,
        ...stateData,
        testSummary: summary
      };

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.stateFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tempPath, JSON.stringify(updatedState, null, 2), "utf-8");
      fs.renameSync(tempPath, this.stateFilePath);

      this.readState();
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    } catch {
      // Retain in memory if write fails
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        testSummary: summary,
        lastUpdated: Date.now()
      };
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    }
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
        history: [],
        testSummary: {
          status: "idle" as const,
          passCount: 0,
          failCount: 0,
          lastRunAt: null
        }
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

  advanceToPhase(targetPhase: LoopPhase, evidence?: string): boolean {
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

    // Sequentially advance through intermediate phases with metadata
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const nextPhase = LOOP_PHASES[i];
      if (!nextPhase) break;
      const isTarget = i === targetIdx;
      const ok = this.transitionPhase(nextPhase, {
        triggeredBy: isTarget
          ? (evidence || "Auto-detected")
          : (evidence ? `Auto-advance to ${nextPhase} (${evidence})` : `Auto-advance to ${nextPhase}`),
        autoAdvanced: !isTarget,
        timestamp: Date.now()
      });
      if (!ok) return false;
    }

    return true;
  }

  transitionPhase(
    to: LoopPhase,
    metadata?: { triggeredBy?: string | undefined; autoAdvanced?: boolean | undefined; timestamp?: number | undefined }
  ): boolean {
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
      const entryTimestamp = metadata?.timestamp ?? Date.now();
      const triggeredBy = metadata?.triggeredBy || "Manual transition";
      const autoAdvanced = Boolean(metadata?.autoAdvanced);

      history.push({
        sequence: history.length + 1,
        from: current.currentPhase,
        to,
        triggeredBy,
        timestamp: entryTimestamp,
        autoAdvanced
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

  stepForward(): StepForwardResult {
    const current = this.readState();
    if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
      return { success: false, message: `Cannot step forward while in terminal status '${current.status}'` };
    }
    const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
    if (currentIdx === -1 || currentIdx >= LOOP_PHASES.length - 1) {
      return { success: false, message: `Already at final canonical phase ${current.currentPhase}` };
    }
    const nextPhase = LOOP_PHASES[currentIdx + 1];
    if (!nextPhase) {
      return { success: false, message: "No next phase available" };
    }
    const ok = this.transitionPhase(nextPhase, {
      triggeredBy: "Manual step forward",
      autoAdvanced: false,
      timestamp: Date.now()
    });
    if (ok) {
      return { success: true, message: `Stepped forward to ${nextPhase}`, state: this.readState() };
    }
    return { success: false, message: `Failed to transition to ${nextPhase}` };
  }

  stepBack(): RollbackResult {
    const current = this.readState();
    const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
    if (currentIdx <= 0) {
      return {
        success: false,
        message: `Cannot step back from initial phase ${current.currentPhase}`
      };
    }

    const prevPhase = LOOP_PHASES[currentIdx - 1];
    if (!prevPhase) {
      return { success: false, message: "No prior phase available" };
    }

    const ok = this.transitionPhase(prevPhase, {
      triggeredBy: "Manual step back",
      autoAdvanced: false,
      timestamp: Date.now()
    });

    if (ok) {
      return {
        success: true,
        message: `Stepped back to ${prevPhase}`,
        previousPhase: current.currentPhase,
        currentPhase: prevPhase
      };
    }

    return {
      success: false,
      message: `Failed to step back to ${prevPhase}`
    };
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
