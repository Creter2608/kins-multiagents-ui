import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import type { PtyExitEvent } from "../../shared/contracts.js";

const PTY_EXIT_TIMEOUT_MS = 2000;

export class PtyService {
  private ptyProcess: pty.IPty | null = null;
  private projectRoot: string;
  private executablePath: string;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();
  private currentGeneration = 0;
  private isDisposed = false;
  private inFlightRestart: Promise<void> | null = null;
  private lastCols = 80;
  private lastRows = 24;

  constructor(
    projectRoot: string = process.cwd(),
    executablePath: string = path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
      "agy",
      "bin",
      "agy.exe"
    )
  ) {
    this.projectRoot = projectRoot;
    this.executablePath = executablePath;
  }

  start(cols: number = this.lastCols, rows: number = this.lastRows): void {
    if (this.isDisposed || this.ptyProcess) {
      return;
    }

    this.lastCols = cols;
    this.lastRows = rows;
    this.currentGeneration += 1;
    const sessionGeneration = this.currentGeneration;

    let fileToRun = this.executablePath;
    let args: string[] = [];

    // Fallback if agy.exe is not found
    if (!fs.existsSync(fileToRun)) {
      if (os.platform() === "win32") {
        fileToRun = "powershell.exe";
        args = ["-NoLogo"];
      } else {
        fileToRun = process.env.SHELL || "/bin/sh";
        args = [];
      }
    }

    const env = {
      ...process.env,
      COLORTERM: "truecolor",
      TERM: "xterm-256color"
    };

    try {
      const proc = pty.spawn(fileToRun, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.projectRoot,
        env: env as Record<string, string>
      });

      this.ptyProcess = proc;

      proc.onData((data: string) => {
        // Only forward data if this session is still the active generation
        if (this.currentGeneration === sessionGeneration) {
          for (const listener of this.dataListeners) {
            listener(data);
          }
        }
      });

      proc.onExit((event: { exitCode: number; signal?: number }) => {
        // Only forward exit and clear ptyProcess if matching current generation
        if (this.currentGeneration === sessionGeneration) {
          this.ptyProcess = null;
          for (const listener of this.exitListeners) {
            listener({ exitCode: event.exitCode, signal: event.signal });
          }
        }
      });
    } catch (err) {
      const errMsg = `\r\n\x1b[31m[PtyService Error]\x1b[0m Failed to spawn ${fileToRun}: ${err instanceof Error ? err.message : String(err)}\r\n`;
      for (const listener of this.dataListeners) {
        listener(errMsg);
      }
    }
  }

  private async killChildProcess(): Promise<void> {
    const proc = this.ptyProcess;
    if (!proc) {
      return;
    }

    // Detach current process so callbacks are ignored by persistent listeners
    this.ptyProcess = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, PTY_EXIT_TIMEOUT_MS);

      try {
        proc.onExit(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        proc.kill();
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      }
    });
  }

  restart(): Promise<void> {
    return this.restartSession();
  }

  restartSession(): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error("Cannot restart disposed PtyService"));
    }

    // Coalesce concurrent restart calls
    if (this.inFlightRestart) {
      return this.inFlightRestart;
    }

    this.inFlightRestart = (async () => {
      try {
        await this.killChildProcess();
        if (!this.isDisposed) {
          this.start(this.lastCols, this.lastRows);
        }
      } finally {
        this.inFlightRestart = null;
      }
    })();

    return this.inFlightRestart;
  }

  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.ptyProcess && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        // Ignore resize error on exit
      }
    }
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch {
        // Ignore kill error
      }
      this.ptyProcess = null;
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}
