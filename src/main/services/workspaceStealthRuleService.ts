/**
 * src/main/services/workspaceStealthRuleService.ts
 * Manages reversible, zero-pollution stealth rules in client Git repositories.
 * Writes AGENTS.md / CLAUDE.md into the workspace root while ensuring they are
 * registered in .git/info/exclude so git status remains 100% clean.
 */

import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  StealthRuleTarget,
  StealthEquipResult,
  StealthUnequipResult,
  WorkspaceStealthStatus,
  WorkspaceContext
} from "../../shared/contracts.js";
import { RuleBundleCompilerService } from "./ruleBundleCompilerService.js";

const execFileAsync = promisify(execFile);

const EXCLUDE_MARKER_BEGIN = "# KINS:BEGIN STEALTH RULES";
const EXCLUDE_MARKER_END = "# KINS:END STEALTH RULES";

interface StealthManifestFile {
  readonly target: StealthRuleTarget;
  readonly path: string;
  readonly sha256: string;
}

interface StealthManifest {
  readonly version: 1;
  readonly workspaceId: string;
  readonly files: readonly StealthManifestFile[];
  readonly excludePath: string;
  readonly excludeEntries: readonly string[];
}

export class WorkspaceStealthRuleService {
  private readonly compiler: RuleBundleCompilerService;

  constructor(compiler: RuleBundleCompilerService = new RuleBundleCompilerService()) {
    this.compiler = compiler;
  }

  private sha256(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  private getManifestPath(sidecarDirectory: string): string {
    return path.join(sidecarDirectory, "stealth", "manifest.json");
  }

  private readManifest(sidecarDirectory: string): StealthManifest | null {
    const manifestPath = this.getManifestPath(sidecarDirectory);
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      return JSON.parse(raw) as StealthManifest;
    } catch {
      return null;
    }
  }

  private writeManifest(sidecarDirectory: string, manifest: StealthManifest): void {
    const manifestPath = this.getManifestPath(sidecarDirectory);
    const dir = path.dirname(manifestPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  async resolveGitExcludePath(workspaceRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspaceRoot, "rev-parse", "--git-path", "info/exclude"],
        { windowsHide: true }
      );
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new Error("Empty exclude path returned by git rev-parse");
      }
      return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceRoot, trimmed);
    } catch (err) {
      throw new Error(
        `Workspace is not a valid Git worktree or git is unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async equip(
    context: WorkspaceContext,
    options?: { targets?: readonly StealthRuleTarget[] }
  ): Promise<StealthEquipResult> {
    const targets: readonly StealthRuleTarget[] = options?.targets ?? ["agents", "claude"];
    const workspaceRoot = context.root;
    const excludePath = await this.resolveGitExcludePath(workspaceRoot);

    const manifest = this.readManifest(context.sidecarDirectory);
    const existingManifestPaths = new Set(manifest?.files.map((f) => path.resolve(f.path)) ?? []);

    // 1. Preflight destination check
    const plannedFiles: Array<{ target: StealthRuleTarget; filePath: string; content: string }> = [];
    const bundle = this.compiler.compileUniversalRules();

    for (const target of targets) {
      const fileName = target === "agents" ? "AGENTS.md" : "CLAUDE.md";
      const filePath = path.join(workspaceRoot, fileName);
      const content = target === "agents" ? bundle.agentsMarkdown : bundle.claudeMarkdown;

      if (fs.existsSync(filePath) && !existingManifestPaths.has(path.resolve(filePath))) {
        throw new Error(
          `Cannot equip stealth rules: Destination file "${fileName}" already exists and was not created by Kin.`
        );
      }

      plannedFiles.push({ target, filePath, content });
    }

    // 2. Prepare exclude entries
    const excludeEntries = plannedFiles.map((f) => `/${path.basename(f.filePath)}`);
    const excludeDir = path.dirname(excludePath);
    if (!fs.existsSync(excludeDir)) {
      fs.mkdirSync(excludeDir, { recursive: true });
    }

    const previousExcludeContent = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
    const createdFiles: string[] = [];

    try {
      // 3. Update exclude file FIRST to ensure files are never untracked even for a millisecond
      const markedExclude = [
        EXCLUDE_MARKER_BEGIN,
        ...excludeEntries,
        EXCLUDE_MARKER_END
      ].join("\n");

      let nextExcludeContent = previousExcludeContent;
      const beginIdx = nextExcludeContent.indexOf(EXCLUDE_MARKER_BEGIN);
      const endIdx = nextExcludeContent.indexOf(EXCLUDE_MARKER_END);

      if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
        const before = nextExcludeContent.slice(0, beginIdx).trimEnd();
        const after = nextExcludeContent.slice(endIdx + EXCLUDE_MARKER_END.length).trimStart();
        nextExcludeContent = [before, markedExclude, after].filter(Boolean).join("\n\n") + "\n";
      } else {
        nextExcludeContent = nextExcludeContent.trim().length === 0
          ? markedExclude + "\n"
          : `${nextExcludeContent.trimEnd()}\n\n${markedExclude}\n`;
      }

      fs.writeFileSync(excludePath, nextExcludeContent, "utf-8");

      // 4. Write rule files
      const manifestFiles: StealthManifestFile[] = [];
      for (const item of plannedFiles) {
        fs.writeFileSync(item.filePath, item.content, "utf-8");
        createdFiles.push(item.filePath);
        manifestFiles.push({
          target: item.target,
          path: item.filePath,
          sha256: this.sha256(item.content)
        });
      }

      // 5. Verify ignore with git check-ignore
      let excluded = true;
      try {
        const fileNames = plannedFiles.map((f) => path.basename(f.filePath));
        await execFileAsync("git", ["-C", workspaceRoot, "check-ignore", ...fileNames], { windowsHide: true });
      } catch {
        excluded = false;
      }

      // 6. Record manifest
      const newManifest: StealthManifest = {
        version: 1,
        workspaceId: context.id,
        files: manifestFiles,
        excludePath,
        excludeEntries
      };
      this.writeManifest(context.sidecarDirectory, newManifest);

      return {
        success: true,
        filesCreated: Object.freeze(createdFiles),
        excluded
      };
    } catch (err) {
      // Rollback on failure
      for (const f of createdFiles) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {}
      }
      try {
        if (fs.existsSync(excludePath)) {
          fs.writeFileSync(excludePath, previousExcludeContent, "utf-8");
        }
      } catch {}
      throw err;
    }
  }

  async unequip(context: WorkspaceContext): Promise<StealthUnequipResult> {
    const manifest = this.readManifest(context.sidecarDirectory);
    if (!manifest) {
      return { success: true, filesRemoved: Object.freeze([]) };
    }

    const filesRemoved: string[] = [];

    // 1. Check each file: if hash matches, delete; if modified, preserve
    for (const fileRecord of manifest.files) {
      if (fs.existsSync(fileRecord.path)) {
        try {
          const currentContent = fs.readFileSync(fileRecord.path, "utf-8");
          const currentHash = this.sha256(currentContent);
          if (currentHash === fileRecord.sha256) {
            fs.unlinkSync(fileRecord.path);
            filesRemoved.push(fileRecord.path);
          } else {
            console.warn(
              `[WorkspaceStealthRuleService] Preserving modified file: ${fileRecord.path}`
            );
          }
        } catch (err) {
          console.warn(`[WorkspaceStealthRuleService] Failed to check/remove ${fileRecord.path}:`, err);
        }
      }
    }

    // 2. Remove Kin's exclude block
    if (fs.existsSync(manifest.excludePath)) {
      try {
        const content = fs.readFileSync(manifest.excludePath, "utf-8");
        const beginIdx = content.indexOf(EXCLUDE_MARKER_BEGIN);
        const endIdx = content.indexOf(EXCLUDE_MARKER_END);
        if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
          const before = content.slice(0, beginIdx).trimEnd();
          const after = content.slice(endIdx + EXCLUDE_MARKER_END.length).trimStart();
          const next = [before, after].filter(Boolean).join("\n\n");
          fs.writeFileSync(manifest.excludePath, next ? next + "\n" : "", "utf-8");
        }
      } catch (err) {
        console.warn(`[WorkspaceStealthRuleService] Failed to clean exclude file:`, err);
      }
    }

    // 3. Remove manifest
    const manifestPath = this.getManifestPath(context.sidecarDirectory);
    if (fs.existsSync(manifestPath)) {
      try {
        fs.unlinkSync(manifestPath);
      } catch {}
    }

    return {
      success: true,
      filesRemoved: Object.freeze(filesRemoved)
    };
  }

  async getStatus(context: WorkspaceContext): Promise<WorkspaceStealthStatus> {
    const manifest = this.readManifest(context.sidecarDirectory);
    if (!manifest || manifest.files.length === 0) {
      return { equipped: false, excluded: false, files: Object.freeze([]) };
    }

    const files = manifest.files.map((f) => f.path);
    const allFilesExist = files.every((f) => fs.existsSync(f));

    let excluded = false;
    if (allFilesExist) {
      try {
        const fileNames = files.map((f) => path.basename(f));
        await execFileAsync("git", ["-C", context.root, "check-ignore", ...fileNames], { windowsHide: true });
        excluded = true;
      } catch {
        excluded = false;
      }
    }

    return {
      equipped: allFilesExist,
      excluded,
      files: Object.freeze(files)
    };
  }
}
