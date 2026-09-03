import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import type { PtyExitEvent } from "../../shared/contracts.js";

export class PtyService {
  private ptyProcess: pty.IPty | null = null;
  private projectRoot: string;
  private executablePath: string;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();

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

  start(cols: number = 80, rows: number = 24): void {
    if (this.ptyProcess) {
      return;
    }

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
      this.ptyProcess = pty.spawn(fileToRun, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.projectRoot,
        env: env as Record<string, string>
      });

      this.ptyProcess.onData((data: string) => {
        for (const listener of this.dataListeners) {
          listener(data);
        }
      });

      this.ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
        this.ptyProcess = null;
        for (const listener of this.exitListeners) {
          listener({ exitCode: event.exitCode, signal: event.signal });
        }
      });
    } catch (err) {
      const errMsg = `\r\n\x1b[31m[PtyService Error]\x1b[0m Failed to spawn ${fileToRun}: ${err instanceof Error ? err.message : String(err)}\r\n`;
      for (const listener of this.dataListeners) {
        listener(errMsg);
      }
    }
  }

  write(data: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {
        // Ignore resize error on exit
      }
    }
  }

  async restart(): Promise<void> {
    this.dispose();
    this.start();
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
