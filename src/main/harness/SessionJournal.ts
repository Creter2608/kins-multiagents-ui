/**
 * src/main/harness/SessionJournal.ts
 * Append-only durable event log inspired by DeepSeek Harness SessionEvent log.
 * Provides monotonic sequence ordering, single-writer safety, and corruption-aware crash recovery.
 */

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import type { SessionEvent } from '../../shared/harnessContracts.js';

export interface JournalEventInput {
  readonly source: SessionEvent['source'];
  readonly kind: string;
  readonly stepId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class SessionJournal {
  readonly runId: string;
  readonly journalPath: string;
  private currentSequence: number = 0;
  private isClosed: boolean = false;
  private appendLock: Promise<void> = Promise.resolve();

  constructor(userDataRoot: string, runId: string) {
    if (!runId || typeof runId !== 'string' || runId.includes('..') || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new Error(`Invalid runId '${runId}'. Must be alphanumeric without path traversal.`);
    }
    this.runId = runId;
    const runDir = path.resolve(userDataRoot, 'runs', runId);
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
    this.journalPath = path.join(runDir, 'journal.jsonl');

    // Initialize sequence counter if journal exists
    if (fs.existsSync(this.journalPath)) {
      this.currentSequence = this.recoverLastSequence();
    }
  }

  /**
   * Scans existing journal to find highest sequence number, ignoring an incomplete last line.
   * Throws if earlier complete lines are corrupted JSON.
   */
  private recoverLastSequence(): number {
    const content = fs.readFileSync(this.journalPath, 'utf-8');
    const lines = content.split('\n');
    let maxSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as SessionEvent;
        if (typeof parsed.sequence === 'number') {
          if (parsed.sequence !== maxSeq + 1 && maxSeq !== 0) {
            // Sequence gap or out-of-order sequence detected
            throw new Error(`JOURNAL_CORRUPTION_DETECTED: Non-monotonic sequence at line ${i + 1}`);
          }
          maxSeq = parsed.sequence;
        }
      } catch (err: unknown) {
        // If this is the very last line, it might be an incomplete write from a crash
        if (i === lines.length - 1) {
          // Trailing truncated line is tolerated during recovery
          break;
        }
        throw new Error(
          `JOURNAL_CORRUPTION_DETECTED: Invalid record at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return maxSeq;
  }

  /**
   * Appends an event to the journal with guaranteed serialized execution and monotonic sequence.
   */
  async append(eventData: JournalEventInput): Promise<SessionEvent> {
    if (this.isClosed) {
      throw new Error('SessionJournal is closed.');
    }

    return new Promise<SessionEvent>((resolve, reject) => {
      this.appendLock = this.appendLock.then(async () => {
        try {
          this.currentSequence++;
          const event: SessionEvent = {
            schemaVersion: 1,
            runId: this.runId,
            sequence: this.currentSequence,
            timestamp: new Date().toISOString(),
            source: eventData.source,
            kind: eventData.kind,
            ...(eventData.stepId ? { stepId: eventData.stepId } : {}),
            data: eventData.data
          };

          const line = JSON.stringify(event) + '\n';
          await fs.promises.appendFile(this.journalPath, line, 'utf-8');
          resolve(event);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Reads events after a given sequence number up to limit.
   */
  async readAfter(afterSequence: number = 0, limit: number = 100): Promise<readonly SessionEvent[]> {
    await this.appendLock;
    if (!fs.existsSync(this.journalPath)) {
      return [];
    }

    const events: SessionEvent[] = [];
    const fileStream = fs.createReadStream(this.journalPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as SessionEvent;
        if (parsed.sequence > afterSequence) {
          events.push(parsed);
          if (events.length >= limit) {
            break;
          }
        }
      } catch {
        // Stop if hit corrupt line
        break;
      }
    }

    return events;
  }

  /**
   * Replays the log to inspect if any dispatch was left uncompleted before a crash.
   */
  async inspectCrashStatus(): Promise<{ hasDanglingDispatch: boolean; lastIntentStepId?: string }> {
    const events = await this.readAfter(0, 10000);
    const dispatched = new Set<string>();
    const finished = new Set<string>();

    for (const ev of events) {
      if (ev.kind === 'tool_dispatch' && ev.stepId) {
        dispatched.add(ev.stepId);
      } else if ((ev.kind === 'tool_result' || ev.kind === 'tool_blocked') && ev.stepId) {
        finished.add(ev.stepId);
      }
    }

    for (const id of dispatched) {
      if (!finished.has(id)) {
        return { hasDanglingDispatch: true, lastIntentStepId: id };
      }
    }

    return { hasDanglingDispatch: false };
  }

  async flush(): Promise<void> {
    await this.appendLock;
  }

  async close(): Promise<void> {
    await this.appendLock;
    this.isClosed = true;
  }
}
