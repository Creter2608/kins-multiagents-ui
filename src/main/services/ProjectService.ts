import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ProjectInfo,
  ProjectState,
  GlobalIdeTarget,
  GlobalIdeSyncResult,
  StealthRuleTarget,
  StealthEquipResult,
  StealthUnequipResult,
  WorkspaceStealthStatus
} from "../../shared/contracts.js";
import {
  type WorkspaceContext,
  type WorkspaceRecord
} from "./workspaceContext.js";
import { WorkspaceRegistryService } from "./workspaceRegistryService.js";
import { RuleResolverService } from "./ruleResolverService.js";
import { ProjectSandboxService } from "./projectSandboxService.js";
import { RuleBundleCompilerService } from "./ruleBundleCompilerService.js";
import { GlobalIdeSyncService } from "./globalIdeSyncService.js";
import { WorkspaceStealthRuleService } from "./workspaceStealthRuleService.js";
import { PreToolUseHookService } from "./preToolUseHookService.js";
import type { WorkspaceMutationPolicyMode } from "../../shared/workspaceMutationPolicy.js";

export interface ProjectScopedServices {
  readonly ptyService: {
    setProjectRoot(p: string): Promise<void>;
    setWorkspaceContext?(ctx: WorkspaceContext): void;
  };
  readonly loopStateService: {
    setProjectRoot(p: string, sidecarDirectory?: string): Promise<void>;
  };
  readonly mcpMonitorService: { setProjectRoot(p: string): Promise<void> };
  readonly rollbackService: {
    setProjectRoot(p: string, sidecarDirectory?: string): Promise<void>;
  };
  readonly evalHarnessService?: { setProjectRoot(p: string): Promise<void> };
  readonly telemetryService?: { resetCurrentSession(): void };
  readonly transcriptService?: { setProjectRoot(p: string): Promise<void>; reset?(): void };
  readonly subagentService?: { reset(): void };
  readonly logService?: { clearLogs(): void };
  readonly registryService?: WorkspaceRegistryService;
  readonly ruleResolverService?: RuleResolverService;
  readonly sandboxService?: ProjectSandboxService;
  readonly globalIdeSyncService?: GlobalIdeSyncService;
  readonly stealthRuleService?: WorkspaceStealthRuleService;
  readonly preToolUseHookService?: PreToolUseHookService;
}

interface PersistedProjectState {
  currentProjectPath: string;
  recentProjects: string[];
}

export class ProjectService {
  private configFilePath: string;
  private defaultProjectPath: string;
  private services: ProjectScopedServices;
  private currentPath: string;
  private recentPaths: string[] = [];
  private onProjectSwitchedCallback: ((state: ProjectState) => void) | null = null;
  private onWorkspaceContextChangedCallback: ((context: WorkspaceContext) => void) | null = null;
  private registryService: WorkspaceRegistryService;
  private ruleResolverService: RuleResolverService;
  private sandboxService: ProjectSandboxService;
  private globalIdeSyncService: GlobalIdeSyncService;
  private stealthRuleService: WorkspaceStealthRuleService;
  private preToolUseHookService: PreToolUseHookService | null = null;
  private mutationPolicyMode: WorkspaceMutationPolicyMode = "documentation-fast-path";
  private activeContext: WorkspaceContext | null = null;
  private isSwitching = false;
  private switchGeneration = 0;

  constructor(
    configFilePath: string,
    defaultProjectPath: string,
    services: ProjectScopedServices
  ) {
    this.configFilePath = configFilePath;
    this.defaultProjectPath = path.resolve(defaultProjectPath);
    this.services = services;
    this.currentPath = this.defaultProjectPath;
    this.recentPaths = [this.defaultProjectPath];

    const userDataDir = path.dirname(this.configFilePath);
    this.registryService = services.registryService ?? new WorkspaceRegistryService(userDataDir);
    this.ruleResolverService = services.ruleResolverService ?? new RuleResolverService();
    this.sandboxService = services.sandboxService ?? new ProjectSandboxService();

    const compiler = new RuleBundleCompilerService();
    this.globalIdeSyncService = services.globalIdeSyncService ?? new GlobalIdeSyncService(compiler);
    this.stealthRuleService = services.stealthRuleService ?? new WorkspaceStealthRuleService(compiler);
    this.preToolUseHookService = services.preToolUseHookService ?? null;
  }

  getMutationPolicyMode(): WorkspaceMutationPolicyMode {
    return this.mutationPolicyMode;
  }

  setMutationPolicyMode(mode: WorkspaceMutationPolicyMode): void {
    this.mutationPolicyMode = mode;
  }

  private toProjectInfo(dirPath: string): ProjectInfo {
    const resolved = path.resolve(dirPath);
    return {
      name: path.basename(resolved) || resolved,
      path: resolved
    };
  }

  getState(): ProjectState {
    return {
      currentProject: this.toProjectInfo(this.currentPath),
      recentProjects: this.recentPaths.map((p) => this.toProjectInfo(p))
    };
  }

  getWorkspaceContext(): WorkspaceContext | null {
    return this.activeContext;
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.configFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload: PersistedProjectState = {
        currentProjectPath: this.currentPath,
        recentProjects: this.recentPaths
      };

      const tmpFile = `${this.configFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpFile, this.configFilePath);
    } catch (err) {
      console.error("[ProjectService] Failed to persist recent projects:", err);
    }
  }

  setOnProjectSwitched(callback: (state: ProjectState) => void): void {
    this.onProjectSwitchedCallback = callback;
  }

  setOnWorkspaceContextChanged(callback: (context: WorkspaceContext) => void): void {
    this.onWorkspaceContextChangedCallback = callback;
  }

  async syncGlobalIdeRules(options?: { targets?: readonly GlobalIdeTarget[] }): Promise<GlobalIdeSyncResult> {
    return this.globalIdeSyncService.sync(options);
  }

  async equipStealthRules(options?: { targets?: readonly StealthRuleTarget[] }): Promise<StealthEquipResult> {
    if (!this.activeContext) {
      throw new Error("Cannot equip stealth rules: No active workspace context");
    }
    return this.stealthRuleService.equip(this.activeContext, options);
  }

  async unequipStealthRules(): Promise<StealthUnequipResult> {
    if (!this.activeContext) {
      throw new Error("Cannot unequip stealth rules: No active workspace context");
    }
    return this.stealthRuleService.unequip(this.activeContext);
  }

  async getStealthStatus(): Promise<WorkspaceStealthStatus> {
    if (!this.activeContext) {
      return { equipped: false, excluded: false, files: [] };
    }
    return this.stealthRuleService.getStatus(this.activeContext);
  }

  async initialize(): Promise<ProjectState> {
    let loadedCurrent = this.defaultProjectPath;
    let loadedRecents: string[] = [];

    if (fs.existsSync(this.configFilePath)) {
      try {
        const raw = fs.readFileSync(this.configFilePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PersistedProjectState>;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.currentProjectPath === "string") {
            const resolved = path.resolve(parsed.currentProjectPath);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
              loadedCurrent = resolved;
            }
          }
          if (Array.isArray(parsed.recentProjects)) {
            for (const item of parsed.recentProjects) {
              if (typeof item === "string") {
                const resolved = path.resolve(item);
                if (
                  fs.existsSync(resolved) &&
                  fs.statSync(resolved).isDirectory() &&
                  !loadedRecents.includes(resolved)
                ) {
                  loadedRecents.push(resolved);
                }
              }
            }
          }
        }
      } catch {
        // Fallback gracefully on malformed config
        loadedCurrent = this.defaultProjectPath;
        loadedRecents = [];
      }
    }

    this.currentPath = loadedCurrent;
    this.recentPaths = [
      this.currentPath,
      ...loadedRecents.filter((p) => p !== this.currentPath)
    ];

    // Build initial WorkspaceContext
    try {
      const record = await this.registryService.resolve(this.currentPath);
      const sidecarDir = this.registryService.getSidecarDirectory(record.id);
      const userDataDir = path.dirname(this.configFilePath);
      const rules = await this.ruleResolverService.resolve({
        workspace: record,
        userDataDirectory: userDataDir,
        sidecarDirectory: sidecarDir
      });

      this.activeContext = {
        id: record.id,
        root: record.root,
        displayName: record.displayName,
        sidecarDirectory: sidecarDir,
        rules
      };

      await this.sandboxService.prepare(this.activeContext);
      if (this.preToolUseHookService) {
        const sidecarStatePath = path.join(sidecarDir, "state.json");
        await this.preToolUseHookService.equipWorkspace({
          workspaceRoot: this.currentPath,
          sidecarStatePath,
          userDataPath: userDataDir,
          mutationPolicyMode: this.mutationPolicyMode
        });
      }
    } catch {
      // Non-fatal: proceed with default workspace context
    }

    // Re-point all services in deterministic order
    await this.services.ptyService.setProjectRoot(this.currentPath);
    if (this.activeContext) {
      this.services.ptyService.setWorkspaceContext?.(this.activeContext);
    }
    await this.services.loopStateService.setProjectRoot(this.currentPath, this.activeContext?.sidecarDirectory);
    await this.services.mcpMonitorService.setProjectRoot(this.currentPath);
    await this.services.rollbackService.setProjectRoot(this.currentPath, this.activeContext?.sidecarDirectory);
    if (this.services.evalHarnessService) {
      await this.services.evalHarnessService.setProjectRoot(this.currentPath);
    }
    if (this.services.transcriptService) {
      await this.services.transcriptService.setProjectRoot(this.currentPath);
    }

    this.persist();
    if (this.activeContext) {
      this.onWorkspaceContextChangedCallback?.(this.activeContext);
    }
    return this.getState();
  }

  async switchProject(targetPath: string): Promise<ProjectState> {
    if (this.isSwitching) {
      throw new Error("Project switch is already in progress");
    }

    const currentGen = ++this.switchGeneration;
    this.isSwitching = true;
    const previousPath = this.currentPath;
    const previousContext = this.activeContext;
    let servicesTouched = false;

    try {
      // 1. Validate & resolve canonical workspace record
      const record = await this.registryService.resolve(targetPath);
      if (this.switchGeneration !== currentGen) {
        throw new Error("Project switch superseded by newer request");
      }
      const canonicalRoot = record.root;
      const sidecarDir = this.registryService.getSidecarDirectory(record.id);
      const userDataDir = path.dirname(this.configFilePath);

      // 2. Resolve rules with provenance & precedence (100% read-only, zero target pollution)
      const rules = await this.ruleResolverService.resolve({
        workspace: record,
        userDataDirectory: userDataDir,
        sidecarDirectory: sidecarDir
      });
      if (this.switchGeneration !== currentGen) {
        throw new Error("Project switch superseded by newer request");
      }

      const candidateContext: WorkspaceContext = {
        id: record.id,
        root: canonicalRoot,
        displayName: record.displayName,
        sidecarDirectory: sidecarDir,
        rules
      };

      // 3. Prepare sandbox and equip hook for the candidate workspace
      await this.sandboxService.prepare(candidateContext);
      if (this.switchGeneration !== currentGen) {
        throw new Error("Project switch superseded by newer request");
      }

      if (this.preToolUseHookService) {
        const candidateStatePath = path.join(sidecarDir, "state.json");
        await this.preToolUseHookService.equipWorkspace({
          workspaceRoot: canonicalRoot,
          sidecarStatePath: candidateStatePath,
          userDataPath: userDataDir,
          mutationPolicyMode: this.mutationPolicyMode
        });
      }

      // 4. Re-anchor all dependent services atomically
      servicesTouched = true;
      await this.services.ptyService.setProjectRoot(canonicalRoot);
      this.services.ptyService.setWorkspaceContext?.(candidateContext);
      await this.services.loopStateService.setProjectRoot(canonicalRoot, sidecarDir);
      await this.services.mcpMonitorService.setProjectRoot(canonicalRoot);
      await this.services.rollbackService.setProjectRoot(canonicalRoot, sidecarDir);
      if (this.services.evalHarnessService) {
        await this.services.evalHarnessService.setProjectRoot(canonicalRoot);
      }
      if (this.services.transcriptService) {
        await this.services.transcriptService.setProjectRoot(canonicalRoot);
      }

      // 5. Commit state transaction
      this.currentPath = canonicalRoot;
      this.activeContext = candidateContext;
      this.recentPaths = [
        canonicalRoot,
        ...this.recentPaths.filter((p) => p !== canonicalRoot)
      ];

      this.services.telemetryService?.resetCurrentSession();
      this.services.transcriptService?.reset?.();
      this.services.subagentService?.reset();
      this.services.logService?.clearLogs();

      this.persist();

      // Unequip old workspace after successful commit
      if (this.preToolUseHookService && previousPath !== canonicalRoot) {
        try {
          await this.preToolUseHookService.unequipWorkspace(previousPath, userDataDir);
        } catch {
          // Best-effort cleanup of previous workspace hook
        }
      }

      const state = this.getState();
      this.onProjectSwitchedCallback?.(state);
      this.onWorkspaceContextChangedCallback?.(candidateContext);
      return state;
    } catch (err) {
      const userDataDir = path.dirname(this.configFilePath);
      if (this.preToolUseHookService) {
        try {
          // If candidate failed, unequip it
          const record = await this.registryService.resolve(targetPath).catch(() => null);
          const candidateRoot = record?.root ?? targetPath;
          if (candidateRoot !== previousPath) {
            await this.preToolUseHookService.unequipWorkspace(candidateRoot, userDataDir);
          }
        } catch (rollbackHookErr) {
          console.error("[ProjectService] Failed to unequip candidate workspace hook on failure:", rollbackHookErr);
        }
      }

      // Transactional rollback to previous context if services were touched
      if (servicesTouched && previousContext) {
        try {
          await this.sandboxService.prepare(previousContext);
          await this.services.ptyService.setProjectRoot(previousPath);
          this.services.ptyService.setWorkspaceContext?.(previousContext);
          await this.services.loopStateService.setProjectRoot(previousPath, previousContext.sidecarDirectory);
          await this.services.mcpMonitorService.setProjectRoot(previousPath);
          await this.services.rollbackService.setProjectRoot(previousPath, previousContext.sidecarDirectory);
          if (this.services.evalHarnessService) {
            await this.services.evalHarnessService.setProjectRoot(previousPath);
          }
          if (this.services.transcriptService) {
            await this.services.transcriptService.setProjectRoot(previousPath);
          }
          this.currentPath = previousPath;
          this.activeContext = previousContext;
          this.onWorkspaceContextChangedCallback?.(previousContext);
        } catch (rollbackErr) {
          console.error("[ProjectService] Failed to rollback project switch:", rollbackErr);
        }
      }
      throw err;
    } finally {
      this.isSwitching = false;
    }
  }
}
