/**
 * scripts/harness/sandbox.mjs
 * Zero-dependency Ephemeral Container & Sandbox Lifecycle Engine.
 * Provides runId-scoped container isolation with sub-second lifecycle,
 * deterministic resource caps, and isolated local process fallback.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CAP_BYTES = 32 * 1024; // 32 KiB cap matching ai-exec.mjs
const DOCKER_PROBE_TIMEOUT_MS = 3000;

/**
 * Sanitizes a run ID into a valid container/volume name token.
 * 1. Converts input to string.
 * 2. Replaces maximal sequences outside [a-zA-Z0-9_-] with '-'.
 * 3. Trims leading/trailing '-' and '_'.
 * 4. Truncates to 48 characters.
 * 5. Returns 'run' if empty.
 * @param {unknown} runId
 * @returns {string}
 */
export function sanitizeRunId(runId) {
  const str = String(runId ?? "");
  const replaced = str.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const trimmed = replaced.replace(/^[-_]+|[-_]+$/g, "");
  const truncated = trimmed.slice(0, 48);
  return truncated.length > 0 ? truncated : "run";
}

/**
 * Validates that a string does not contain control or injection characters.
 * @param {string} val
 * @param {string} fieldName
 */
function assertNoControlChars(val, fieldName) {
  if (/[\r\n\0]/.test(val)) {
    throw new Error(`Field '${fieldName}' contains illegal control characters (newlines or null bytes).`);
  }
}

/**
 * Computes a deterministic sandbox configuration object.
 * @param {string} runId
 * @param {Record<string, any>} [options={}]
 * @returns {import('./sandbox.d.mts').SandboxConfig}
 */
export function getSandboxConfig(runId, options = {}) {
  const sanitizedRunId = sanitizeRunId(runId);
  const containerName = `kins-sandbox-${sanitizedRunId}`;

  const image = typeof options.image === "string" && options.image.trim().length > 0
    ? options.image.trim()
    : "node:22-bookworm-slim";

  const memoryLimit = typeof options.memoryLimit === "string" && options.memoryLimit.trim().length > 0
    ? options.memoryLimit.trim()
    : "4g";

  const cpuLimit = typeof options.cpuLimit === "number" && options.cpuLimit > 0
    ? options.cpuLimit
    : 2.0;

  const pidsLimit = typeof options.pidsLimit === "number" && options.pidsLimit > 0
    ? Math.floor(options.pidsLimit)
    : 128;

  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0
    ? options.timeoutMs
    : 300000;

  const network = typeof options.network === "string" && options.network.trim().length > 0
    ? options.network.trim()
    : "none";

  const workdir = typeof options.workdir === "string" && options.workdir.trim().length > 0
    ? options.workdir.trim()
    : "/workspace";

  const fallbackToProcess = options.fallbackToProcess !== false;

  const rawMounts = Array.isArray(options.mounts) ? options.mounts : [];
  const mounts = rawMounts.map((m, idx) => {
    if (!m || typeof m.source !== "string" || typeof m.target !== "string" || !m.source || !m.target) {
      throw new Error(`Invalid mount at index ${idx}: source and target must be non-empty strings.`);
    }
    assertNoControlChars(m.source, `mounts[${idx}].source`);
    assertNoControlChars(m.target, `mounts[${idx}].target`);
    return {
      source: path.resolve(m.source),
      target: m.target,
      readOnly: Boolean(m.readOnly)
    };
  });

  const rawEnv = options.env && typeof options.env === "object" ? options.env : {};
  const env = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    assertNoControlChars(k, `env key ${k}`);
    assertNoControlChars(String(v), `env val for ${k}`);
    env[k] = String(v);
  }

  assertNoControlChars(image, "image");
  assertNoControlChars(memoryLimit, "memoryLimit");
  assertNoControlChars(network, "network");
  assertNoControlChars(workdir, "workdir");
  assertNoControlChars(containerName, "containerName");

  return {
    runId: String(runId),
    sanitizedRunId,
    containerName,
    image,
    memoryLimit,
    cpuLimit,
    pidsLimit,
    timeoutMs,
    network,
    workdir,
    mounts,
    env,
    fallbackToProcess
  };
}

/**
 * Builds deterministic command arguments for docker run.
 * @param {import('./sandbox.d.mts').SandboxConfig} config
 * @returns {string[]}
 */
export function buildDockerRunArgs(config) {
  const args = [
    "run",
    "-d",
    "--name", config.containerName,
    "--rm",
    "--cpus", String(config.cpuLimit),
    "--memory", config.memoryLimit,
    "--pids-limit", String(config.pidsLimit),
    "--network", config.network,
    "--label", "kins.sandbox=true",
    "--label", `kins.run-id=${config.sanitizedRunId}`
  ];

  // Sort mounts by target ascending, then source ascending
  const sortedMounts = [...config.mounts].sort((a, b) => {
    const targetComp = a.target.localeCompare(b.target);
    return targetComp !== 0 ? targetComp : a.source.localeCompare(b.source);
  });

  for (const m of sortedMounts) {
    const flag = m.readOnly ? `${m.source}:${m.target}:ro` : `${m.source}:${m.target}`;
    args.push("-v", flag);
  }

  args.push("-w", config.workdir);

  // Sort env keys lexicographically
  const envKeys = Object.keys(config.env).sort();
  for (const key of envKeys) {
    args.push("-e", `${key}=${config.env[key]}`);
  }

  args.push(config.image);
  args.push("tail", "-f", "/dev/null");

  return args;
}

/**
 * Checks whether the Docker daemon is reachable and responding.
 * @returns {Promise<boolean>}
 */
export async function isDockerAvailable() {
  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;

    const safeResolve = (val) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve(val);
      }
    };

    timer = setTimeout(() => {
      safeResolve(false);
    }, DOCKER_PROBE_TIMEOUT_MS);

    try {
      const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });

      let stdout = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });

      child.on("error", () => {
        safeResolve(false);
      });

      child.on("close", (code) => {
        safeResolve(code === 0 && stdout.trim().length > 0);
      });
    } catch {
      safeResolve(false);
    }
  });
}

/**
 * Spawns an ephemeral sandbox instance (either via Docker or Process fallback).
 * @param {import('./sandbox.d.mts').SandboxConfig} config
 * @returns {Promise<import('./sandbox.d.mts').SandboxInstance>}
 */
export async function spawnEphemeralSandbox(config) {
  const dockerOnline = await isDockerAvailable();

  if (dockerOnline) {
    const args = buildDockerRunArgs(config);
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (c) => { stdout += c.toString("utf-8"); });
      child.stderr?.on("data", (c) => { stderr += c.toString("utf-8"); });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn Docker sandbox: ${err.message}`));
      });

      child.on("close", (code) => {
        if (code === 0 && stdout.trim().length > 0) {
          const containerId = stdout.trim();
          resolve({
            runId: config.runId,
            containerName: config.containerName,
            containerId,
            status: "Active",
            mode: "docker",
            config,
            ownedPaths: []
          });
        } else {
          const errMsg = stderr.trim() || `docker run exited with code ${code}`;
          reject(new Error(`Docker sandbox spawn failed: ${errMsg}`));
        }
      });
    });
  }

  // Docker not available: Process Fallback
  if (config.fallbackToProcess) {
    const tmpPrefix = path.join(os.tmpdir(), `kins-sandbox-${config.sanitizedRunId}-`);
    const workspacePath = fs.mkdtempSync(tmpPrefix);
    return {
      runId: config.runId,
      containerName: config.containerName,
      status: "Fallback",
      mode: "process",
      config,
      workspacePath,
      ownedPaths: [workspacePath]
    };
  }

  throw new Error(`Docker engine is unavailable and process fallback is disabled for run '${config.runId}'.`);
}

/**
 * Truncates output buffer retaining head and tail with marker when over maxBytes.
 * @param {Buffer[]} chunks
 * @param {number} totalBytes
 * @param {number} maxBytes
 * @param {string} streamName
 * @returns {{ text: string, truncated: boolean }}
 */
function processStreamChunks(chunks, totalBytes, maxBytes, streamName) {
  const combined = Buffer.concat(chunks, totalBytes);
  if (totalBytes <= maxBytes) {
    return { text: combined.toString("utf-8"), truncated: false };
  }

  const headBytes = Math.floor(maxBytes * 0.65);
  const tailBytes = Math.floor(maxBytes * 0.35);
  const truncatedCount = totalBytes - (headBytes + tailBytes);

  const head = combined.subarray(0, headBytes).toString("utf-8");
  const tail = combined.subarray(totalBytes - tailBytes).toString("utf-8");

  const cleanHead = head.slice(0, head.lastIndexOf("\n") + 1) || head;
  const cleanTail = tail.slice(tail.indexOf("\n") + 1) || tail;

  const marker = `\n\n[... TRUNCATED ${truncatedCount} BYTES OF ${streamName} BY AI-EXEC (TOTAL: ${totalBytes} B, CAP: ${maxBytes} B) ...]\n\n`;
  return {
    text: cleanHead + marker + cleanTail,
    truncated: true
  };
}

/**
 * Executes a command inside the active sandbox instance.
 * @param {import('./sandbox.d.mts').SandboxInstance} instance
 * @param {string[]} command
 * @param {import('./sandbox.d.mts').ExecOptions} [options={}]
 * @returns {Promise<import('./sandbox.d.mts').ExecResult>}
 */
export async function execInSandbox(instance, command, options = {}) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("Command must be a non-empty string array.");
  }

  const timeoutMs = options.timeoutMs ?? instance.config.timeoutMs ?? 300000;
  const env = {
    ...instance.config.env,
    ...(options.env || {})
  };

  let bin = "";
  let args = [];
  let cwd = options.cwd;

  if (instance.mode === "docker") {
    bin = "docker";
    args = ["exec"];
    const effectiveWorkdir = cwd || instance.config.workdir;
    if (effectiveWorkdir) {
      args.push("-w", effectiveWorkdir);
    }
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }
    args.push(instance.containerId || instance.containerName);

    const cmdTokens = [...command];
    if (cmdTokens[0] === process.execPath || path.basename(cmdTokens[0]).replace(/\.exe$/i, "").toLowerCase() === "node") {
      cmdTokens[0] = "node";
    }
    args.push(...cmdTokens);
  } else {
    // Process mode
    bin = command[0];
    args = command.slice(1);
    cwd = cwd || instance.workspacePath || process.cwd();
  }

  return new Promise((resolve) => {
    let timedOut = false;
    let timer = null;
    let settled = false;

    const child = spawn(bin, args, {
      cwd: instance.mode === "process" ? cwd : undefined,
      env: instance.mode === "process" ? { ...process.env, ...env } : undefined,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (instance.mode === "docker") {
          spawn("docker", ["kill", instance.containerId || instance.containerName], {
            shell: false,
            stdio: "ignore",
            windowsHide: true
          });
        }
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 1000);
      } catch {}
    }, timeoutMs);

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const out = processStreamChunks(stdoutChunks, stdoutBytes, DEFAULT_CAP_BYTES, "STDOUT");
      const err = processStreamChunks(stderrChunks, stderrBytes, Math.floor(DEFAULT_CAP_BYTES / 2), "STDERR");

      resolve({
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut
      });
    };

    child.on("close", (code) => {
      finish(code);
    });

    child.on("error", (err) => {
      stderrChunks.push(Buffer.from(`Spawn error: ${err.message}\n`));
      stderrBytes += err.message.length;
      finish(1);
    });
  });
}

/**
 * Cleanly tears down an ephemeral sandbox, removing container and owned paths.
 * @param {import('./sandbox.d.mts').SandboxInstance} instance
 * @param {import('./sandbox.d.mts').TeardownOptions} [options={}]
 * @returns {Promise<import('./sandbox.d.mts').TeardownResult>}
 */
export async function teardownEphemeralSandbox(instance, options = {}) {
  const result = {
    success: true,
    status: "Stopped",
    removedContainer: false,
    removedPaths: [],
    errors: []
  };

  if (!instance) {
    return result;
  }

  // 1. Docker container removal
  if (instance.mode === "docker") {
    const target = instance.containerId || instance.containerName;
    if (target) {
      await new Promise((resolve) => {
        const child = spawn("docker", ["rm", "-f", target], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });

        let stderr = "";
        child.stderr?.on("data", (c) => { stderr += c.toString("utf-8"); });

        child.on("close", (code) => {
          if (code === 0) {
            result.removedContainer = true;
            result.status = "Stopped";
          } else {
            const errStr = stderr.toLowerCase();
            if (errStr.includes("no such container") || errStr.includes("not found")) {
              result.removedContainer = false;
              result.status = "Missing";
            } else {
              result.success = false;
              result.status = "Unavailable";
              result.errors.push(`docker rm failed: ${stderr.trim() || code}`);
            }
          }
          resolve();
        });

        child.on("error", (err) => {
          result.success = false;
          result.status = "Unavailable";
          result.errors.push(`docker rm error: ${err.message}`);
          resolve();
        });
      });
    }
  }

  // 2. Remove only owned paths located beneath os.tmpdir()
  const tmpRoot = path.resolve(os.tmpdir());
  for (const ownedPath of instance.ownedPaths || []) {
    try {
      const resolved = path.resolve(ownedPath);
      // Safety invariant: MUST be beneath os.tmpdir(), never system root or project cwd
      if (resolved.startsWith(tmpRoot) && resolved !== tmpRoot) {
        if (fs.existsSync(resolved)) {
          fs.rmSync(resolved, { recursive: true, force: true });
          result.removedPaths.push(resolved);
        }
      } else {
        result.errors.push(`Refusing to remove owned path outside tmpdir: ${resolved}`);
      }
    } catch (err) {
      result.errors.push(`Failed to remove path ${ownedPath}: ${err.message}`);
    }
  }

  if (result.errors.length > 0) {
    result.success = false;
  }

  return result;
}
