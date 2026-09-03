import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerSandboxStatus } from "../../shared/contracts.js";

const execFileAsync = promisify(execFile);

export function mapDockerState(runningOutput: string, exitCode: number): DockerSandboxStatus {
  if (exitCode !== 0) {
    const lower = runningOutput.toLowerCase();
    if (lower.includes("no such object") || lower.includes("not found") || lower.includes("cannot find")) {
      return "Missing";
    }
    return "Unavailable";
  }

  const trimmed = runningOutput.trim().toLowerCase();
  // Assertion 5: {"in":"Docker inspect=false","out":"Stopped, not Active or Missing"}
  if (trimmed === "true") {
    return "Active";
  }
  if (trimmed === "false") {
    return "Stopped";
  }
  return "Unavailable";
}

export class DockerStatusService {
  private containerName: string;
  private currentStatus: DockerSandboxStatus = "Unavailable";
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(status: DockerSandboxStatus) => void>();

  constructor(containerName: string = "kins_autonomous_sandbox", pollIntervalMs: number = 3000) {
    this.containerName = containerName;
    this.pollIntervalMs = pollIntervalMs;
  }

  getStatus(): DockerSandboxStatus {
    return this.currentStatus;
  }

  async checkStatus(): Promise<DockerSandboxStatus> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        this.containerName
      ], { windowsHide: true, timeout: 4000 });
      this.currentStatus = mapDockerState(stdout, 0);
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      const output = (execErr.stderr || execErr.stdout || String(err));
      this.currentStatus = mapDockerState(output, execErr.code ?? 1);
    }

    for (const listener of this.listeners) {
      listener(this.currentStatus);
    }

    return this.currentStatus;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.checkStatus();
    this.timer = setInterval(() => {
      void this.checkStatus();
    }, this.pollIntervalMs);
  }

  subscribe(listener: (status: DockerSandboxStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }
}
