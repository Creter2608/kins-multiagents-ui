/**
 * src/main/services/workspaceRegistryService.ts
 * Deterministic workspace identity & sidecar resolver under userData.
 * Guarantees zero target repository pollution.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceRecord } from "./workspaceContext.js";

export class WorkspaceRegistryService {
  private readonly workspacesBaseDir: string;
  private readonly registryFilePath: string;

  constructor(userDataDirectory: string) {
    this.workspacesBaseDir = path.join(path.resolve(userDataDirectory), "workspaces");
    this.registryFilePath = path.join(this.workspacesBaseDir, "registry.json");
    if (!fs.existsSync(this.workspacesBaseDir)) {
      fs.mkdirSync(this.workspacesBaseDir, { recursive: true });
    }
  }

  getSidecarDirectory(workspaceId: string): string {
    return path.join(this.workspacesBaseDir, workspaceId);
  }

  async resolve(projectPath: string): Promise<WorkspaceRecord> {
    const rawResolved = path.resolve(projectPath);
    if (!fs.existsSync(rawResolved)) {
      throw new Error(`Directory does not exist or is not a directory: ${projectPath}`);
    }

    const stat = fs.statSync(rawResolved);
    if (!stat.isDirectory()) {
      throw new Error(`Target project path is not a directory: ${projectPath}`);
    }

    // Canonicalize with realpath to collapse symlink aliases
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(rawResolved);
    } catch {
      canonicalRoot = rawResolved;
    }

    // Versioned deterministic SHA-256 identity
    const normalizedKey = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    const workspaceId = crypto
      .createHash("sha256")
      .update(`v1:${normalizedKey}`)
      .digest("hex")
      .slice(0, 16);

    const displayName = path.basename(canonicalRoot) || canonicalRoot;
    const record: WorkspaceRecord = {
      id: workspaceId,
      root: canonicalRoot,
      displayName
    };

    // Prepare sidecar directory outside the target repository
    const sidecarDir = this.getSidecarDirectory(workspaceId);
    if (!fs.existsSync(sidecarDir)) {
      fs.mkdirSync(sidecarDir, { recursive: true });
    }

    await this.recordWorkspace(record);
    return record;
  }

  private async recordWorkspace(record: WorkspaceRecord): Promise<void> {
    const current = await this.list();
    const updated = [record, ...current.filter((w) => w.id !== record.id)];

    const tmpFile = `${this.registryFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpFile, this.registryFilePath);
    } catch {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  async list(): Promise<readonly WorkspaceRecord[]> {
    if (!fs.existsSync(this.registryFilePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(this.registryFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is WorkspaceRecord =>
            item &&
            typeof item === "object" &&
            typeof item.id === "string" &&
            typeof item.root === "string" &&
            typeof item.displayName === "string"
        );
      }
    } catch {
      // Gracefully return empty list on malformed registry
    }
    return [];
  }
}
