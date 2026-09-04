import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const ANTI_GAMING_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "anti-gaming.mjs")).href;
const { validateGitDiffIntegrity } = await import(ANTI_GAMING_URL) as typeof import("../scripts/harness/anti-gaming.d.mts");

function setupTestGitRepo(): { tempDir: string; repoRoot: string; baseCommit: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-antigaming-test-"));
  const repoRoot = path.join(tempDir, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "AntiGaming Tester"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tester@kins.ai"], { cwd: repoRoot, stdio: "ignore" });

  // Create baseline files
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "test"), { recursive: true });

  fs.writeFileSync(path.join(repoRoot, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf-8");
  fs.writeFileSync(
    path.join(repoRoot, "test", "math.test.js"),
    "import assert from 'node:assert';\nimport { add } from '../src/math.js';\nassert.equal(add(1, 2), 3);\n",
    "utf-8"
  );
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "sample-pkg", version: "1.0.0", scripts: { test: "node --test", build: "tsc" } }, null, 2),
    "utf-8"
  );

  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Baseline commit"], { cwd: repoRoot, stdio: "ignore" });

  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();

  return { tempDir, repoRoot, baseCommit };
}

test("anti-gaming: ordinary clean source change returns clean=true and violations=[]", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Normal code modification in src/math.js
    fs.writeFileSync(path.join(repoRoot, "src", "math.js"), "export function add(a, b) { return (a + b) | 0; }\n", "utf-8");

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: tracked .eval/ modification returns FORBIDDEN_FILE_MODIFIED", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    fs.mkdirSync(path.join(repoRoot, ".eval"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".eval", "golden.json"), '{"modified":true}\n', "utf-8");
    execFileSync("git", ["add", ".eval/golden.json"], { cwd: repoRoot, stdio: "ignore" });

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "FORBIDDEN_FILE_MODIFIED");
    assert.ok(violation);
    assert.ok(violation.path.startsWith(".eval"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: commented-out assertion returns ASSERTION_COMMENTED_OUT", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Comment out an assertion in test file
    fs.writeFileSync(
      path.join(repoRoot, "test", "math.test.js"),
      "import assert from 'node:assert';\nimport { add } from '../src/math.js';\n// assert.equal(add(1, 2), 3);\n",
      "utf-8"
    );

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "ASSERTION_COMMENTED_OUT");
    assert.ok(violation);
    assert.equal(violation.path, "test/math.test.js");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: removed active assertion returns ASSERTION_REMOVED", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Completely remove the assertion line from test file
    fs.writeFileSync(
      path.join(repoRoot, "test", "math.test.js"),
      "import assert from 'node:assert';\nimport { add } from '../src/math.js';\n",
      "utf-8"
    );

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "ASSERTION_REMOVED");
    assert.ok(violation);
    assert.equal(violation.path, "test/math.test.js");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: assertion swallowed in empty catch returns ASSERTION_SWALLOWED", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Wrap assertion inside an empty catch
    fs.writeFileSync(
      path.join(repoRoot, "test", "math.test.js"),
      "import assert from 'node:assert';\nimport { add } from '../src/math.js';\ntry { assert.equal(add(1, 2), 3); } catch {}\n",
      "utf-8"
    );

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "ASSERTION_SWALLOWED");
    assert.ok(violation);
    assert.equal(violation.path, "test/math.test.js");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: mock evasion in verifier code returns MOCK_EVASION", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Create a verification helper file and commit baseline
    fs.writeFileSync(path.join(repoRoot, "src", "verifier.js"), "export function verifyIntegrity() { return doCheck(); }\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Add verifier"], { cwd: repoRoot, stdio: "ignore" });
    const freshBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();

    // Now inject mock evasion: return { passed: true }
    fs.writeFileSync(path.join(repoRoot, "src", "verifier.js"), "export function verifyIntegrity() { return true; }\n", "utf-8");

    const result = await validateGitDiffIntegrity(repoRoot, freshBase);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "MOCK_EVASION");
    assert.ok(violation);
    assert.equal(violation.path, "src/verifier.js");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: non-test package.json script modification remains clean", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Modify non-test script in package.json (e.g. build or lint)
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "sample-pkg", version: "1.0.0", scripts: { test: "node --test", build: "esbuild --bundle" } }, null, 2),
      "utf-8"
    );

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-gaming: altered package.json test script returns FORBIDDEN_FILE_MODIFIED", async () => {
  const { tempDir, repoRoot, baseCommit } = setupTestGitRepo();
  try {
    // Alter the test script in package.json
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "sample-pkg", version: "1.0.0", scripts: { test: "exit 0", build: "tsc" } }, null, 2),
      "utf-8"
    );

    const result = await validateGitDiffIntegrity(repoRoot, baseCommit);
    assert.equal(result.clean, false);
    const violation = result.violations.find((v) => v.code === "FORBIDDEN_FILE_MODIFIED");
    assert.ok(violation);
    assert.equal(violation.path, "package.json");
    assert.ok(violation.message.includes("test"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
