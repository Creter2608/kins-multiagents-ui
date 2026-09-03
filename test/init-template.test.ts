import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFileChecksum } from "../src/checksum.js";
import { validateWorkspace } from "../src/index.js";

const REPO_ROOT = process.cwd();
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "init-template.mjs");

function runInit(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
      status: execErr.status ?? 1
    };
  }
}

test("init-template: rejects initializing inside template root or subdirectories", () => {
  const result = runInit([REPO_ROOT, "--name", "unsafe-self"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Security violation") || result.stderr.includes("CONFIG_INVALID"));
});

test("init-template: rejects invalid project names with special characters", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-invalid-"));
  try {
    const target = path.join(tempDir, "proj");
    const result = runInit([target, "--name", "../traversal"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Invalid project name") || result.stderr.includes("CONFIG_INVALID"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("init-template: dry-run makes no writes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-dry-run-"));
  const target = path.join(tempDir, "dry-project");
  try {
    const result = runInit([target, "--name", "dry-project", "--dry-run"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("[init-template DRY RUN]"));
    assert.equal(fs.existsSync(target), false, "Target directory must not be created during dry-run");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("init-template: generates clean project with fresh golden assertions and valid sha", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-real-"));
  const target = path.join(tempDir, "my-ai-service");

  try {
    const result = runInit([target, "--name", "my-ai-service"]);
    assert.equal(result.status, 0, `Initialization failed: ${result.stderr}`);
    assert.ok(fs.existsSync(target), "Target directory must exist");

    // Verify package.json
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf-8"));
    assert.equal(pkg.name, "my-ai-service");

    // Verify excluded files are not present
    assert.equal(fs.existsSync(path.join(target, ".git")), false, ".git must be excluded");
    assert.equal(fs.existsSync(path.join(target, ".codegraph")), false, ".codegraph must be excluded");
    assert.equal(fs.existsSync(path.join(target, "node_modules")), false, "node_modules must be excluded");
    assert.equal(fs.existsSync(path.join(target, "dist")), false, "dist must be excluded");
    assert.equal(fs.existsSync(path.join(target, "docs", "archive")), false, "docs/archive must be excluded");
    assert.equal(fs.existsSync(path.join(target, "docs", "plans")), false, "docs/plans must be excluded");
    assert.equal(fs.existsSync(path.join(target, "PITFALLS.md")), false, "PITFALLS.md must not exist");

    // Verify clean-slate wiki/log.md
    const logPath = path.join(target, "wiki", "log.md");
    assert.ok(fs.existsSync(logPath), "wiki/log.md must exist");
    const logContent = fs.readFileSync(logPath, "utf-8");
    assert.equal(logContent, "# Project Log\n");
    assert.equal(logContent.includes("init-loop-20260903"), false);

    // Verify fresh golden assertions & SHA-256
    const goldenJsonPath = path.join(target, ".eval", "golden_assertions.json");
    const shaPath = path.join(target, ".eval", "golden_assertions.sha256");
    assert.ok(fs.existsSync(goldenJsonPath), ".eval/golden_assertions.json must exist");
    assert.ok(fs.existsSync(shaPath), ".eval/golden_assertions.sha256 must exist");

    const expectedSha = fs.readFileSync(shaPath, "utf-8").trim();
    // Cryptographic check
    const verifiedSha = await verifyFileChecksum(goldenJsonPath, expectedSha);
    assert.equal(verifiedSha, expectedSha);

    // Validate workspace against fresh golden assertions
    const results = await validateWorkspace({
      goldenPath: goldenJsonPath,
      expectedSha256: expectedSha
    });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.passed));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
