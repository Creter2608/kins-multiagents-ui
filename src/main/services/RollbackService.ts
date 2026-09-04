import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RollbackResult } from "../../shared/contracts.js";

const execFileAsync = promisify(execFile);

export class RollbackService {
  private projectRoot: string;
  private inProgress: boolean = false;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.projectRoot = path.resolve(projectPath);
  }

  async executeRollback(): Promise<RollbackResult> {
    if (this.inProgress) {
      return {
        success: false,
        message: "Another rollback operation is currently in progress"
      };
    }

    this.inProgress = true;
    try {
      const scriptPath = path.join(this.projectRoot, "scripts", "ai-loop.mjs");
      const { stdout } = await execFileAsync("node", [scriptPath, "rollback"], {
        cwd: this.projectRoot,
        windowsHide: true,
        timeout: 10000
      });

      return {
        success: true,
        message: stdout.trim() || "Rollback completed successfully"
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      const errDetail = execErr.stderr || execErr.stdout || execErr.message || String(err);
      return {
        success: false,
        message: `Rollback failed: ${errDetail.trim()}`
      };
    } finally {
      this.inProgress = false;
    }
  }
}
