import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  EccAssetSummary,
  EccCatalogSnapshot,
  EccAssetStatus
} from "../../shared/eccContracts.js";

export const MAX_ASSET_FILE_BYTES = 512 * 1024; // 512 KiB
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_TOTAL_SCANNED_ASSETS = 500;

// Regex for suspicious invisible Unicode / bidi control characters & directional isolates
const SUSPICIOUS_UNICODE_REGEX = /[\u200B\u200C\u200D\u200E\u200F\u2060\u2066-\u2069\uFEFF\u202A-\u202E]/;

// Regex for suspicious injection script payloads in metadata
const SUSPICIOUS_PAYLOAD_REGEX = /<script\b|data:text\/html|base64,/i;

export interface EccSelectedAsset {
  readonly summary: EccAssetSummary;
  readonly content: string;
}

export interface EccCatalogServiceOptions {
  readonly maxFileBytes?: number;
  readonly maxDescriptionLength?: number;
}

interface ParsedFrontmatter {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly category?: string | undefined;
}

/**
 * Parses simple YAML-style frontmatter without requiring external heavy dependencies.
 */
function parseFrontmatter(raw: string): { readonly frontmatter: ParsedFrontmatter; readonly body: string } {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }

  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatterText = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  const lines = frontmatterText.split("\n");
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, "");
      fields[key] = val;
    }
  }

  const tools = fields["tools"]
    ? fields["tools"].split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : undefined;

  return {
    frontmatter: {
      name: fields["name"],
      description: fields["description"],
      tools,
      model: fields["model"],
      category: fields["category"]
    },
    body
  };
}

/**
 * Service that scans, catalogs, and caches metadata for ECC agents and skills in read-only mode.
 * Adheres to AgentShield security perimeter: quarantines path-traversals, oversized files, and hidden unicode.
 */
export class EccCatalogService {
  private readonly sourceRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxDescriptionLength: number;
  private cachedSnapshot: EccCatalogSnapshot | null = null;

  constructor(sourceRoot: string, options?: EccCatalogServiceOptions) {
    this.sourceRoot = path.resolve(sourceRoot);
    this.maxFileBytes = options?.maxFileBytes ?? MAX_ASSET_FILE_BYTES;
    this.maxDescriptionLength = options?.maxDescriptionLength ?? MAX_DESCRIPTION_LENGTH;
  }

  /**
   * Disposes any cached state.
   */
  dispose(): void {
    this.cachedSnapshot = null;
  }

  /**
   * Returns current catalog snapshot or refreshes if not yet loaded.
   */
  async getSnapshot(): Promise<EccCatalogSnapshot> {
    if (!this.cachedSnapshot) {
      return this.refresh();
    }
    return this.cachedSnapshot;
  }

  /**
   * Refreshes the catalog snapshot deterministically from the ECC directory.
   */
  async refresh(): Promise<EccCatalogSnapshot> {
    const diagnostics: string[] = [];
    const assets: EccAssetSummary[] = [];

    if (!fs.existsSync(this.sourceRoot)) {
      diagnostics.push(`ECC source root directory does not exist: ${this.sourceRoot}`);
      const emptySnapshot: EccCatalogSnapshot = {
        revision: "0",
        sourceRoot: this.sourceRoot,
        availableCount: 0,
        quarantinedCount: 0,
        assets: Object.freeze([]),
        diagnostics: Object.freeze(diagnostics),
        refreshedAt: Date.now()
      };
      this.cachedSnapshot = emptySnapshot;
      return emptySnapshot;
    }

    try {
      // 1. Scan agents directory
      const agentsDir = path.join(this.sourceRoot, "agents");
      if (fs.existsSync(agentsDir)) {
        await this.scanAgents(agentsDir, assets, diagnostics);
      }

      // 2. Scan skills directory
      const skillsDir = path.join(this.sourceRoot, "skills");
      if (fs.existsSync(skillsDir)) {
        await this.scanSkills(skillsDir, assets, diagnostics);
      }
    } catch (err) {
      diagnostics.push(`Error during ECC scan: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stable sort assets by ID
    assets.sort((a, b) => a.id.localeCompare(b.id));

    // Compute revision hash from sorted asset identities and digests
    const revHasher = crypto.createHash("sha256");
    for (const a of assets) {
      revHasher.update(`${a.id}:${a.sha256}:${a.status};`);
    }
    const revision = revHasher.digest("hex");

    const availableCount = assets.filter((a) => a.status === "available").length;
    const quarantinedCount = assets.filter((a) => a.status === "quarantined").length;

    const snapshot: EccCatalogSnapshot = {
      revision,
      sourceRoot: this.sourceRoot,
      availableCount,
      quarantinedCount,
      assets: Object.freeze(assets),
      diagnostics: Object.freeze(diagnostics),
      refreshedAt: Date.now()
    };

    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Loads verified content for the selected agent and skills.
   * Performs real-time content verification against the catalog digest.
   */
  async loadSelected(
    revision: string,
    agentId: string,
    skillIds: readonly string[]
  ): Promise<readonly EccSelectedAsset[]> {
    const snapshot = await this.getSnapshot();
    if (snapshot.revision !== revision) {
      throw new Error(`STALE_CATALOG_REVISION: expected ${snapshot.revision}, got ${revision}`);
    }

    const requestedIds = [agentId, ...skillIds];
    const results: EccSelectedAsset[] = [];

    for (const reqId of requestedIds) {
      const summary = snapshot.assets.find((a) => a.id === reqId);
      if (!summary) {
        throw new Error(`ASSET_NOT_FOUND: ${reqId}`);
      }
      if (summary.status === "quarantined") {
        throw new Error(`ASSET_QUARANTINED: ${reqId} (${summary.reasons.join(", ")})`);
      }

      const fullPath = path.resolve(this.sourceRoot, summary.relativePath);
      this.assertPathContained(fullPath);

      const content = fs.readFileSync(fullPath, "utf-8");
      const computedSha = crypto.createHash("sha256").update(content, "utf-8").digest("hex");

      if (computedSha !== summary.sha256) {
        throw new Error(`CONTENT_DIGEST_MISMATCH: ${reqId} has been modified since catalog publication`);
      }

      results.push({ summary, content });
    }

    return Object.freeze(results);
  }

  private async scanAgents(
    agentsDir: string,
    assets: EccAssetSummary[],
    diagnostics: string[]
  ): Promise<void> {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (assets.length >= MAX_TOTAL_SCANNED_ASSETS) break;
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const fullPath = path.join(agentsDir, entry.name);
      const relativePath = path.relative(this.sourceRoot, fullPath);
      const id = `agent:${entry.name.replace(/\.md$/, "")}`;

      const summary = this.evaluateAsset(id, "agent", fullPath, relativePath, diagnostics);
      if (summary) {
        assets.push(summary);
      }
    }
  }

  private async scanSkills(
    skillsDir: string,
    assets: EccAssetSummary[],
    diagnostics: string[]
  ): Promise<void> {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (assets.length >= MAX_TOTAL_SCANNED_ASSETS) break;

      if (entry.isDirectory()) {
        const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillMdPath)) {
          const relativePath = path.relative(this.sourceRoot, skillMdPath);
          const id = `skill:${entry.name}`;
          const summary = this.evaluateAsset(id, "skill", skillMdPath, relativePath, diagnostics);
          if (summary) {
            assets.push(summary);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(skillsDir, entry.name);
        const relativePath = path.relative(this.sourceRoot, fullPath);
        const id = `skill:${entry.name.replace(/\.md$/, "")}`;
        const summary = this.evaluateAsset(id, "skill", fullPath, relativePath, diagnostics);
        if (summary) {
          assets.push(summary);
        }
      }
    }
  }

  private evaluateAsset(
    id: string,
    kind: "agent" | "skill",
    fullPath: string,
    relativePath: string,
    diagnostics: string[]
  ): EccAssetSummary | null {
    const reasons: string[] = [];
    let status: EccAssetStatus = "available";

    // 1. Path containment check
    try {
      this.assertPathContained(fullPath);
    } catch (err) {
      status = "quarantined";
      reasons.push(`PATH_ESCAPE: ${err instanceof Error ? err.message : String(err)}`);
      diagnostics.push(`Security alert: Path traversal attempted for asset ${id} at ${relativePath}`);
      return {
        id,
        kind,
        name: path.basename(relativePath),
        description: "Quarantined due to path traversal escape",
        relativePath,
        sha256: "0".repeat(64),
        status,
        reasons: Object.freeze(reasons)
      };
    }

    // 2. File size bounds check
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch (err) {
      return null;
    }

    if (stat.size > this.maxFileBytes) {
      status = "quarantined";
      reasons.push(`FILE_SIZE_LIMIT_EXCEEDED: ${stat.size} bytes > ${this.maxFileBytes} limit`);
    }

    // 3. Read content and compute hash
    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch (err) {
      status = "quarantined";
      reasons.push(`READ_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    const sha256 = crypto.createHash("sha256").update(content, "utf-8").digest("hex");

    // 4. Parse frontmatter
    const { frontmatter } = parseFrontmatter(content);
    let name = frontmatter.name?.trim() || path.basename(relativePath).replace(/\.(md|markdown)$/i, "");
    let description = frontmatter.description?.trim() || "";

    // 5. Sanitize metadata & detect invisible Unicode / injection payloads
    if (SUSPICIOUS_UNICODE_REGEX.test(content) || SUSPICIOUS_UNICODE_REGEX.test(name) || SUSPICIOUS_UNICODE_REGEX.test(description)) {
      status = "quarantined";
      reasons.push("SUSPICIOUS_UNICODE_DETECTED: Asset contains zero-width or bidi control characters");
    }

    if (SUSPICIOUS_PAYLOAD_REGEX.test(content) || SUSPICIOUS_PAYLOAD_REGEX.test(name) || SUSPICIOUS_PAYLOAD_REGEX.test(description)) {
      status = "quarantined";
      reasons.push("SUSPICIOUS_PAYLOAD_DETECTED: Asset contains script or data uri payload");
    }

    // Truncate overly long descriptions
    if (description.length > this.maxDescriptionLength) {
      description = description.slice(0, this.maxDescriptionLength) + "...";
    }

    return {
      id,
      kind,
      type: kind,
      name,
      description,
      relativePath,
      sha256,
      digest: sha256,
      sizeBytes: stat.size,
      status,
      reasons: Object.freeze(reasons),
      ...(frontmatter.category ? { category: frontmatter.category } : {}),
      ...(frontmatter.tools ? { tools: frontmatter.tools } : {}),
      ...(frontmatter.model ? { model: frontmatter.model } : {})
    };
  }

  private assertPathContained(targetPath: string): void {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(this.sourceRoot);

    // Ensure realpath does not escape root (symlink defense)
    if (fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;

      const relative = path.relative(realRoot, realTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path ${realTarget} escapes root ${realRoot}`);
      }
    } else {
      const relative = path.relative(resolvedRoot, resolvedTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path ${resolvedTarget} escapes root ${resolvedRoot}`);
      }
    }
  }
}
