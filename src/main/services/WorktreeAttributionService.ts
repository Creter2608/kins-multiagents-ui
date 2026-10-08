import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorktreeAttribution, AttributionProvenance } from "../../shared/usage.js";

const execFileAsync = promisify(execFile);

export class WorktreeAttributionService {
  private cache = new Map<string, { attribution: WorktreeAttribution; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Generates a stable, opaque identifier for a repository or worktree path.
   * Prevents leaking host-sensitive filesystem paths to the renderer.
   */
  public static hashPath(targetPath: string): string {
    const normalized = path.normalize(targetPath).toLowerCase();
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Safely resolves Git repository and worktree attribution for a given directory.
   * Runs Git commands with argument arrays (zero shell injection risk).
   */
  async resolve(
    cwd: string,
    provenance: AttributionProvenance = "observation"
  ): Promise<WorktreeAttribution | null> {
    if (!cwd || typeof cwd !== "string") {
      return null;
    }

    const normalizedCwd = path.normalize(cwd);
    const cached = this.cache.get(normalizedCwd);
    if (cached && Date.now() < cached.expiresAt) {
      return { ...cached.attribution, provenance };
    }

    try {
      // 1. Resolve root git directory (git-common-dir points to main repo even in worktrees)
      const { stdout: commonDirRaw } = await execFileAsync(
        "git",
        ["rev-parse", "--git-common-dir"],
        { cwd: normalizedCwd, timeout: 3000, windowsHide: true }
      );
      const commonDir = path.resolve(normalizedCwd, commonDirRaw.trim());

      // 2. Resolve worktree root
      const { stdout: toplevelRaw } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: normalizedCwd, timeout: 3000, windowsHide: true }
      );
      const toplevelDir = path.resolve(normalizedCwd, toplevelRaw.trim());

      // 3. Resolve current branch (empty string if detached HEAD)
      let branch: string | null = null;
      try {
        const { stdout: branchRaw } = await execFileAsync(
          "git",
          ["branch", "--show-current"],
          { cwd: normalizedCwd, timeout: 3000, windowsHide: true }
        );
        const trimmedBranch = branchRaw.trim();
        branch = trimmedBranch.length > 0 ? trimmedBranch : null;
      } catch {
        branch = null;
      }

      // 4. Resolve HEAD commit hash (short)
      let commit: string | null = null;
      try {
        const { stdout: commitRaw } = await execFileAsync(
          "git",
          ["rev-parse", "--short", "HEAD"],
          { cwd: normalizedCwd, timeout: 3000, windowsHide: true }
        );
        const trimmedCommit = commitRaw.trim();
        commit = trimmedCommit.length > 0 ? trimmedCommit : null;
      } catch {
        commit = null;
      }

      const attribution: WorktreeAttribution = {
        repositoryId: WorktreeAttributionService.hashPath(commonDir),
        worktreeId: WorktreeAttributionService.hashPath(toplevelDir),
        branch,
        commit,
        provenance
      };

      this.cache.set(normalizedCwd, {
        attribution,
        expiresAt: Date.now() + this.ttlMs
      });

      return attribution;
    } catch {
      // Not a git repository or git binary unavailable
      return null;
    }
  }

  /**
   * Clears in-memory resolution cache (e.g. during testing)
   */
  clearCache(): void {
    this.cache.clear();
  }
}
