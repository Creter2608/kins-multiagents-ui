/**
 * src/main/services/preToolUseHookService.ts
 * Manages Antigravity CLI PreToolUse hook configuration and workspace registration.
 * Completely decoupled from target repositories (zero foreign repo pollution).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { canonicalizePath } from "./blueprintApprovalAuthenticator.js";
import type { WorkspaceMutationPolicyMode } from "../../shared/workspaceMutationPolicy.js";

export function computeModeHmac(
  mode: WorkspaceMutationPolicyMode,
  canonicalWorkspace: string,
  signingKey: Buffer
): string {
  return crypto
    .createHmac("sha256", signingKey)
    .update(`${canonicalWorkspace}:${mode}`)
    .digest("hex");
}

export function verifyModeHmac(
  mode: WorkspaceMutationPolicyMode,
  canonicalWorkspace: string,
  modeHmac: string | undefined,
  signingKey: Buffer
): boolean {
  if (!modeHmac || typeof modeHmac !== "string") return false;
  const expected = computeModeHmac(mode, canonicalWorkspace, signingKey);
  if (expected.length !== modeHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(modeHmac, "hex"));
}

export function computeRegistryEntryHmac(
  entry: {
    readonly canonicalWorkspacePath: string;
    readonly sidecarStatePath: string;
    readonly schemaVersion: number;
    readonly mutationPolicyMode?: WorkspaceMutationPolicyMode;
  },
  signingKey: Buffer
): string {
  const payload = [
    entry.canonicalWorkspacePath,
    entry.sidecarStatePath,
    entry.mutationPolicyMode ?? "strict",
    String(entry.schemaVersion)
  ].join("::");
  return crypto.createHmac("sha256", signingKey).update(payload).digest("hex");
}

export function verifyRegistryEntryHmac(
  entry: WorkspaceRegistryEntry,
  signingKey: Buffer
): boolean {
  if (!entry.entryHmac || typeof entry.entryHmac !== "string") return false;
  const expected = computeRegistryEntryHmac(entry, signingKey);
  if (expected.length !== entry.entryHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(entry.entryHmac, "hex"));
}

export interface WorkspaceRegistryEntry {
  readonly canonicalWorkspacePath: string;
  readonly sidecarStatePath: string;
  readonly schemaVersion: 1;
  readonly registeredAt: string;
  readonly mutationPolicyMode?: WorkspaceMutationPolicyMode;
  readonly modeHmac?: string;
  readonly entryHmac?: string;
}

export interface WorkspaceRegistryFile {
  readonly version: 1;
  readonly workspaces: Record<string, WorkspaceRegistryEntry>;
}

export interface EquipPreToolUseHookOptions {
  readonly workspaceRoot: string;
  readonly sidecarStatePath: string;
  readonly userDataPath: string;
  readonly runtimeCommand?: string | undefined;
  readonly hooksConfigPath?: string | undefined;
  readonly mutationPolicyMode?: WorkspaceMutationPolicyMode | undefined;
}

export interface EquippedPreToolUseHook {
  readonly hooksConfigPath: string;
  readonly registryPath: string;
  readonly canonicalWorkspacePath: string;
  readonly signingKey: Buffer;
}

export class PreToolUseHookService {
  static readonly HOOK_MATCHER = "replace_file_content|write_to_file";
  static readonly HOOK_IDENTIFIER = "kins-cockpit-pretooluse-guard";

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

    const command = options.runtimeCommand ?? `node "${path.resolve(options.userDataPath, "../dist/src/cli/preToolUseHook.js")}"`;

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
}
