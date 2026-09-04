import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectInfo, ProjectState } from "../../shared/contracts.js";

export interface ProjectScopedServices {
  readonly ptyService: { setProjectRoot(p: string): Promise<void> };
  readonly loopStateService: { setProjectRoot(p: string): Promise<void> };
  readonly mcpMonitorService: { setProjectRoot(p: string): Promise<void> };
  readonly rollbackService: { setProjectRoot(p: string): Promise<void> };
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

    // Re-point all services in deterministic order
    await this.services.ptyService.setProjectRoot(this.currentPath);
    await this.services.loopStateService.setProjectRoot(this.currentPath);
    await this.services.mcpMonitorService.setProjectRoot(this.currentPath);
    await this.services.rollbackService.setProjectRoot(this.currentPath);

    this.persist();
    return this.getState();
  }

  async switchProject(targetPath: string): Promise<ProjectState> {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Directory does not exist or is not a directory: ${targetPath}`);
    }

    // Re-point all services in deterministic order
    await this.services.ptyService.setProjectRoot(resolved);
    await this.services.loopStateService.setProjectRoot(resolved);
    await this.services.mcpMonitorService.setProjectRoot(resolved);
    await this.services.rollbackService.setProjectRoot(resolved);

    this.currentPath = resolved;
    this.recentPaths = [
      resolved,
      ...this.recentPaths.filter((p) => p !== resolved)
    ];

    this.persist();
    return this.getState();
  }
}
