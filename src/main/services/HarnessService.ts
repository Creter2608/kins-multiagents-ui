/**
 * src/main/services/HarnessService.ts
 * Manages SessionJournal durability, ExecutionGuard hygiene, and real-time event streaming for Cockpit UI.
 */

import { SessionJournal, type JournalEventInput } from "../harness/SessionJournal.js";
import { ExecutionGuard } from "../harness/ExecutionGuard.js";
import { sanitizePayload } from "../harness/HookBridge.js";
import type { SessionEvent, GuardDecision } from "../../shared/harnessContracts.js";

export type HarnessEventSubscriber = (event: SessionEvent) => void;

export class HarnessService {
  private userDataPath: string;
  private currentRunId: string;
  private journal: SessionJournal;
  private readonly guard: ExecutionGuard;
  private readonly subscribers = new Set<HarnessEventSubscriber>();

  constructor(userDataPath: string, initialRunId: string = "default-run") {
    this.userDataPath = userDataPath;
    this.currentRunId = this.sanitizeRunId(initialRunId);
    this.journal = new SessionJournal(this.userDataPath, this.currentRunId);
    this.guard = new ExecutionGuard();
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
    await this.journal.close();
    this.currentRunId = safeRunId;
    this.journal = new SessionJournal(this.userDataPath, safeRunId);
    this.guard.reset();
  }

  private isDisposed = false;

  async recordEvent(input: JournalEventInput): Promise<SessionEvent> {
    const sanitizedData = (sanitizePayload(input.data) as Record<string, unknown>) ?? {};
    const sanitizedInput: JournalEventInput = {
      source: input.source,
      kind: input.kind,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      data: sanitizedData
    };
    const event = await this.journal.append(sanitizedInput);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        console.error("[HarnessService] Subscriber notification error:", err);
      }
    }
    return event;
  }

  async getEvents(limit: number = 200): Promise<readonly SessionEvent[]> {
    return await this.journal.readAfter(0, limit);
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
    await this.journal.flush();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.subscribers.clear();
    await this.journal.close();
  }
}
