import * as fs from "node:fs";
import * as path from "node:path";
import type { CriticalLogEntry, CriticalLogSnapshot, LogSeverity } from "../../shared/contracts.js";

export function sanitizeLogLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // Detect permission-store diagnostics quoting command strings (e.g. permission_grant_store.go)
  // Example: ignoring invalid allow entry "command(node -e ... let errors = 0 ...)"
  if (/permission_grant_store\.go:\d+\]\s*ignoring invalid allow entry/i.test(trimmed)) {
    return null;
  }

  // Detect tool confirmation / input loop echoes
  if (/(?:tool_confirmation_manager\.go|input_loop\.go:\d+\]\s*Responding to tool confirmation)/i.test(trimmed)) {
    return null;
  }

  // Detect Antigravity tool-call / command-echo envelopes and quoted source code
  if (/(?:^run_command:\s*|^Executing tool\s+\w+|catch\s*\(\s*error\s*\)|git\s+grep\s+ERROR)/i.test(trimmed)) {
    return null;
  }

  // Detect Google glog diagnostic boilerplate: wrapped ("ERROR: logging before google.Init: [IWEF]...") or plain ([IWEF]\d{4}...)
  const glogMatch = /^(?:ERROR:\s*logging before google\.Init:\s*)?([IWEF]\d{4})\b/i.exec(trimmed);
  if (glogMatch && glogMatch[1]) {
    const marker = glogMatch[1].toUpperCase();
    if (marker.startsWith("I")) {
      return null;
    }
    // Suppress transient startup auth race conditions before keyring finishes loading
    if (/error getting token source:\s*You are not logged into Antigravity/i.test(trimmed)) {
      return null;
    }
    // Suppress benign background cache refreshes or admin notices
    if (/admin controls not applicable/i.test(trimmed) || /skipping empty or temp file/i.test(trimmed)) {
      return null;
    }
    if (marker.startsWith("W") || marker.startsWith("E") || marker.startsWith("F")) {
      return trimmed;
    }
  }

  // Suppress startup auth error even if prefix was stripped
  if (/error getting token source:\s*You are not logged into Antigravity/i.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function classifyLogLine(line: string): { severity: LogSeverity; source: CriticalLogEntry["source"] } | null {
  const sanitized = sanitizeLogLine(line);
  if (!sanitized) {
    return null;
  }

  const source: CriticalLogEntry["source"] = sanitized.includes("[ai-loop]") ? "ai-loop" : "cli";

  // 1. Check structured Google glog marker
  const glogMatch = /^(?:ERROR:\s*logging before google\.Init:\s*)?([IWEF]\d{4})\b/i.exec(sanitized);
  if (glogMatch && glogMatch[1]) {
    const marker = glogMatch[1].toUpperCase();
    if (marker.startsWith("I")) {
      return null;
    }
    if (marker.startsWith("W")) {
      return { severity: "WARNING", source };
    }
    if (marker.startsWith("E") || marker.startsWith("F")) {
      return { severity: "ERROR", source };
    }
  }

  // 2. Strip prefix if present without the [IWEF] marker so it doesn't falsely trigger the generic ERROR matcher
  const cleanLine = sanitized.replace(/^ERROR:\s*logging before google\.Init:\s*/i, "");

  // 3. High-confidence authentic errors from cli.log or AI Loop
  if (
    /\b(FATAL|panic|UncaughtException|AssertionError)\b/i.test(cleanLine) ||
    /\[ai-loop ERROR\]/i.test(cleanLine) ||
    /^npm ERR!/i.test(cleanLine) ||
    /^(?:\[ERROR\]|ERROR:)/i.test(cleanLine)
  ) {
    return { severity: "ERROR", source };
  }

  // 4. Structured Error patterns with word boundary
  if (/\b(ERROR|E\d{4})\b/.test(cleanLine)) {
    // Ensure this is not just an informational line that mentions error
    if (!/Starting language server|Language server listening/i.test(cleanLine)) {
      return { severity: "ERROR", source };
    }
  }

  // 5. Warnings
  if (/\b(WARNING|W\d{4})\b/.test(cleanLine) || /^(?:\[WARN(?:ING)?\]|WARN(?:ING)?:)/i.test(cleanLine)) {
    return { severity: "WARNING", source };
  }

  // 6. Milestones
  if (/\b(Transitioned to|Phase|Verified|COMPLETE|SPEC_GATE|VERIFY)\b/i.test(cleanLine)) {
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

  clearLogs(): void {
    this.entries = [];
    for (const listener of this.listeners) {
      listener(this.entries);
    }
  }

  start(): void {
    // If starting fresh on an existing log file, tail from EOF so past sessions don't flood the drawer
    if (this.lastOffset === 0 && fs.existsSync(this.logFilePath)) {
      try {
        const stat = fs.statSync(this.logFilePath);
        this.lastOffset = stat.size;
      } catch {
        // Fallback to offset 0
      }
    }

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
