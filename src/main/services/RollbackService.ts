import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RollbackResult } from "../../shared/contracts.js";
import { resolveHarnessResourcePaths } from "./harnessResourcePaths.js";

const execFileAsync = promisify(execFile);

export type RollbackScriptResolution = {
  scriptPath: string;
  additionalArgs: readonly string[];
};

export class RollbackService {
  private projectRoot: string;
  private sidecarDirectory?: string | undefined;
  private appRootOverride?: string | undefined;
  private inProgress: boolean = false;

  constructor(projectRoot: string = process.cwd(), appRoot?: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.appRootOverride = appRoot ? path.resolve(appRoot) : undefined;
  }

  setAppRootForTesting(root: string): void {
    this.appRootOverride = path.resolve(root);
  }

  resolveRollbackScript(): RollbackScriptResolution | null {
    // DEC-001: When operating on an external workspace (sidecarDirectory is present),
    // strictly use the packaged Kin harness, never the target workspace's internal scripts.
    if (!this.sidecarDirectory) {
      const localScript = path.join(this.projectRoot, "scripts", "ai-loop.mjs");
      if (fs.existsSync(localScript)) {
        return { scriptPath: localScript, additionalArgs: [] };
      }
    }

    const harness = resolveHarnessResourcePaths({ appRoot: this.appRootOverride });
    if (fs.existsSync(harness.loopScriptPath)) {
      const stateFile = this.sidecarDirectory
        ? path.join(this.sidecarDirectory, "state", "state.json")
        : path.join(this.projectRoot, ".ai", "state.json");
      return {
        scriptPath: harness.loopScriptPath,
        additionalArgs: ["--state-file", stateFile]
      };
    }

    return null;
  }

  async setProjectRoot(projectPath: string, sidecarDirectory?: string): Promise<void> {
    this.projectRoot = path.resolve(projectPath);
    this.sidecarDirectory = sidecarDirectory ? path.resolve(sidecarDirectory) : undefined;
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
