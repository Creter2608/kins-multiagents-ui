import * as fs from "node:fs";
import * as path from "node:path";
import type { CriticalLogEntry, CriticalLogSnapshot, LogSeverity } from "../../shared/contracts.js";

export function classifyLogLine(line: string): { severity: LogSeverity; source: CriticalLogEntry["source"] } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // Regex patterns for logs from cli.log or AI Loop
  if (/\b(ERROR|E\d{4}|FATAL|panic:|Exception)\b/i.test(trimmed) || /Failed to/i.test(trimmed)) {
    return { severity: "ERROR", source: trimmed.includes("[ai-loop]") ? "ai-loop" : "cli" };
  }
  if (/\b(WARNING|W\d{4}|WARN)\b/i.test(trimmed)) {
    return { severity: "WARNING", source: trimmed.includes("[ai-loop]") ? "ai-loop" : "cli" };
  }
  if (/\b(Transitioned to|Phase|Verified|COMPLETE|SPEC_GATE|VERIFY)\b/i.test(trimmed)) {
    return { severity: "MILESTONE", source: "ai-loop" };
  }

  return null;
}

export class CriticalLogService {
  private logFilePath: string;
  private lastOffset: number = 0;
  private incompleteLine: string = "";
  private entries: CriticalLogEntry[] = [];
  private maxEntries: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private listeners = new Set<(entries: readonly CriticalLogEntry[]) => void>();

  constructor(
    logFilePath: string = path.join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".gemini",
      "antigravity-cli",
      "cli.log"
    ),
    maxEntries: number = 500
  ) {
    this.logFilePath = logFilePath;
    this.maxEntries = maxEntries;
  }

  getSnapshot(): CriticalLogSnapshot {
    return {
      entries: [...this.entries],
      lastUpdated: Date.now()
    };
  }

  /**
   * Process incoming raw chunks and updates offset.
   * Assertion 4: {"in":"log truncated below offset","out":"reset offset; no crash or duplicate stale lines"}
   */
  processFile(): readonly CriticalLogEntry[] {
    if (!fs.existsSync(this.logFilePath)) {
      return [];
    }

    try {
      const stat = fs.statSync(this.logFilePath);
      // Assertion 4: Detect truncation / rotation
      if (stat.size < this.lastOffset) {
        this.lastOffset = 0;
        this.incompleteLine = "";
      }

      if (stat.size === this.lastOffset) {
        return [];
      }

      const bytesToRead = stat.size - this.lastOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.logFilePath, "r");
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, this.lastOffset);
      } finally {
        fs.closeSync(fd);
      }

      this.lastOffset = stat.size;

      const rawText = this.incompleteLine + buffer.toString("utf-8");
      const lines = rawText.split(/\r?\n/);
      // Save last unfinished line segment
      this.incompleteLine = lines.pop() ?? "";

      const newEntries: CriticalLogEntry[] = [];
      for (const line of lines) {
        const classification = classifyLogLine(line);
        if (classification) {
          const entry: CriticalLogEntry = {
            id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: Date.now(),
            source: classification.source,
            severity: classification.severity,
            message: line.trim()
          };
          newEntries.push(entry);
          this.entries.push(entry);
        }
      }

      if (this.entries.length > this.maxEntries) {
        this.entries = this.entries.slice(this.entries.length - this.maxEntries);
      }

      if (newEntries.length > 0) {
        for (const listener of this.listeners) {
          listener(this.entries);
        }
      }

      return newEntries;
    } catch {
      return [];
    }
  }

  addManualEntry(entry: Omit<CriticalLogEntry, "id" | "timestamp">): void {
    const fullEntry: CriticalLogEntry = {
      ...entry,
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now()
    };
    this.entries.push(fullEntry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
    for (const listener of this.listeners) {
      listener(this.entries);
    }
  }

  start(): void {
    this.processFile();

    const dir = path.dirname(this.logFilePath);
    if (fs.existsSync(dir)) {
      try {
        this.watcher = fs.watch(dir, (_event, filename) => {
          if (filename && filename.includes("cli.log")) {
            this.processFile();
          }
        });
      } catch {
        // Fallback to polling
      }
    }

    this.pollTimer = setInterval(() => {
      this.processFile();
    }, 1500);
  }

  subscribe(listener: (entries: readonly CriticalLogEntry[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.entries);
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
