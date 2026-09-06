import type {
  SubagentActivity,
  SubagentInvocationInput,
  SubagentStatusUpdate,
  SubagentStatus
} from "../../shared/contracts.js";

export type SubagentListener = (activities: SubagentActivity[]) => void;

interface StoredSubagent {
  id: string;
  role: string;
  model: string;
  promptSummary: string;
  fullPrompt?: string | undefined;
  status: SubagentStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
  errorMessage?: string | undefined;
}

function normalizePromptSummary(prompt?: string): string {
  if (!prompt || typeof prompt !== "string") {
    return "";
  }
  return prompt.trim().replace(/\s+/g, " ").slice(0, 120);
}

export class SubagentService {
  private readonly now: () => number;
  private readonly order: string[] = []; // newest first
  private readonly records = new Map<string, StoredSubagent>();
  private readonly aliases = new Map<string, string>(); // alias -> canonicalId
  private readonly listeners = new Set<SubagentListener>();

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  private resolveCanonicalId(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  recordInvocation(input: SubagentInvocationInput): SubagentActivity {
    const canonicalId = this.resolveCanonicalId(input.id);
    const existing = this.records.get(canonicalId);
    const currentTime = this.now();

    if (existing) {
      // Idempotent: do not reset startedAt or regress terminal state
      if (existing.status === "completed" || existing.status === "error") {
        return this.toActivity(existing);
      }
      // Update metadata if provided and was missing or default
      if (input.role && existing.role === "unknown") {
        existing.role = input.role.trim() || "unknown";
      }
      if (input.model && existing.model === "unknown") {
        existing.model = input.model.trim() || "unknown";
      }
      if (input.prompt && !existing.fullPrompt) {
        existing.fullPrompt = input.prompt.trim();
      }
      if (input.prompt && !existing.promptSummary) {
        existing.promptSummary = normalizePromptSummary(input.prompt);
      }
      existing.updatedAt = currentTime;
      this.notify();
      return this.toActivity(existing);
    }

    const startedAt = typeof input.startedAt === "number" && input.startedAt > 0
      ? input.startedAt
      : currentTime;

    const rawPrompt = typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : undefined;

    const stored: StoredSubagent = {
      id: input.id,
      role: input.role?.trim() || "unknown",
      model: input.model?.trim() || "unknown",
      promptSummary: normalizePromptSummary(input.prompt),
      fullPrompt: rawPrompt,
      status: "running",
      startedAt,
      updatedAt: startedAt
    };

    this.records.set(input.id, stored);
    this.order.unshift(input.id); // Newest first
    this.notify();
    return this.toActivity(stored);
  }

  bindConversationId(subagentId: string, conversationId: string): void {
    if (!subagentId || !conversationId || subagentId === conversationId) return;
    const canonicalId = this.resolveCanonicalId(subagentId);
    const record = this.records.get(canonicalId);
    if (!record) return;
    this.aliases.set(conversationId, canonicalId);
  }

  markCompletedByConversationId(conversationId: string, timestamp?: number): void {
    const canonicalId = this.resolveCanonicalId(conversationId);
    this.updateStatus({ id: canonicalId, status: "completed", timestamp });
  }

  markIdleByConversationId(conversationId: string, timestamp?: number): void {
    const canonicalId = this.resolveCanonicalId(conversationId);
    this.updateStatus({ id: canonicalId, status: "idle", timestamp });
  }

  markAllCompleted(timestamp?: number): void {
    const effectiveTime = timestamp ?? this.now();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.status === "running" || record.status === "idle") {
        record.status = "completed";
        record.updatedAt = effectiveTime;
        record.completedAt = effectiveTime;
        record.errorMessage = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.notify();
    }
  }

  updateStatus(update: SubagentStatusUpdate): SubagentActivity | undefined {
    const canonicalId = this.resolveCanonicalId(update.id);
    const record = this.records.get(canonicalId);
    if (!record) {
      return undefined;
    }

    // Terminal state protection: completed and error cannot regress
    if (record.status === "completed" || record.status === "error") {
      return this.toActivity(record);
    }

    const timestamp = typeof update.timestamp === "number" && update.timestamp > 0
      ? update.timestamp
      : this.now();

    record.status = update.status;
    record.updatedAt = timestamp;

    if (update.status === "completed" || update.status === "error") {
      record.completedAt = timestamp;
    }

    if (update.status === "error") {
      record.errorMessage = update.errorMessage?.trim() || "Unspecified subagent error";
    } else {
      record.errorMessage = undefined;
    }

    this.notify();
    return this.toActivity(record);
  }

  list(): SubagentActivity[] {
    const result: SubagentActivity[] = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record) {
        result.push(this.toActivity(record));
      }
    }
    return result;
  }

  reset(): void {
    this.records.clear();
    this.aliases.clear();
    this.order.length = 0;
    this.notify();
  }

  subscribe(listener: SubagentListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (!unsubscribed) {
        unsubscribed = true;
        this.listeners.delete(listener);
      }
    };
  }

  private toActivity(record: StoredSubagent): SubagentActivity {
    const currentTime = this.now();
    const effectiveEnd = record.completedAt ?? currentTime;
    const elapsedMs = Math.max(0, effectiveEnd - record.startedAt);

    return {
      id: record.id,
      role: record.role,
      model: record.model,
      promptSummary: record.promptSummary,
      fullPrompt: record.fullPrompt,
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      elapsedMs,
      errorMessage: record.errorMessage
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[SubagentService] Listener error:", err);
      }
    }
  }
}
