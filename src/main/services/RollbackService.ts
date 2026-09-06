import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RollbackResult } from "../../shared/contracts.js";

const execFileAsync = promisify(execFile);

export type RollbackScriptResolution = {
  scriptPath: string;
  additionalArgs: readonly string[];
};

export class RollbackService {
  private projectRoot: string;
  private appRootOverride?: string | undefined;
  private inProgress: boolean = false;

  constructor(projectRoot: string = process.cwd(), appRoot?: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.appRootOverride = appRoot ? path.resolve(appRoot) : undefined;
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
      if (fs.existsSync(path.join(curr, "scripts", "ai-loop.mjs"))) {
        return curr;
      }
      curr = path.dirname(curr);
    }
    return process.cwd();
  }

  resolveRollbackScript(): RollbackScriptResolution | null {
    const localScript = path.join(this.projectRoot, "scripts", "ai-loop.mjs");
    if (fs.existsSync(localScript)) {
      return { scriptPath: localScript, additionalArgs: [] };
    }

    const appRoot = this.resolveDefaultAppRoot();
    const appScript = path.join(appRoot, "scripts", "ai-loop.mjs");
    if (fs.existsSync(appScript)) {
      return {
        scriptPath: appScript,
        additionalArgs: ["--state-file", path.join(this.projectRoot, ".ai", "state.json")]
      };
    }

    return null;
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
      const resolution = this.resolveRollbackScript();
      if (!resolution) {
        return {
          success: false,
          message: "Rollback failed: scripts/ai-loop.mjs not found in project or application root"
        };
      }

      const args = ["rollback", ...resolution.additionalArgs];
      const { stdout } = await execFileAsync("node", [resolution.scriptPath, ...args], {
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
