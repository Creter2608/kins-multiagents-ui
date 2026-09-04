/**
 * scripts/harness/sandbox.d.mts
 * TypeScript contracts for the Ephemeral Sandboxing & Container Lifecycle engine.
 */

import type { NetworkPolicy } from "../../src/shared/harness.js";

export interface SandboxMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean | undefined;
}

export interface SandboxOptions {
  readonly image?: string | undefined;
  readonly memoryLimit?: string | undefined;
  readonly cpuLimit?: number | undefined;
  readonly pidsLimit?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly network?: string | undefined;
  readonly workdir?: string | undefined;
  readonly mounts?: readonly SandboxMount[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly fallbackToProcess?: boolean | undefined;
  readonly strictIsolation?: boolean | undefined;
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly enableBrowser?: boolean | undefined;
}

export interface SandboxConfig {
  readonly runId: string;
  readonly sanitizedRunId: string;
  readonly containerName: string;
  readonly image: string;
  readonly memoryLimit: string;
  readonly cpuLimit: number;
  readonly pidsLimit: number;
  readonly timeoutMs: number;
  readonly network: string;
  readonly workdir: string;
  readonly mounts: readonly SandboxMount[];
  readonly env: Readonly<Record<string, string>>;
  readonly fallbackToProcess: boolean;
  readonly strictIsolation: boolean;
  readonly networkPolicy: NetworkPolicy;
  readonly enableBrowser: boolean;
}


export interface SandboxInstance {
  readonly runId: string;
  readonly containerName: string;
  readonly containerId?: string | undefined;
  readonly status: "Active" | "Stopped" | "Missing" | "Unavailable" | "Fallback";
  readonly mode: "docker" | "process";
  readonly config: SandboxConfig;
  readonly workspacePath?: string | undefined;
  readonly ownedPaths: readonly string[];
}

export interface ExecOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface TeardownOptions {
  readonly timeoutMs?: number | undefined;
}

export interface TeardownResult {
  readonly success: boolean;
  readonly status: "Stopped" | "Missing" | "Unavailable";
  readonly removedContainer: boolean;
  readonly removedPaths: readonly string[];
  readonly errors: readonly string[];
}

export function sanitizeRunId(runId: string): string;

export function getSandboxConfig(
  runId: string,
  options?: Partial<SandboxOptions>
): SandboxConfig;

export function buildDockerRunArgs(config: SandboxConfig): string[];

export function isDockerAvailable(): Promise<boolean>;

export function spawnEphemeralSandbox(
  config: SandboxConfig
): Promise<SandboxInstance>;

export function execInSandbox(
  instance: SandboxInstance,
  command: string[],
  options?: ExecOptions
): Promise<ExecResult>;

export function teardownEphemeralSandbox(
  instance: SandboxInstance,
  options?: TeardownOptions
): Promise<TeardownResult>;
