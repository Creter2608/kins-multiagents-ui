import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxLifecycleService } from "../src/main/services/SandboxLifecycleService.js";

const REPO_ROOT = process.cwd();
const SANDBOX_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "sandbox.mjs")).href;
const {
  sanitizeRunId,
  getSandboxConfig,
  buildDockerRunArgs,
  isDockerAvailable,
  spawnEphemeralSandbox,
  execInSandbox,
  teardownEphemeralSandbox
} = await import(SANDBOX_URL) as typeof import("../scripts/harness/sandbox.d.mts");

// Compact Assertion 1: sanitizeRunId(' ../A:B?? ') -> "A-B"
test("sandbox: sanitizeRunId cleans, trims, and bounds tokens correctly", () => {
  assert.equal(sanitizeRunId(" ../A:B?? "), "A-B");
  assert.equal(sanitizeRunId(""), "run");
  assert.equal(sanitizeRunId("---___---"), "run");
  assert.equal(sanitizeRunId("valid_run-123"), "valid_run-123");

  // Truncation at 48 chars
  const veryLong = "a".repeat(100);
  assert.equal(sanitizeRunId(veryLong).length, 48);
});

// Compact Assertion 2: getSandboxConfig('run-1') -> default invariants
test("sandbox: getSandboxConfig generates deterministic defaults and validates fields", () => {
  const cfg = getSandboxConfig("run-1");
  assert.equal(cfg.runId, "run-1");
  assert.equal(cfg.sanitizedRunId, "run-1");
  assert.equal(cfg.containerName, "kins-sandbox-run-1");
  assert.equal(cfg.image, "node:22-bookworm-slim");
  assert.equal(cfg.memoryLimit, "4g");
  assert.equal(cfg.cpuLimit, 2.0);
  assert.equal(cfg.pidsLimit, 128);
  assert.equal(cfg.timeoutMs, 300000);
  assert.equal(cfg.network, "none");
  assert.equal(cfg.workdir, "/workspace");
  assert.equal(cfg.fallbackToProcess, true);
  assert.deepEqual(cfg.mounts, []);
  assert.deepEqual(cfg.env, {});

  // Custom options overrides
  const custom = getSandboxConfig("custom-run", {
    image: "alpine:latest",
    memoryLimit: "2g",
    cpuLimit: 1.0,
    pidsLimit: 64,
    timeoutMs: 15000,
    network: "bridge",
    env: { FOO: "bar", BAZ: "qux" }
  });
  assert.equal(custom.image, "alpine:latest");
  assert.equal(custom.memoryLimit, "2g");
  assert.equal(custom.cpuLimit, 1.0);
  assert.equal(custom.pidsLimit, 64);
  assert.equal(custom.timeoutMs, 15000);
  assert.equal(custom.network, "bridge");
  assert.equal(custom.env.FOO, "bar");

  // Rejection of control characters in fields
  assert.throws(() => {
    getSandboxConfig("run-bad", { image: "node:22\ninjection" });
  }, /illegal control characters/);
});

test("sandbox: buildDockerRunArgs sorts mounts and env keys deterministically", () => {
  const cfg = getSandboxConfig("run-args-test", {
    mounts: [
      { source: "./b", target: "/workspace/b", readOnly: true },
      { source: "./a", target: "/workspace/a" }
    ],
    env: {
      ZEBRA: "last",
      ALPHA: "first"
    }
  });

  const args = buildDockerRunArgs(cfg);
  assert.equal(args[0], "run");
  assert.ok(args.includes("-d"));
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--name"));
  assert.ok(args.includes("kins-sandbox-run-args-test"));
  assert.ok(args.includes("--cpus"));
  assert.ok(args.includes("2"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("4g"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("128"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("kins.sandbox=true"));
  assert.ok(args.includes("kins.run-id=run-args-test"));

  // Check mounts sorting: /workspace/a before /workspace/b
  const idxA = args.findIndex((a) => a.includes(":/workspace/a"));
  const idxB = args.findIndex((a) => a.includes(":/workspace/b:ro"));
  assert.ok(idxA !== -1 && idxB !== -1);
  assert.ok(idxA < idxB);

  // Check env sorting: ALPHA before ZEBRA
  const idxAlpha = args.indexOf("ALPHA=first");
  const idxZebra = args.indexOf("ZEBRA=last");
  assert.ok(idxAlpha !== -1 && idxZebra !== -1);
  assert.ok(idxAlpha < idxZebra);

  // Tail command at the end
  assert.equal(args[args.length - 3], "tail");
  assert.equal(args[args.length - 2], "-f");
  assert.equal(args[args.length - 1], "/dev/null");
});

test("sandbox: isDockerAvailable probe returns boolean without throwing", async () => {
  const available = await isDockerAvailable();
  assert.equal(typeof available, "boolean");
});

async function spawnFallbackSandbox(runId: string, options?: Partial<import("../scripts/harness/sandbox.d.mts").SandboxOptions>) {
  const cfg = getSandboxConfig(runId, { ...options, fallbackToProcess: true });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = ""; // Ensures isDockerAvailable() returns false
    return await spawnEphemeralSandbox(cfg);
  } finally {
    process.env.PATH = oldPath;
  }
}

// Compact Assertion 3: Docker unavailable; exec [node, '-e', 'process.exit(7)'] -> mode=process, status=Fallback, exitCode=7
test("sandbox: spawnEphemeralSandbox falls back to process mode and propagates exit code", async () => {
  const instance = await spawnFallbackSandbox("fallback-run-1");
  assert.equal(instance.runId, "fallback-run-1");
  assert.equal(instance.mode, "process");
  assert.equal(instance.status, "Fallback");

  try {
    const result = await execInSandbox(instance, [
      process.execPath,
      "-e",
      "process.exit(7)"
    ]);

    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  } finally {
    const td = await teardownEphemeralSandbox(instance);
    assert.ok(td.success);
  }
});

// Compact Assertion 4: exec emits >32KiB -> captured output capped; truncated=true
test("sandbox: execInSandbox caps output at 32 KiB and sets truncated flag", async () => {
  const instance = await spawnFallbackSandbox("cap-run");

  try {
    // Generate ~50 KiB output
    const result = await execInSandbox(instance, [
      process.execPath,
      "-e",
      "process.stdout.write('A'.repeat(50000));"
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.includes("TRUNCATED"));
    assert.ok(result.stdout.length <= 40000); // capped with truncation marker
  } finally {
    await teardownEphemeralSandbox(instance);
  }
});

test("sandbox: execInSandbox handles execution timeout cleanly", async () => {
  const instance = await spawnFallbackSandbox("timeout-run", { timeoutMs: 300 });

  try {
    const result = await execInSandbox(instance, [
      process.execPath,
      "-e",
      "setTimeout(() => {}, 5000);"
    ], { timeoutMs: 300 });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await teardownEphemeralSandbox(instance);
  }
});

test("sandbox: execInSandbox inside real Docker container when daemon is available", async () => {
  const available = await isDockerAvailable();
  if (!available) return;

  const cfg = getSandboxConfig("docker-live-test", { fallbackToProcess: false });
  const instance = await spawnEphemeralSandbox(cfg);
  assert.equal(instance.mode, "docker");
  assert.equal(instance.status, "Active");

  try {
    const result = await execInSandbox(instance, [
      "node",
      "-e",
      "process.stdout.write('docker-live-ok'); process.exit(0);"
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("docker-live-ok"));
  } finally {
    const td = await teardownEphemeralSandbox(instance);
    assert.ok(td.success);
  }
});

// Compact Assertion 5: teardown fallback twice -> owned temp removed; both calls succeed
test("sandbox: teardownEphemeralSandbox is idempotent and removes owned temp paths", async () => {
  const tmpRoot = os.tmpdir();
  const ownedTemp = fs.mkdtempSync(path.join(tmpRoot, "test-owned-dir-"));
  assert.ok(fs.existsSync(ownedTemp));

  const fakeInstance = {
    runId: "teardown-idempotent",
    containerName: "kins-sandbox-teardown-idempotent",
    status: "Fallback" as const,
    mode: "process" as const,
    config: getSandboxConfig("teardown-idempotent"),
    ownedPaths: [ownedTemp]
  };

  // First teardown call
  const td1 = await teardownEphemeralSandbox(fakeInstance);
  assert.equal(td1.success, true);
  assert.ok(td1.removedPaths.includes(path.resolve(ownedTemp)));
  assert.equal(fs.existsSync(ownedTemp), false);

  // Second teardown call on same instance is idempotent
  const td2 = await teardownEphemeralSandbox(fakeInstance);
  assert.equal(td2.success, true);
  assert.equal(fs.existsSync(ownedTemp), false);
});

test("sandbox: teardownEphemeralSandbox refuses to delete paths outside tmpdir", async () => {
  const outsidePath = path.resolve(REPO_ROOT, "package.json");
  const fakeInstance = {
    runId: "security-check",
    containerName: "kins-sandbox-security-check",
    status: "Fallback" as const,
    mode: "process" as const,
    config: getSandboxConfig("security-check"),
    ownedPaths: [outsidePath]
  };

  const td = await teardownEphemeralSandbox(fakeInstance);
  assert.equal(td.success, false);
  assert.ok(td.errors.some((e) => e.includes("Refusing to remove owned path outside tmpdir")));
  // Crucial invariant: package.json remains intact!
  assert.ok(fs.existsSync(outsidePath));
});

test("SandboxLifecycleService: observes state file and emits status updates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-svc-test-"));
  const statePath = path.join(tmpDir, "state.json");

  const service = new SandboxLifecycleService(statePath);
  const statuses: string[] = [];
  const unsubscribe = service.subscribe((s) => {
    statuses.push(s);
  });

  try {
    service.start();
    assert.equal(service.getStatus(), "Unavailable");

    // Write state with active fallback sandbox
    fs.writeFileSync(statePath, JSON.stringify({
      sandbox: {
        instance: {
          status: "Fallback",
          mode: "process"
        }
      }
    }), "utf-8");

    service.readState();
    assert.equal(service.getStatus(), "Fallback");

    // Write state with stopped sandbox
    fs.writeFileSync(statePath, JSON.stringify({
      sandbox: {
        instance: { status: "Active", mode: "docker" },
        teardown: { status: "Stopped" }
      }
    }), "utf-8");

    service.readState();
    assert.equal(service.getStatus(), "Stopped");

    unsubscribe();
  } finally {
    service.dispose();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
