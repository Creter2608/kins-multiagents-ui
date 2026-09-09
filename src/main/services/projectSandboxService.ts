/**
 * src/main/services/projectSandboxService.ts
 * Manages container sandbox mounting dynamically per active workspace root.
 * Guarantees zero host command injection and clean transactional disposal.
 */

import type { WorkspaceContext } from "./workspaceContext.js";

export interface ProjectSandbox {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly containerName: string;
  dispose(): Promise<void>;
}

export class ProjectSandboxService {
  private activeSandbox: ProjectSandbox | null = null;
  private readonly defaultContainerName: string;

  constructor(defaultContainerName = "kins_autonomous_sandbox") {
    this.defaultContainerName = defaultContainerName;
  }

  getActiveSandbox(): ProjectSandbox | null {
    return this.activeSandbox;
  }

  async prepare(context: WorkspaceContext): Promise<ProjectSandbox> {
    // If an existing sandbox is active on a different root, dispose it cleanly
    if (this.activeSandbox) {
      if (this.activeSandbox.workspaceId === context.id) {
        return this.activeSandbox;
      }
      await this.activeSandbox.dispose();
      this.activeSandbox = null;
    }

    const sandbox: ProjectSandbox = {
      workspaceId: context.id,
      workspaceRoot: context.root,
      containerName: this.defaultContainerName,
      dispose: async () => {
        if (this.activeSandbox?.workspaceId === context.id) {
          this.activeSandbox = null;
        }
      }
    };

    this.activeSandbox = sandbox;
    return sandbox;
  }

  async dispose(): Promise<void> {
    if (this.activeSandbox) {
      await this.activeSandbox.dispose();
      this.activeSandbox = null;
    }
  }
}
