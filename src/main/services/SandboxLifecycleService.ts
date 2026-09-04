/**
 * src/main/services/SandboxLifecycleService.ts
 * Manages observation of the ephemeral sandbox lifecycle from .ai/state.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DockerSandboxStatus } from "../../shared/contracts.js";

export class SandboxLifecycleService {
  private stateFilePath: string;
  private currentStatus: DockerSandboxStatus = "Unavailable";
  private listeners = new Set<(status: DockerSandboxStatus) => void>();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(stateFilePath: string) {
    this.stateFilePath = path.resolve(stateFilePath);
  }

  getStatus(): DockerSandboxStatus {
    return this.currentStatus;
  }

  start(): void {
    this.readState();
    this.startWatching();
  }

  readState(): DockerSandboxStatus {
    if (!fs.existsSync(this.stateFilePath)) {
      this.updateStatus("Unavailable");
      return this.currentStatus;
    }

    try {
      const content = fs.readFileSync(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(content) as {
        sandbox?: {
          instance?: {
            status?: DockerSandboxStatus;
            mode?: "docker" | "process";
          } | null;
          teardown?: {
            status?: DockerSandboxStatus;
          } | null;
        };
      };

      if (parsed.sandbox?.teardown?.status) {
        this.updateStatus(parsed.sandbox.teardown.status);
      } else if (parsed.sandbox?.instance?.status) {
        this.updateStatus(parsed.sandbox.instance.status);
      } else if (parsed.sandbox?.instance?.mode === "process") {
        this.updateStatus("Fallback");
      } else {
        this.updateStatus("Missing");
      }
    } catch {
      this.updateStatus("Unavailable");
    }

    return this.currentStatus;
  }

  private updateStatus(newStatus: DockerSandboxStatus): void {
    if (this.currentStatus !== newStatus) {
      this.currentStatus = newStatus;
      for (const listener of this.listeners) {
        try {
          listener(this.currentStatus);
        } catch (err) {
          console.error("[SandboxLifecycleService] Listener error:", err);
        }
      }
    }
  }

  subscribe(listener: (status: DockerSandboxStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  private startWatching(): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return;
      }
    }

    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === path.basename(this.stateFilePath)) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.readState();
          }, 100);
        }
      });
    } catch (err) {
      console.warn("[SandboxLifecycleService] Could not watch state directory:", err);
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.listeners.clear();
  }
}
