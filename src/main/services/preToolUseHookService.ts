/**
 * src/main/services/preToolUseHookService.ts
 * Manages Antigravity CLI PreToolUse hook configuration and workspace registration.
 * Completely decoupled from target repositories (zero foreign repo pollution).
 */

import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalizePath } from "./blueprintApprovalAuthenticator.js";
import type { WorkspaceMutationPolicyMode } from "../../shared/workspaceMutationPolicy.js";
import {
  STEALTH_TRANSPARENCY_TAG,
  type ActiveStealthRules,
  type StealthViolation,
  type StealthViolationCode,
  type StealthDecisionMetadata,
  type StealthEvaluationRequest,
  type StealthEvaluationDecision
} from "../../shared/stealthRules.js";
import {
  type WorkspaceRegistryEntry,
  type WorkspaceRegistryFile,
  type CodeGraphExplorationEvidence,
  computeModeHmac,
  verifyModeHmac,
  computeRegistryEntryHmac,
  verifyRegistryEntryHmac,
  computeExplorationEvidenceHmac,
  verifyExplorationEvidenceHmac
} from "./preToolUseRegistryHmac.js";

export {
  type WorkspaceRegistryEntry,
  type WorkspaceRegistryFile,
  type CodeGraphExplorationEvidence,
  computeModeHmac,
  verifyModeHmac,
  computeRegistryEntryHmac,
  verifyRegistryEntryHmac,
  computeExplorationEvidenceHmac,
  verifyExplorationEvidenceHmac
};

export function resolveDefaultRuntimeCommand(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const moduleRelativeHookPath = path.resolve(
    moduleDirectory,
    "../../cli/preToolUseHook.js"
  );
  const sourceTreeFallbackPath = path.resolve(
    moduleDirectory,
    "../../../dist/src/cli/preToolUseHook.js"
  );
  const hookPath = syncFs.existsSync(moduleRelativeHookPath)
    ? moduleRelativeHookPath
    : sourceTreeFallbackPath;

  const normalizedHookPath = hookPath.replace(/\\/g, "/");
  return normalizedHookPath.includes(" ") ? `node "${normalizedHookPath}"` : `node ${normalizedHookPath}`;
}

export interface EquipPreToolUseHookOptions {
  readonly workspaceRoot: string;
  readonly sidecarStatePath: string;
  readonly userDataPath: string;
  readonly runtimeCommand?: string | undefined;
  readonly hooksConfigPath?: string | undefined;
  readonly mutationPolicyMode?: WorkspaceMutationPolicyMode | undefined;
}

export interface CodeGraphReadGateResolution {
  readonly canonicalWorkspacePath: string;
  readonly codeGraphActive: boolean;
  readonly exploredInCurrentRun: boolean;
}

export interface ResolveCodeGraphReadGateInput {
  readonly canonicalTargetPath: string;
  readonly runId?: string;
  readonly userDataPath?: string;
}

export function resolveDefaultUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANTIGRAVITY_HOOK_USER_DATA) {
    return env.ANTIGRAVITY_HOOK_USER_DATA;
  }
  let cockpitPath: string | null = null;
  if (process.platform === "win32" && env.APPDATA) {
    cockpitPath = path.join(env.APPDATA, "kins-multiagents-ui");
  } else if (process.platform === "darwin") {
    cockpitPath = path.join(os.homedir(), "Library", "Application Support", "kins-multiagents-ui");
  } else if (process.platform === "linux") {
    const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    cockpitPath = path.join(xdg, "kins-multiagents-ui");
  }

  if (cockpitPath && syncFs.existsSync(path.join(cockpitPath, "hooks", "workspaces.json"))) {
    return cockpitPath;
  }

  return path.join(os.homedir(), ".gemini", "antigravity-cli", "userData");
}

export interface EquippedPreToolUseHook {
  readonly hooksConfigPath: string;
  readonly registryPath: string;
  readonly canonicalWorkspacePath: string;
  readonly signingKey: Buffer;
}

export class PreToolUseHookService {
  static readonly HOOK_MATCHER = "replace_file_content|write_to_file|view_file";
  static readonly HOOK_IDENTIFIER = "kins-cockpit-pretooluse-guard";

  static getOrCreateSigningKeySync(userDataPath: string): Buffer {
    const hooksDir = path.join(userDataPath, "hooks");
    if (!syncFs.existsSync(hooksDir)) {
      syncFs.mkdirSync(hooksDir, { recursive: true });
    }
    const keyPath = path.join(hooksDir, "auth.key");
    try {
      return syncFs.readFileSync(keyPath);
    } catch {
      const key = crypto.randomBytes(32);
      syncFs.writeFileSync(keyPath, key, { mode: 0o600 });
      return key;
    }
  }

  static async getOrCreateSigningKey(userDataPath: string): Promise<Buffer> {
    const hooksDir = path.join(userDataPath, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    const keyPath = path.join(hooksDir, "auth.key");

    try {
      return await fs.readFile(keyPath);
    } catch {
      const key = crypto.randomBytes(32);
      await fs.writeFile(keyPath, key, { mode: 0o600 });
      return key;
    }
  }

  async equipWorkspace(options: EquipPreToolUseHookOptions): Promise<EquippedPreToolUseHook> {
    const canonicalWorkspace = canonicalizePath(options.workspaceRoot);
    const hooksDir = path.join(options.userDataPath, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });

    const signingKey = await PreToolUseHookService.getOrCreateSigningKey(options.userDataPath);

    // 1. Update <userData>/hooks/workspaces.json atomically
    const registryPath = path.join(hooksDir, "workspaces.json");
    let registry: WorkspaceRegistryFile = { version: 1, workspaces: {} };

    try {
      const content = await fs.readFile(registryPath, "utf-8");
      registry = JSON.parse(content);
      if (!registry.workspaces) {
        registry = { version: 1, workspaces: {} };
      }
    } catch {
      registry = { version: 1, workspaces: {} };
    }

    const mode: WorkspaceMutationPolicyMode = options.mutationPolicyMode ?? "strict";
    const sidecarStatePath = path.resolve(options.sidecarStatePath);
    const modeHmac = computeModeHmac(mode, canonicalWorkspace, signingKey);

    const baseEntry = {
      canonicalWorkspacePath: canonicalWorkspace,
      sidecarStatePath,
      schemaVersion: 1 as const,
      registeredAt: new Date().toISOString(),
      mutationPolicyMode: mode
    };
    const entryHmac = computeRegistryEntryHmac(baseEntry, signingKey);

    registry.workspaces[canonicalWorkspace] = {
      ...baseEntry,
      modeHmac,
      entryHmac
    };

    const tmpRegistry = `${registryPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmpRegistry, JSON.stringify(registry, null, 2), "utf-8");
    await fs.rename(tmpRegistry, registryPath);

    // 2. Resolve hooks.json config path
    const hooksConfigPath = options.hooksConfigPath ?? path.join(os.homedir(), ".gemini", "config", "hooks.json");
    await fs.mkdir(path.dirname(hooksConfigPath), { recursive: true });

    // 3. Merge PreToolUse hook into hooks.json idempotently
    let hooksData: Record<string, any> = {};
    try {
      const existing = await fs.readFile(hooksConfigPath, "utf-8");
      hooksData = JSON.parse(existing);
    } catch {
      hooksData = {};
    }

    const command = options.runtimeCommand ?? resolveDefaultRuntimeCommand();

    const ownedHookEntry = {
      matcher: PreToolUseHookService.HOOK_MATCHER,
      hooks: [
        {
          type: "command",
          command,
          timeout: 10
        }
      ]
    };

    hooksData[PreToolUseHookService.HOOK_IDENTIFIER] = {
      enabled: true,
      PreToolUse: [ownedHookEntry]
    };

    const tmpHooks = `${hooksConfigPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmpHooks, JSON.stringify(hooksData, null, 2), "utf-8");
    await fs.rename(tmpHooks, hooksConfigPath);

    return Object.freeze({
      hooksConfigPath,
      registryPath,
      canonicalWorkspacePath: canonicalWorkspace,
      signingKey
    });
  }

  async unequipWorkspace(workspaceRoot: string, userDataPath: string): Promise<void> {
    const canonicalWorkspace = canonicalizePath(workspaceRoot);
    const registryPath = path.join(userDataPath, "hooks", "workspaces.json");

    try {
      const content = await fs.readFile(registryPath, "utf-8");
      const registry: WorkspaceRegistryFile = JSON.parse(content);
      if (registry.workspaces && registry.workspaces[canonicalWorkspace]) {
        delete registry.workspaces[canonicalWorkspace];
        const tmpRegistry = `${registryPath}.${Date.now()}.tmp`;
        await fs.writeFile(tmpRegistry, JSON.stringify(registry, null, 2), "utf-8");
        await fs.rename(tmpRegistry, registryPath);
      }
    } catch {
      // Ignore missing registry
    }
  }

  static async recordCodeGraphExploration(
    workspaceRoot: string,
    runId: string,
    userDataPath: string,
    signingKey?: Buffer
  ): Promise<CodeGraphExplorationEvidence> {
    const canonicalWorkspace = canonicalizePath(workspaceRoot);
    const key = signingKey ?? (await PreToolUseHookService.getOrCreateSigningKey(userDataPath));

    const baseEvidence = {
      runId,
      canonicalWorkspacePath: canonicalWorkspace,
      completedAt: new Date().toISOString()
    };
    const evidenceHmac = computeExplorationEvidenceHmac(baseEvidence, key);
    const fullEvidence: CodeGraphExplorationEvidence = {
      ...baseEvidence,
      evidenceHmac
    };

    // Find workspace registry entry to locate sidecar state directory
    const registryPath = path.join(userDataPath, "hooks", "workspaces.json");
    try {
      const raw = await fs.readFile(registryPath, "utf-8");
      const registry: WorkspaceRegistryFile = JSON.parse(raw);
      const entry = registry.workspaces[canonicalWorkspace];
      if (entry?.sidecarStatePath) {
        const sidecarDir = path.dirname(entry.sidecarStatePath);
        await fs.mkdir(sidecarDir, { recursive: true });
        const evidencePath = path.join(sidecarDir, "codegraph-evidence.json");
        const tmpPath = `${evidencePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(fullEvidence, null, 2), "utf-8");
        await fs.rename(tmpPath, evidencePath);
      }
    } catch {
      // Fallback
    }

    const hooksEvidenceDir = path.join(userDataPath, "hooks", "evidence");
    await fs.mkdir(hooksEvidenceDir, { recursive: true });
    const fallbackPath = path.join(hooksEvidenceDir, `${runId}.json`);
    await fs.writeFile(fallbackPath, JSON.stringify(fullEvidence, null, 2), "utf-8");

    return fullEvidence;
  }

  async resolveCodeGraphReadGate(
    input: ResolveCodeGraphReadGateInput
  ): Promise<CodeGraphReadGateResolution> {
    const canonicalTarget = canonicalizePath(input.canonicalTargetPath);
    const userDataPath = input.userDataPath ?? resolveDefaultUserDataPath();
    const registryPath = path.join(userDataPath, "hooks", "workspaces.json");

    let registry: WorkspaceRegistryFile = { version: 1, workspaces: {} };
    try {
      const raw = await fs.readFile(registryPath, "utf-8");
      registry = JSON.parse(raw);
    } catch {
      return {
        canonicalWorkspacePath: "",
        codeGraphActive: false,
        exploredInCurrentRun: false
      };
    }

    // Match longest prefix workspace
    let matchedWorkspace: WorkspaceRegistryEntry | null = null;
    let longestMatchLen = -1;

    for (const [wsPath, entry] of Object.entries(registry.workspaces ?? {})) {
      const canonWs = canonicalizePath(wsPath);
      if (canonicalTarget === canonWs || canonicalTarget.startsWith(canonWs.endsWith("/") ? canonWs : `${canonWs}/`)) {
        if (canonWs.length > longestMatchLen) {
          longestMatchLen = canonWs.length;
          matchedWorkspace = entry;
        }
      }
    }

    if (!matchedWorkspace) {
      return {
        canonicalWorkspacePath: "",
        codeGraphActive: false,
        exploredInCurrentRun: false
      };
    }

    let signingKey: Buffer;
    try {
      signingKey = await PreToolUseHookService.getOrCreateSigningKey(userDataPath);
    } catch {
      return {
        canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
        codeGraphActive: true,
        exploredInCurrentRun: false
      };
    }

    if (!verifyRegistryEntryHmac(matchedWorkspace, signingKey)) {
      return {
        canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
        codeGraphActive: true,
        exploredInCurrentRun: false
      };
    }

    const codeGraphDir = path.join(matchedWorkspace.canonicalWorkspacePath, ".codegraph");
    let codeGraphActive = false;
    try {
      const stat = await fs.stat(codeGraphDir);
      codeGraphActive = stat.isDirectory();
    } catch {
      codeGraphActive = false;
    }

    if (!codeGraphActive) {
      return {
        canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
        codeGraphActive: false,
        exploredInCurrentRun: true
      };
    }

    let authoritativeRunId: string | null = null;
    try {
      const stateRaw = await fs.readFile(matchedWorkspace.sidecarStatePath, "utf-8");
      const state = JSON.parse(stateRaw);
      if (typeof state.runId === "string" && state.runId.trim()) {
        authoritativeRunId = state.runId;
      }
    } catch {
      // Cannot determine runId
    }

    if (!authoritativeRunId) {
      return {
        canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
        codeGraphActive: true,
        exploredInCurrentRun: false
      };
    }

    if (input.runId && input.runId !== authoritativeRunId) {
      return {
        canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
        codeGraphActive: true,
        exploredInCurrentRun: false
      };
    }

    let explored = false;
    // 1. Check sidecar codegraph-evidence.json
    const sidecarDir = path.dirname(matchedWorkspace.sidecarStatePath);
    const evidencePath = path.join(sidecarDir, "codegraph-evidence.json");
    try {
      const evRaw = await fs.readFile(evidencePath, "utf-8");
      const ev: CodeGraphExplorationEvidence = JSON.parse(evRaw);
      if (
        ev.runId === authoritativeRunId &&
        canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
        verifyExplorationEvidenceHmac(ev, signingKey)
      ) {
        explored = true;
      }
    } catch {
      // not found in sidecar
    }

    // 2. Check state.json property codeGraphExploration
    if (!explored) {
      try {
        const stateRaw = await fs.readFile(matchedWorkspace.sidecarStatePath, "utf-8");
        const state = JSON.parse(stateRaw);
        if (state.codeGraphExploration) {
          const ev: CodeGraphExplorationEvidence = state.codeGraphExploration;
          if (
            ev.runId === authoritativeRunId &&
            canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
            verifyExplorationEvidenceHmac(ev, signingKey)
          ) {
            explored = true;
          }
        }
      } catch {
        // not in state
      }
    }

    // 3. Check fallback userData/hooks/evidence/<authoritativeRunId>.json
    if (!explored) {
      const fallbackPath = path.join(userDataPath, "hooks", "evidence", `${authoritativeRunId}.json`);
      try {
        const evRaw = await fs.readFile(fallbackPath, "utf-8");
        const ev: CodeGraphExplorationEvidence = JSON.parse(evRaw);
        if (
          ev.runId === authoritativeRunId &&
          canonicalizePath(ev.canonicalWorkspacePath) === matchedWorkspace.canonicalWorkspacePath &&
          verifyExplorationEvidenceHmac(ev, signingKey)
        ) {
          explored = true;
        }
      } catch {
        // not found
      }
    }

    return {
      canonicalWorkspacePath: matchedWorkspace.canonicalWorkspacePath,
      codeGraphActive: true,
      exploredInCurrentRun: explored
    };
  }

  // ==============================================================================
  // IMMORTAL STEALTH RULES ENFORCEMENT & ATTENTION ANCHORING
  // ==============================================================================
  private static readonly activeStealthRules = new Map<string, ActiveStealthRules>();

  static readonly BANNED_LEGACY_HEXES: readonly string[] = Object.freeze([
    "#000000",
    "#0c0c0c",
    "#0a0a0a",
    "#0d0d0d",
    "#0f0f10",
    "#0d0d0e",
    "#111113",
    "#141414",
    "#141418",
    "#181820",
    "#1a1a1e",
    "#1a1a22",
    "#1e1e24",
    "#20202a",
    "#16161d"
  ]);

  registerActiveStealthRules(workspaceId: string, rules: ActiveStealthRules): void {
    PreToolUseHookService.activeStealthRules.set(workspaceId, rules);
  }

  unregisterActiveStealthRules(workspaceId: string): void {
    PreToolUseHookService.activeStealthRules.delete(workspaceId);
  }

  static getAllActiveStealthRules(): ReadonlyMap<string, ActiveStealthRules> {
    return PreToolUseHookService.activeStealthRules;
  }

  static findActiveStealthRulesForPath(targetOrWorkspacePath?: string): ActiveStealthRules | undefined {
    if (!targetOrWorkspacePath) return undefined;
    const canon = canonicalizePath(targetOrWorkspacePath);

    const exact = PreToolUseHookService.activeStealthRules.get(targetOrWorkspacePath);
    if (exact) return exact;

    for (const [wsId, rules] of PreToolUseHookService.activeStealthRules.entries()) {
      const canonWs = canonicalizePath(wsId);
      if (canon === canonWs || canon.startsWith(canonWs.endsWith("/") ? canonWs : `${canonWs}/`)) {
        return rules;
      }
      for (const p of rules.protectedPaths) {
        const canonP = canonicalizePath(p);
        if (
          canonP === canon ||
          canonP.startsWith(canon.endsWith("/") ? canon : `${canon}/`) ||
          canon.startsWith(canonP.endsWith("/") ? canonP : `${canonP}/`)
        ) {
          return rules;
        }
      }
    }
    return undefined;
  }

  getActiveStealthRules(workspaceId: string): ActiveStealthRules | undefined {
    return PreToolUseHookService.activeStealthRules.get(workspaceId);
  }

  getAttentionAnchor(workspaceId: string): string | undefined {
    const rules = PreToolUseHookService.activeStealthRules.get(workspaceId);
    if (!rules) return undefined;

    const protectedSummary = rules.protectedPaths.length > 0
      ? rules.protectedPaths.map((p) => path.basename(p)).join(", ")
      : ".eval/*";

    return (
      `${STEALTH_TRANSPARENCY_TAG} Active Revision: ${rules.policyRevision} | ` +
      `Enforcing: UI Zinc Palette, Protected Paths (${protectedSummary}), Zero Git Diff. ` +
      `All filesystem mutations are host-monitored. Prohibited actions will be blocked at pre-tool gate.`
    );
  }

  private static readonly verifiedRevisions = new Set<string>();

  recordVerificationSuccess(workspaceId: string, revision?: string): void {
    const rev = revision ?? PreToolUseHookService.activeStealthRules.get(workspaceId)?.policyRevision ?? "default";
    PreToolUseHookService.verifiedRevisions.add(`${workspaceId}:${rev}`);
  }

  invalidateVerification(workspaceId: string): void {
    const rules = PreToolUseHookService.activeStealthRules.get(workspaceId);
    const rev = rules?.policyRevision ?? "default";
    PreToolUseHookService.verifiedRevisions.delete(`${workspaceId}:${rev}`);
  }

  isVerificationFresh(workspaceId: string): boolean {
    const rules = PreToolUseHookService.activeStealthRules.get(workspaceId);
    const rev = rules?.policyRevision ?? "default";
    return PreToolUseHookService.verifiedRevisions.has(`${workspaceId}:${rev}`);
  }

  evaluateStealthPolicy(request: StealthEvaluationRequest): StealthEvaluationDecision {
    const rules = PreToolUseHookService.activeStealthRules.get(request.workspaceId);
    const violations: StealthViolation[] = [];

    const normTarget = request.targetPath ? request.targetPath.replace(/\\/g, "/") : "";

    // 1. Invariant: .eval/ is strictly read-only always
    if (normTarget && (normTarget.includes(".eval/") || normTarget.endsWith(".eval"))) {
      violations.push({
        code: "PROTECTED_PATH",
        message: "Modification of protected path .eval/ is strictly forbidden.",
        remediation: "Never edit, relax, or delete golden assertions in .eval/."
      });
    }

    // 2. Active stealth protected paths
    if (rules && normTarget) {
      for (const p of rules.protectedPaths) {
        const normP = p.replace(/\\/g, "/");
        if (normTarget === normP || normTarget.endsWith(normP) || normTarget.startsWith(normP)) {
          violations.push({
            code: "PROTECTED_PATH",
            message: `Target path "${request.targetPath}" is protected under active stealth rules.`,
            remediation: `Do not modify stealth-protected path "${request.targetPath}".`
          });
          break;
        }
      }
    }

    // 3. Legacy Color Introduction Check
    if (
      rules?.includeDesignPack &&
      request.projectedContent &&
      normTarget &&
      (normTarget.endsWith(".tsx") || normTarget.endsWith(".jsx") || normTarget.endsWith(".css")) &&
      !normTarget.includes("TerminalStage.tsx")
    ) {
      for (const banned of PreToolUseHookService.BANNED_LEGACY_HEXES) {
        if (request.projectedContent.includes(banned)) {
          violations.push({
            code: "LEGACY_COLOR",
            message: `Prohibited legacy color hex "${banned}" introduced in UI file.`,
            remediation: "Replace with approved Zinc tokens (bg-zinc-950, bg-zinc-900, bg-zinc-800, border-zinc-800, text-zinc-100)."
          });
          break;
        }
      }
    }

    // 4. Verification Required on Release Action
    if (rules && request.isReleaseAction) {
      if (!this.isVerificationFresh(request.workspaceId)) {
        violations.push({
          code: "VERIFICATION_REQUIRED",
          message: "Release action blocked: Verification suite has not confirmed passing status for current code revision.",
          remediation: "Execute local tests and verification commands before releasing."
        });
      }
    }

    // 5. Unsupported Opaque Tool
    if (rules && (request.toolName === "bash" || request.toolName === "run_command" || request.toolName === "run_command_opaque")) {
      violations.push({
        code: "UNSUPPORTED_TOOL",
        message: `Tool "${request.toolName}" is an unsupported opaque mutation under active stealth rules.`,
        remediation: "Use standard surgical file editing tools (replace_file_content, write_to_file) or sandboxed execution."
      });
    }

    const metadata: StealthDecisionMetadata = {
      transparencyTag: STEALTH_TRANSPARENCY_TAG,
      workspaceId: request.workspaceId,
      policyRevision: rules?.policyRevision ?? "default",
      violations: Object.freeze(violations)
    };

    if (violations.length > 0) {
      const denialMessage = (
        `${STEALTH_TRANSPARENCY_TAG} Denied: ${violations.map((v) => v.message).join(" ")} ` +
        `Remediation: ${violations.map((v) => v.remediation).join(" ")}`
      );
      return {
        allowed: false,
        metadata,
        denialMessage
      };
    }

    return {
      allowed: true,
      metadata
    };
  }

  async executeToolUse<T>(
    request: StealthEvaluationRequest,
    invoke: () => Promise<T>
  ): Promise<T> {
    const decision = this.evaluateStealthPolicy(request);
    if (!decision.allowed) {
      throw new Error(decision.denialMessage ?? `${STEALTH_TRANSPARENCY_TAG} Tool execution denied by stealth gatekeeper.`);
    }
    // Any successful file modification invalidates prior verification evidence
    if (request.targetPath) {
      this.invalidateVerification(request.workspaceId);
    }
    return await invoke();
  }

  async executeBatchToolUse<T>(
    requests: readonly StealthEvaluationRequest[],
    invoke: () => Promise<T[]>
  ): Promise<T[]> {
    for (const req of requests) {
      const decision = this.evaluateStealthPolicy(req);
      if (!decision.allowed) {
        const detail = decision.denialMessage ?? "Prohibited target in batch.";
        throw new Error(`${STEALTH_TRANSPARENCY_TAG} Batch execution denied: Prohibited target in batch. ${detail}`);
      }
    }
    for (const req of requests) {
      if (req.targetPath) {
        this.invalidateVerification(req.workspaceId);
      }
    }
    return await invoke();
  }
}
