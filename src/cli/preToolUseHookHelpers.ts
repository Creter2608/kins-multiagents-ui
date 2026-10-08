/**
 * src/cli/preToolUseHookHelpers.ts
 * Helper types, command-line argument parsing, and token estimation
 * for Antigravity CLI PreToolUse Hook.
 */

import * as syncFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface MutationAuthorization {
  readonly version: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly phase: "EXECUTE";
  readonly blueprintDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly signature: string;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "MALFORMED"
        | "BAD_SIGNATURE"
        | "NO_ACTIVE_SESSION"
        | "SESSION_MISMATCH"
        | "WORKSPACE_MISMATCH"
        | "STALE_REVISION"
        | "EXPIRED"
        | "PHASE_DENIED"
        | "APPROVAL_MISMATCH"
        | "PROTECTED_TARGET";
    };

export interface ExistingMutationTarget {
  readonly canonicalPath: string;
  readonly isProtectedTarget?: boolean;
}

export interface PreToolUseHookInput {
  readonly toolCall?: {
    readonly name?: string;
    readonly args?: {
      readonly TargetFile?: string;
      readonly targetFile?: string;
      readonly AbsolutePath?: string;
      readonly path?: string;
      readonly CodeContent?: string;
      readonly ReplacementContent?: string;
      readonly command?: string;
    };
  };
  readonly workspacePaths?: readonly string[];
  readonly runId?: string;
  readonly authorization?: MutationAuthorization | unknown;
}

export interface PreToolUseHookOutput {
  readonly decision: "allow" | "deny" | "ask";
  readonly reason: string;
}

export type PreToolUseHookDecision = PreToolUseHookOutput;

export interface PreToolUseHookOptions {
  readonly registryPath?: string | undefined;
  readonly authKeyPath?: string | undefined;
  readonly userDataPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function parseCliHookArgs(argv: string[]): PreToolUseHookOptions {
  const options: { registryPath?: string | undefined; authKeyPath?: string | undefined; userDataPath?: string | undefined } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--user-data" && i + 1 < argv.length) {
      const next = argv[++i];
      if (next) options.userDataPath = next;
    } else if (arg.startsWith("--user-data=")) {
      options.userDataPath = arg.slice("--user-data=".length);
    } else if (arg === "--registry" && i + 1 < argv.length) {
      const next = argv[++i];
      if (next) options.registryPath = next;
    } else if (arg.startsWith("--registry=")) {
      options.registryPath = arg.slice("--registry=".length);
    } else if (arg === "--auth-key" && i + 1 < argv.length) {
      const next = argv[++i];
      if (next) options.authKeyPath = next;
    } else if (arg.startsWith("--auth-key=")) {
      options.authKeyPath = arg.slice("--auth-key=".length);
    }
  }
  return options;
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

export const DEFAULT_SOURCE_READ_TOKEN_THRESHOLD = 200;

export const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw", ".go", ".rs", ".java", ".c", ".cpp",
  ".cc", ".cxx", ".h", ".hpp", ".cs", ".rb", ".php",
  ".swift", ".kt", ".kts", ".scala"
]);

export function isSourceCodePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_FILE_EXTENSIONS.has(ext);
}

export function estimateFileTokens(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 4);
}

export function isFullFileReadTool(name?: string): boolean {
  return name === "view_file";
}

export function isMutationTool(name?: string): boolean {
  return name === "replace_file_content" || name === "write_to_file";
}
