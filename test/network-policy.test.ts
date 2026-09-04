import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const POLICY_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "network-policy.mjs")).href;
const SANDBOX_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "sandbox.mjs")).href;
const ANTI_GAMING_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "anti-gaming.mjs")).href;
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "runner.mjs")).href;

const {
  validateNetworkPolicy,
  normalizeAllowedHost,
  isDestinationAllowed,
  buildProxyEnvironment
} = await import(POLICY_URL) as typeof import("../scripts/harness/network-policy.d.mts");

const {
  getSandboxConfig,
  buildDockerRunArgs
} = await import(SANDBOX_URL) as typeof import("../scripts/harness/sandbox.d.mts");

const {
  validateGitDiffIntegrity
} = await import(ANTI_GAMING_URL) as typeof import("../scripts/harness/anti-gaming.d.mts");

const {
  executeTaskCommand
} = await import(RUNNER_URL) as typeof import("../scripts/harness/runner.d.mts");

test("network-policy: validateNetworkPolicy accepts mode 'none'", () => {
  const result = validateNetworkPolicy({ mode: "none" });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("network-policy: validateNetworkPolicy accepts valid allowlist policy", () => {
  const result = validateNetworkPolicy({
    mode: "allowlist",
    proxyUrl: "http://proxy.internal:8080",
    allowedHosts: ["registry.npmjs.org", "api.github.com"]
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("network-policy: validateNetworkPolicy rejects embedded credentials in proxyUrl", () => {
  const result = validateNetworkPolicy({
    mode: "allowlist",
    proxyUrl: "http://admin:secret@proxy.internal:8080",
    allowedHosts: ["registry.npmjs.org"]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]!, /must not contain embedded username or password/);
});

test("network-policy: validateNetworkPolicy rejects wildcards in allowedHosts", () => {
  const result = validateNetworkPolicy({
    mode: "allowlist",
    proxyUrl: "http://proxy.internal:8080",
    allowedHosts: ["*.npmjs.org"]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]!, /contains wildcards/);
});

test("network-policy: validateNetworkPolicy rejects private and loopback IP destinations", () => {
  const testCases = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.1.1",
    "192.168.1.100",
    "169.254.169.254",
    "localhost"
  ];

  for (const host of testCases) {
    const res = validateNetworkPolicy({
      mode: "allowlist",
      proxyUrl: "http://proxy.internal:8080",
      allowedHosts: [host]
    });
    assert.equal(res.valid, false, `Expected ${host} to be rejected as private/local destination`);
    assert.match(res.errors[0]!, /resolves to private or local network destination/);
  }
});

test("network-policy: normalizeAllowedHost strips protocols, ports, and paths", () => {
  assert.equal(normalizeAllowedHost("https://registry.npmjs.org:443/some/path"), "registry.npmjs.org");
  assert.equal(normalizeAllowedHost("HTTP://API.GITHUB.COM:8080"), "api.github.com");
  assert.equal(normalizeAllowedHost("  example.com:3000  "), "example.com");
});

test("network-policy: isDestinationAllowed evaluates policy strictly", () => {
  const nonePolicy = { mode: "none" as const };
  assert.equal(isDestinationAllowed("https://registry.npmjs.org", nonePolicy), false);

  const allowlistPolicy = {
    mode: "allowlist" as const,
    proxyUrl: "http://proxy.internal:8080",
    allowedHosts: ["registry.npmjs.org"]
  };
  assert.equal(isDestinationAllowed("https://registry.npmjs.org/pkg", allowlistPolicy), true);
  assert.equal(isDestinationAllowed("https://evil.com/leak", allowlistPolicy), false);
  assert.equal(isDestinationAllowed("http://127.0.0.1:8080/internal", allowlistPolicy), false);
});

test("network-policy: sandbox builds hardened flags (--cap-drop ALL, --security-opt no-new-privileges)", () => {
  const config = getSandboxConfig("hardened-test", {
    networkPolicy: { mode: "none" }
  });

  assert.equal(config.network, "none");
  assert.deepEqual(config.networkPolicy, { mode: "none" });

  const dockerArgs = buildDockerRunArgs(config);
  assert.ok(dockerArgs.includes("--cap-drop"));
  assert.ok(dockerArgs.includes("ALL"));
  assert.ok(dockerArgs.includes("--security-opt"));
  assert.ok(dockerArgs.includes("no-new-privileges"));
  assert.ok(dockerArgs.includes("--network"));
  assert.ok(dockerArgs.includes("none"));
});

test("network-policy: sandbox in allowlist mode merges proxy environment variables", () => {
  const config = getSandboxConfig("proxy-test", {
    networkPolicy: {
      mode: "allowlist",
      proxyUrl: "http://proxy.internal:8080",
      allowedHosts: ["registry.npmjs.org"]
    }
  });

  assert.equal(config.env.HTTP_PROXY, "http://proxy.internal:8080");
  assert.equal(config.env.HTTPS_PROXY, "http://proxy.internal:8080");
  assert.equal(config.env.ALL_PROXY, "http://proxy.internal:8080");
  assert.equal(config.env.NO_PROXY, "localhost,127.0.0.1");
});

test("network-policy: anti-gaming detects tampering in .ai/secure-patches/", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-patch-tamper-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });

    fs.writeFileSync(path.join(tempDir, "README.md"), "# Init\n");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tempDir, stdio: "ignore" });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim();

    // Attacker modifies .ai/secure-patches/task-001.patch
    const securePatchDir = path.join(tempDir, ".ai", "secure-patches");
    fs.mkdirSync(securePatchDir, { recursive: true });
    fs.writeFileSync(path.join(securePatchDir, "task-001.patch"), "diff --git a/test.js b/test.js\n");

    const integrity = await validateGitDiffIntegrity(tempDir, baseCommit, {});
    assert.equal(integrity.clean, false);
    assert.ok(integrity.violations.some((v) => v.code === "FORBIDDEN_FILE_MODIFIED" && v.path.includes(".ai/secure-patches")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("network-policy: executeTaskCommand applies and scrubs securePatchPath in finally", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-blind-eval-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });

    const targetFile = path.join(tempDir, "sample.txt");
    fs.writeFileSync(targetFile, "line1\nline2\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: tempDir, stdio: "ignore" });

    // Create a patch that modifies sample.txt
    const patchContent = `--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,3 @@\n line1\n line2\n+secure_injected_assertion\n`;
    const patchPath = path.join(tempDir, "test.patch");
    fs.writeFileSync(patchPath, patchContent, "utf-8");

    // Execute a command while patch is injected
    const execRes = await executeTaskCommand(
      { argv: ["node", "-e", "const fs = require('fs'); const c = fs.readFileSync('sample.txt', 'utf-8'); if (!c.includes('secure_injected_assertion')) process.exit(1);"], timeoutMs: 10000 },
      tempDir,
      "test",
      tempDir,
      { securePatchPath: patchPath }
    );

    assert.equal(execRes.passed, true);

    // After execution, the patch MUST be reverted from working directory
    const postExecContent = fs.readFileSync(targetFile, "utf-8");
    assert.equal(postExecContent.includes("secure_injected_assertion"), false, "Secure patch must be cleanly reverted in finally block");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
