/**
 * src/main/services/EvalHarnessService.ts
 * Manages persisted evaluation reports, filesystem watching, and benchmark execution.
 */

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalHarnessSnapshot, EvalHarnessStatus } from "../../shared/contracts.js";
import type { EvaluationReport } from "../../shared/harness.js";

const DEFAULT_SNAPSHOT: EvalHarnessSnapshot = {
  status: "idle",
  report: null,
  updatedAt: null,
  error: null
};

export class EvalHarnessService {
  private projectRoot: string;
  private appRootOverride?: string | undefined;
  private reportPath: string;
  private runnerPath: string;
  private snapshot: EvalHarnessSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners = new Set<(snapshot: EvalHarnessSnapshot) => void>();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlightBenchmark: Promise<EvalHarnessSnapshot> | null = null;

  constructor(projectRoot: string, appRoot?: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.appRootOverride = appRoot ? path.resolve(appRoot) : undefined;
    this.reportPath = path.resolve(this.projectRoot, ".ai", "reports", "eval-report.json");
    this.runnerPath = path.resolve(this.projectRoot, "scripts", "harness", "runner.mjs");
  }

  setAppRootForTesting(root: string): void {
    this.appRootOverride = path.resolve(root);
  }

  resolveDefaultAppRoot(): string {
    if (this.appRootOverride) {
      return this.appRootOverride;
    }
    let curr = path.dirname(fileURLToPath(import.meta.url));
    while (curr !== path.dirname(curr)) {
      if (fs.existsSync(path.join(curr, "scripts", "harness", "runner.mjs"))) {
        return curr;
      }
      curr = path.dirname(curr);
    }
    return process.cwd();
  }

  resolveRunnerPath(): string | null {
    const localRunner = path.resolve(this.projectRoot, "scripts", "harness", "runner.mjs");
    if (fs.existsSync(localRunner)) {
      return localRunner;
    }
    const appRoot = this.resolveDefaultAppRoot();
    const appRunner = path.resolve(appRoot, "scripts", "harness", "runner.mjs");
    if (fs.existsSync(appRunner)) {
      return appRunner;
    }
    return null;
  }

  getSnapshot(): EvalHarnessSnapshot {
    return { ...this.snapshot };
  }

  async start(): Promise<void> {
    this.readReport();
    this.startWatching();
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.projectRoot = path.resolve(projectPath);
    this.reportPath = path.resolve(this.projectRoot, ".ai", "reports", "eval-report.json");
    this.runnerPath = path.resolve(this.projectRoot, "scripts", "harness", "runner.mjs");
    this.snapshot = { ...DEFAULT_SNAPSHOT };
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.readReport();
    this.startWatching();
    this.emit(this.snapshot);
  }

  onSnapshot(listener: (snapshot: EvalHarnessSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(newSnapshot: EvalHarnessSnapshot): void {
    this.snapshot = { ...newSnapshot };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch (err) {
        console.error("[EvalHarnessService] Listener error:", err);
      }
    }
  }

  readReport(): void {
    if (!fs.existsSync(this.reportPath)) {
      if (this.snapshot.status !== "idle" && !this.snapshot.report) {
        this.emit({ ...DEFAULT_SNAPSHOT });
      }
      return;
    }

    try {
      const content = fs.readFileSync(this.reportPath, "utf-8");
      const parsed = JSON.parse(content) as unknown;

      if (!this.isValidReport(parsed)) {
        throw new Error("Report failed schema validation (missing required fields or invalid metrics).");
      }

      this.emit({
        status: "ready",
        report: parsed,
        updatedAt: new Date().toISOString(),
        error: null
      });
    } catch (err) {
      // Preserve prior valid report on malformed write
      this.emit({
        status: "malformed",
        report: this.snapshot.report,
        updatedAt: this.snapshot.updatedAt,
        error: `Malformed report JSON: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  private isValidReport(val: unknown): val is EvaluationReport {
    if (!val || typeof val !== "object" || Array.isArray(val)) return false;
    const r = val as Record<string, unknown>;
    if (r.schemaVersion !== 1) return false;
    if (typeof r.baseCommit !== "string") return false;
    if (typeof r.passed !== "boolean") return false;
    if (!r.metrics || typeof r.metrics !== "object") return false;
    const m = r.metrics as Record<string, unknown>;
    if (typeof m.passAt1 !== "number" || typeof m.ssi !== "number") return false;
    if (!Array.isArray(r.results)) return false;
    return true;
  }

  private startWatching(): void {
    const reportsDir = path.dirname(this.reportPath);
    if (!fs.existsSync(reportsDir)) {
      try {
        fs.mkdirSync(reportsDir, { recursive: true });
      } catch {
        return;
      }
    }

    try {
      this.watcher = fs.watch(reportsDir, (_event, filename) => {
        if (!filename || filename === path.basename(this.reportPath)) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.readReport();
          }, 100);
        }
      });
    } catch (err) {
      console.warn("[EvalHarnessService] Could not establish fs.watch on reportsDir:", err);
    }
  }

  async runBenchmark(customBaseCommit?: string): Promise<EvalHarnessSnapshot> {
    if (this.inFlightBenchmark) {
      return this.inFlightBenchmark;
    }

    this.inFlightBenchmark = this.executeBenchmark(customBaseCommit);
    try {
      return await this.inFlightBenchmark;
    } finally {
      this.inFlightBenchmark = null;
    }
  }

  private async executeBenchmark(customBaseCommit?: string): Promise<EvalHarnessSnapshot> {
    // Determine base commit: default to HEAD so working-tree evaluation only inspects
    // uncommitted changes, unless an explicit customBaseCommit is provided.
    const rawBase =
      typeof customBaseCommit === "string" && customBaseCommit.trim().length > 0
        ? customBaseCommit.trim()
        : "HEAD";

    let baseCommit = "HEAD";
    try {
      baseCommit = execFileSync("git", ["rev-parse", rawBase], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
    } catch {
      baseCommit = rawBase;
    }

    const runnerPath = this.resolveRunnerPath();
    if (!runnerPath) {
      const errMsg = `Harness runner script not found at ${this.runnerPath} or application root`;
      this.emit({
        status: "failed",
        report: this.snapshot.report,
        updatedAt: new Date().toISOString(),
        error: errMsg
      });
      throw new Error(errMsg);
    }

    // If external project lacks an .eval directory and is using the appRoot runner fallback,
    // write and emit a clean empty report gracefully. If the project has its own runner, execute it.
    const evalDir = path.resolve(this.projectRoot, ".eval");
    const localRunner = path.resolve(this.projectRoot, "scripts", "harness", "runner.mjs");
    if (!fs.existsSync(evalDir) && runnerPath !== localRunner) {
      const emptyReport: EvaluationReport = {
        schemaVersion: 1,
        baseCommit,
        metrics: { passAt1: 0, passAtK: 0, k: 1, ssi: 0 },
        passed: true,
        results: [],
        violations: []
      };
      const reportsDir = path.dirname(this.reportPath);
      if (!fs.existsSync(reportsDir)) {
        try {
          fs.mkdirSync(reportsDir, { recursive: true });
        } catch {}
      }
      try {
        fs.writeFileSync(this.reportPath, JSON.stringify(emptyReport, null, 2) + "\n", "utf-8");
      } catch {}
      this.readReport();
      return this.getSnapshot();
    }

    // Reset/clear stale report before runner execution so failed or empty runs cannot expose stale results
    try {
      if (fs.existsSync(this.reportPath)) {
        fs.unlinkSync(this.reportPath);
      }
    } catch (err) {
      console.warn(`[EvalHarnessService] Failed to reset stale report at ${this.reportPath}:`, err);
    }

    this.emit({
      status: "running",
      report: this.snapshot.report,
      updatedAt: this.snapshot.updatedAt,
      error: null
    });

    return new Promise<EvalHarnessSnapshot>((resolve, reject) => {
      const runnerPath = this.resolveRunnerPath();
      if (!runnerPath) {
        const errMsg = `Harness runner script not found at ${this.runnerPath} or application root`;
        this.emit({
          status: "failed",
          report: this.snapshot.report,
          updatedAt: this.snapshot.updatedAt,
          error: errMsg
        });
        return reject(new Error(errMsg));
      }

      const args = [
        runnerPath,
        "--base", baseCommit,
        "--repo-root", this.projectRoot,
        "--output", this.reportPath
      ];

      const child = spawn(process.execPath, args, {
        cwd: this.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 32768) {
          stderr += chunk.toString("utf-8");
        }
      });

      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          // Both 0 (passed) and 1 (test failure) write a valid report
          this.readReport();
          resolve(this.getSnapshot());
        } else {
          // Code 2 or others: infrastructure or integrity failure
          const errExcerpt = stderr.trim().slice(-500) || `Process exited with code ${code}`;
          this.emit({
            status: "failed",
            report: this.snapshot.report,
            updatedAt: this.snapshot.updatedAt,
            error: errExcerpt
          });
          resolve(this.getSnapshot());
        }
      });

      child.on("error", (err) => {
        this.emit({
          status: "failed",
          report: this.snapshot.report,
          updatedAt: this.snapshot.updatedAt,
          error: err.message
        });
        reject(err);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.listeners.clear();
  }
}
