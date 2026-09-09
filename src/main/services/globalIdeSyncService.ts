/**
 * src/main/services/globalIdeSyncService.ts
 * Synchronizes universal Kin rules (Karpathy, Dual-Oracle, CodeGraph, Loop V3)
 * across developer's global IDE locations (~/.gemini, ~/.claude, ~/.cursor).
 * Preserves all user-authored content outside Kin-owned markers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GlobalIdeTarget, GlobalIdeSyncResult } from "../../shared/contracts.js";
import { RuleBundleCompilerService } from "./ruleBundleCompilerService.js";

const MARKER_BEGIN = "<!-- KINS:BEGIN UNIVERSAL RULES -->";
const MARKER_END = "<!-- KINS:END UNIVERSAL RULES -->";

const VALID_TARGETS: ReadonlySet<GlobalIdeTarget> = new Set(["gemini", "claude", "cursor"]);

export class GlobalIdeSyncService {
  private readonly compiler: RuleBundleCompilerService;
  private readonly homeDirectory: string;

  constructor(
    compiler: RuleBundleCompilerService = new RuleBundleCompilerService(),
    homeDirectory?: string
  ) {
    this.compiler = compiler;
    this.homeDirectory = path.resolve(homeDirectory ?? os.homedir());
  }

  private atomicWrite(targetPath: string, content: string): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, targetPath);
  }

  private injectMarkedBlock(existingContent: string, blockContent: string): string {
    const wrappedBlock = `${MARKER_BEGIN}\n${blockContent.trim()}\n${MARKER_END}`;
    const beginIdx = existingContent.indexOf(MARKER_BEGIN);
    const endIdx = existingContent.indexOf(MARKER_END);

    if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
      const before = existingContent.slice(0, beginIdx).trimEnd();
      const after = existingContent.slice(endIdx + MARKER_END.length).trimStart();
      const parts = [before, wrappedBlock, after].filter(Boolean);
      return parts.join("\n\n") + "\n";
    }

    if (existingContent.trim().length === 0) {
      return wrappedBlock + "\n";
    }

    return `${existingContent.trimEnd()}\n\n${wrappedBlock}\n`;
  }

  async sync(options?: { targets?: readonly GlobalIdeTarget[] }): Promise<GlobalIdeSyncResult> {
    const requestedTargets = options?.targets ?? Array.from(VALID_TARGETS);

    for (const target of requestedTargets) {
      if (!VALID_TARGETS.has(target)) {
        throw new Error(`Invalid Global IDE target: "${target}". Supported: ${Array.from(VALID_TARGETS).join(", ")}`);
      }
    }

    const bundle = this.compiler.compileUniversalRules();
    const syncedPaths: string[] = [];

    for (const target of requestedTargets) {
      if (target === "gemini") {
        const geminiPath = path.join(this.homeDirectory, ".gemini", "GEMINI.md");
        const existing = fs.existsSync(geminiPath) ? fs.readFileSync(geminiPath, "utf-8") : "";
        const next = this.injectMarkedBlock(existing, bundle.geminiMarkdown);
        this.atomicWrite(geminiPath, next);
        syncedPaths.push(geminiPath);
      } else if (target === "claude") {
        const claudePath = path.join(this.homeDirectory, ".claude", "CLAUDE.md");
        const existing = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, "utf-8") : "";
        const next = this.injectMarkedBlock(existing, bundle.claudeMarkdown);
        this.atomicWrite(claudePath, next);
        syncedPaths.push(claudePath);
      } else if (target === "cursor") {
        const cursorRulePath = path.join(this.homeDirectory, ".cursor", "rules", "kins-autonomous-loop.mdc");
        this.atomicWrite(cursorRulePath, bundle.cursorMdc);
        syncedPaths.push(cursorRulePath);
      }
    }

    return {
      success: true,
      synced: Object.freeze(syncedPaths)
    };
  }
}
