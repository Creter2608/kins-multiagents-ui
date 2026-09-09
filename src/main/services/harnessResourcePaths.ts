/**
 * src/main/services/harnessResourcePaths.ts
 * Resolves canonical harness and autonomous script paths across
 * both development and packaged production desktop environments.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface HarnessResourcePaths {
  readonly scriptsDirectory: string;
  readonly aqiHarnessPath: string;
  readonly loopScriptPath: string;
  readonly preToolUseHookPath: string;
}

export interface ResolveHarnessOptions {
  readonly appRoot?: string | undefined;
  readonly resourcesPath?: string | undefined;
  readonly isPackaged?: boolean | undefined;
}

function resolveDevAppRoot(): string {
  let curr = path.dirname(fileURLToPath(import.meta.url));
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "scripts", "ai-loop.mjs"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return process.cwd();
}

export function resolveHarnessResourcePaths(options?: ResolveHarnessOptions): HarnessResourcePaths {
  const isPackaged = options?.isPackaged ?? Boolean((process as any).resourcesPath && (process as any).defaultApp !== false);
  const resourcesPath = options?.resourcesPath ?? (process as any).resourcesPath;

  let scriptsDirectory: string;
  const root = options?.appRoot ?? resolveDevAppRoot();

  if (isPackaged && resourcesPath && fs.existsSync(path.join(resourcesPath, "scripts"))) {
    scriptsDirectory = path.join(resourcesPath, "scripts");
  } else {
    scriptsDirectory = path.join(root, "scripts");
  }

  let preToolUseHookPath: string;
  if (isPackaged && resourcesPath && fs.existsSync(path.join(resourcesPath, "dist", "src", "cli", "preToolUseHook.js"))) {
    preToolUseHookPath = path.join(resourcesPath, "dist", "src", "cli", "preToolUseHook.js");
  } else {
    preToolUseHookPath = path.join(root, "dist", "src", "cli", "preToolUseHook.js");
  }

  return Object.freeze({
    scriptsDirectory,
    aqiHarnessPath: path.join(scriptsDirectory, "harness", "aqi.mjs"),
    loopScriptPath: path.join(scriptsDirectory, "ai-loop.mjs"),
    preToolUseHookPath
  });
}
