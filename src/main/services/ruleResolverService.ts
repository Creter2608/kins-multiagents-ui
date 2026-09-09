/**
 * src/main/services/ruleResolverService.ts
 * Assembles provenance-bearing rules in strict deterministic precedence:
 * 1. host-policy (Safety invariants)
 * 2. user-global-constraint (User-wide non-negotiable rules)
 * 3. workspace-sidecar (Per-workspace personal instructions)
 * 4. repository-native (Existing project-level instructions, read-only)
 * 5. user-global-preference (User-wide workflow defaults)
 * 
 * Invariant: Never mutates or writes to the target repository.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedRuleBlock, WorkspaceRecord } from "./workspaceContext.js";

export interface ResolveRulesInput {
  readonly workspace: WorkspaceRecord;
  readonly userDataDirectory: string;
  readonly sidecarDirectory?: string;
  readonly appRoot?: string;
}

const MAX_BLOCK_CHARS = 50_000;

export class RuleResolverService {
  async resolve(input: ResolveRulesInput): Promise<readonly ResolvedRuleBlock[]> {
    const blocks: ResolvedRuleBlock[] = [];
    const { workspace, userDataDirectory, sidecarDirectory, appRoot } = input;

    // 1. Host-enforced safety policy (packaged with Cockpit)
    const hostPolicy = this.readHostPolicy(appRoot);
    if (hostPolicy) {
      blocks.push({
        source: "host-policy",
        origin: "cockpit-packaged-invariants",
        content: hostPolicy
      });
    }

    // 2. User-global non-negotiable constraints
    const globalConstraintsPath = path.join(userDataDirectory, "rules", "global-constraints.md");
    const globalConstraints = this.safeReadFile(globalConstraintsPath);
    if (globalConstraints) {
      blocks.push({
        source: "user-global-constraint",
        origin: globalConstraintsPath,
        content: globalConstraints
      });
    }

    // 3. Workspace-sidecar personal rules (stored outside the repository)
    if (sidecarDirectory) {
      const sidecarRulesPath = path.join(sidecarDirectory, "rules.md");
      const sidecarRules = this.safeReadFile(sidecarRulesPath);
      if (sidecarRules) {
        blocks.push({
          source: "workspace-sidecar",
          origin: sidecarRulesPath,
          content: sidecarRules
        });
      }
    }

    // 4. Repository-native instructions (Discovered READ-ONLY)
    const nativeBlocks = this.discoverNativeRules(workspace.root);
    blocks.push(...nativeBlocks);

    // 5. User-global workflow preferences
    const globalPreferencesPath = path.join(userDataDirectory, "rules", "global-preferences.md");
    const globalPreferences = this.safeReadFile(globalPreferencesPath);
    if (globalPreferences) {
      blocks.push({
        source: "user-global-preference",
        origin: globalPreferencesPath,
        content: globalPreferences
      });
    }

    return Object.freeze(blocks);
  }

  private readHostPolicy(appRoot?: string): string {
    const defaultInvariants = [
      "# Cockpit Host Policy Invariants",
      "1. Protected evaluation zones (.eval/) are immutable and read-only.",
      "2. Execution isolation via container sandbox is enforced for all external shell commands.",
      "3. Maximum 1 retry on verification failures before reporting to human operator."
    ].join("\n");

    if (appRoot) {
      const agentsMd = path.join(appRoot, "AGENTS.md");
      const content = this.safeReadFile(agentsMd);
      if (content) {
        return content.slice(0, MAX_BLOCK_CHARS);
      }
    }

    return defaultInvariants;
  }

  private discoverNativeRules(repoRoot: string): ResolvedRuleBlock[] {
    const candidateRelPaths = [
      "AGENTS.md",
      "CLAUDE.md",
      ".windsurfrules",
      ".clinerules"
    ];

    const results: ResolvedRuleBlock[] = [];

    for (const rel of candidateRelPaths) {
      const fullPath = path.join(repoRoot, rel);
      const content = this.safeReadFile(fullPath);
      if (content) {
        results.push({
          source: "repository-native",
          origin: fullPath,
          content: content.slice(0, MAX_BLOCK_CHARS)
        });
      }
    }

    // Check .cursor/rules directory if present
    const cursorRulesDir = path.join(repoRoot, ".cursor", "rules");
    if (fs.existsSync(cursorRulesDir)) {
      try {
        const files = fs.readdirSync(cursorRulesDir);
        for (const f of files) {
          if (f.endsWith(".mdc") || f.endsWith(".md")) {
            const fullPath = path.join(cursorRulesDir, f);
            const content = this.safeReadFile(fullPath);
            if (content) {
              results.push({
                source: "repository-native",
                origin: fullPath,
                content: content.slice(0, MAX_BLOCK_CHARS)
              });
            }
          }
        }
      } catch {
        // Ignore unreadable cursor rules
      }
    }

    return results;
  }

  private safeReadFile(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch {
      // Return null on read error
    }
    return null;
  }
}
