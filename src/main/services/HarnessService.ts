/**
 * src/main/services/HarnessService.ts
 * Manages SessionJournal durability, ExecutionGuard hygiene, and real-time event streaming for Cockpit UI.
 */

import { SessionJournal, type JournalEventInput } from "../harness/SessionJournal.js";
import { ExecutionGuard } from "../harness/ExecutionGuard.js";
import { ToolCallRecovery, type TerminalRecoveryStatus, type PendingToolCall } from "../harness/ToolCallRecovery.js";
import { sanitizePayload } from "../harness/HookBridge.js";
import { deriveMessages } from "../../shared/deriveMessages.js";
import { LocalSpillStore } from "../harness/SpillStore.js";
import type { SessionEvent, GuardDecision, ModelMessage, DeriveMessagesOptions } from "../../shared/harnessContracts.js";

export type HarnessEventSubscriber = (event: SessionEvent) => void;

export class HarnessService {
  private userDataPath: string;
  private currentRunId: string;
  private journal: SessionJournal;
  private readonly guard: ExecutionGuard;
  private readonly recovery: ToolCallRecovery;
  private readonly spillStore: LocalSpillStore;
  private readonly subscribers = new Set<HarnessEventSubscriber>();

  constructor(userDataPath: string, initialRunId: string = "default-run") {
    this.userDataPath = userDataPath;
    this.currentRunId = this.sanitizeRunId(initialRunId);
    this.journal = new SessionJournal(this.userDataPath, this.currentRunId);
    this.guard = new ExecutionGuard();
    this.recovery = new ToolCallRecovery();
    this.spillStore = new LocalSpillStore(this.userDataPath);
  }

  getSpillStore(): LocalSpillStore {
    return this.spillStore;
  }

  private sanitizeRunId(runId: string): string {
    const cleaned = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return cleaned || "default-run";
  }

  getRunId(): string {
    return this.currentRunId;
  }

  async switchRun(runId: string): Promise<void> {
    const safeRunId = this.sanitizeRunId(runId);
    if (safeRunId === this.currentRunId) {
      return;
    }
    try {
      await this.pendingOps;
    } catch {
      // Preserve cleanup and switch even if a prior write failed
    }
    await this.journal.close();
    this.currentRunId = safeRunId;
    this.journal = new SessionJournal(this.userDataPath, safeRunId);
    this.guard.reset();
    this.hasReplayedRecovery = false;
    this.replayPromise = null;
    this.pendingOps = Promise.resolve();
    this.recovery.reset();
  }

  private isDisposed: boolean = false;
  private hasReplayedRecovery: boolean = false;
  private replayPromise: Promise<void> | null = null;
  private pendingOps: Promise<unknown> = Promise.resolve();

  /**
   * Reads all journal events using pagination without hardcoded limits.
   */
  async readAllJournalEvents(chunkSize: number = 2000): Promise<readonly SessionEvent[]> {
    const allEvents: SessionEvent[] = [];
    let lastSeq = 0;
    while (true) {
      const chunk = await this.journal.readAfter(lastSeq, chunkSize);
      if (chunk.length === 0) break;
      for (const ev of chunk) {
        allEvents.push(ev);
        if (ev.sequence > lastSeq) {
          lastSeq = ev.sequence;
        }
      }
      if (chunk.length < chunkSize) break;
    }
    return Object.freeze(allEvents);
  }

  public async ensureRecoveryReplayed(): Promise<void> {
    if (this.hasReplayedRecovery) {
      return;
    }
    if (!this.replayPromise) {
      this.replayPromise = (async () => {
        try {
          const allEvents = await this.readAllJournalEvents();
          this.recovery.reset();
          for (const ev of allEvents) {
            this.recovery.observe(ev);
          }
          this.hasReplayedRecovery = true;
        } finally {
          this.replayPromise = null;
        }
      })();
    }
    await this.replayPromise;
  }

  async recordEvent(input: JournalEventInput): Promise<SessionEvent> {
    const op = (async () => {
      await this.ensureRecoveryReplayed();
      const sanitizedData = (sanitizePayload(input.data) as Record<string, unknown>) ?? {};
      const sanitizedInput: JournalEventInput = {
        source: input.source,
        kind: input.kind,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        data: sanitizedData
      };
      const event = await this.journal.append(sanitizedInput);
      this.recovery.observe(event);
      for (const sub of this.subscribers) {
        try {
          sub(event);
        } catch (err) {
          console.error("[HarnessService] Subscriber notification error:", err);
        }
      }
      return event;
    })();

    this.pendingOps = this.pendingOps.then(() => op, () => op);
    return await op;
  }

  async getEvents(limit: number = 200): Promise<readonly SessionEvent[]> {
    await this.pendingOps;
    return await this.journal.readAfter(0, limit);
  }

  async getDerivedMessages(options?: DeriveMessagesOptions): Promise<readonly ModelMessage[]> {
    await this.pendingOps;
    const events = await this.readAllJournalEvents();
    return deriveMessages(events, options);
  }

  async recoverPendingTools(
    status: TerminalRecoveryStatus = 'cancelled',
    reasonCode: string = 'SESSION_INTERRUPTED'
  ): Promise<readonly SessionEvent[]> {
    await this.ensureRecoveryReplayed();
    const syntheticInputs = this.recovery.recover(status, reasonCode);
    const recoveredEvents: SessionEvent[] = [];

    for (const input of syntheticInputs) {
      const callData = input.data as Record<string, unknown> | undefined;
      const callId = typeof callData?.toolCallId === 'string' ? callData.toolCallId : undefined;
      try {
        const event = await this.recordEvent(input);
        recoveredEvents.push(event);
      } catch (err) {
        if (callId) {
          this.recovery.releaseInFlight(callId);
        }
        throw err;
      }
    }
    return Object.freeze(recoveredEvents);
  }

  async getUnresolvedToolCalls(): Promise<readonly PendingToolCall[]> {
    await this.ensureRecoveryReplayed();
    return this.recovery.unresolved();
  }

  subscribe(listener: HarnessEventSubscriber): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  checkToolCall(tool: string, args?: Readonly<Record<string, unknown>>): GuardDecision {
    return this.guard.checkToolCall(tool, args ?? {});
  }

  recordToolDispatch(tool: string, args?: Readonly<Record<string, unknown>>): void {
    this.guard.recordToolDispatch(tool, args ?? {});
  }

  resetGuard(): void {
    this.guard.reset();
  }

  async flush(): Promise<void> {
    await this.pendingOps;
    await this.journal.flush();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    try {
      await this.pendingOps;
    } catch {
      // Preserve cleanup and file closure even if a prior write failed
    }
    this.subscribers.clear();
    await this.journal.close();
  }
}
