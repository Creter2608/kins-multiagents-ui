import test from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "runner.mjs")).href;
const { parseTask, computeMetrics, runEvaluation } = await import(RUNNER_URL) as typeof import("../scripts/harness/runner.d.mts");

test("harness: parseTask validates schema, task ID, and constraints", () => {
  const validTask = {
    schemaVersion: 1,
    id: "001-fix-login",
    title: "Fix login token parsing",
    kind: "f2p",
    command: {
      argv: ["node", "-v"],
      timeoutMs: 5000
    },
    hiddenAssertions: [
      {
        path: "harness/specs/001.txt",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    ]
  };

  const parsed = parseTask(JSON.stringify(validTask));
  assert.equal(parsed.id, "001-fix-login");
  assert.equal(parsed.kind, "f2p");
  assert.equal(parsed.command.timeoutMs, 5000);
  assert.equal(parsed.hiddenAssertions.length, 1);

  // Invalid task ID
  assert.throws(() => {
    parseTask({ ...validTask, id: "INVALID_ID!" });
  }, /invalid id/);

  // Invalid schema version
  assert.throws(() => {
    parseTask({ ...validTask, schemaVersion: 2 });
  }, /expected schemaVersion 1/);

  // Invalid kind
  assert.throws(() => {
    parseTask({ ...validTask, kind: "unknown" });
  }, /kind must be either 'f2p' or 'p2p'/);

  // Path traversal in hiddenAssertions
  assert.throws(() => {
    parseTask({
      ...validTask,
      hiddenAssertions: [{ path: "../outside.txt", sha256: validTask.hiddenAssertions[0]!.sha256 }]
    });
  }, /hiddenAssertion.path must be a relative path without traversal/);
});

test("harness: computeMetrics computes Pass@1 and SSI deterministically", () => {
  // Scenario 1: F2P pass, P2P pass -> Pass@1=1, SSI=1
  const results1 = [
    {
      id: "task-1",
      kind: "f2p" as const,
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    },
    {
      id: "task-2",
      kind: "p2p" as const,
      base: { exitCode: 0, passed: true, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    }
  ];
  const m1 = computeMetrics(results1);
  assert.equal(m1.passAt1, 1);
  assert.equal(m1.passAtK, 1);
  assert.equal(m1.k, 1);
  assert.equal(m1.ssi, 1);

  // Scenario 2: F2P fail, P2P pass -> Pass@1=0, SSI=1
  const results2 = [
    {
      id: "task-1",
      kind: "f2p" as const,
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 1, passed: false, signal: null, timedOut: false },
      passed: false
    },
    {
      id: "task-2",
      kind: "p2p" as const,
      base: { exitCode: 0, passed: true, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    }
  ];
  const m2 = computeMetrics(results2);
  assert.equal(m2.passAt1, 0);
  assert.equal(m2.ssi, 1);

  // Scenario 3: P2P regression -> Pass@1=1, SSI=0
  const results3 = [
    {
      id: "task-1",
      kind: "f2p" as const,
      base: { exitCode: 1, passed: false, signal: null, timedOut: false },
      current: { exitCode: 0, passed: true, signal: null, timedOut: false },
      passed: true
    },
    {
      id: "task-2",
      kind: "p2p" as const,
      base: { exitCode: 0, passed: true, signal: null, timedOut: false },
      current: { exitCode: 1, passed: false, signal: null, timedOut: false },
      passed: false
    }
  ];
  const m3 = computeMetrics(results3);
  assert.equal(m3.passAt1, 1);
  assert.equal(m3.ssi, 0);
});

// Helper to setup a temporary hermetic git repo
function setupHermeticGitFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-harness-test-"));
  const repoRoot = path.join(tempDir, "repo");
  const evalRoot = path.join(tempDir, "eval");

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(evalRoot, "harness", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(evalRoot, "harness", "specs"), { recursive: true });

  // Init git repo
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@kins.ai"], { cwd: repoRoot, stdio: "ignore" });

  // Create base code file
  fs.writeFileSync(path.join(repoRoot, "app.js"), "module.exports = { value: 1 };\n", "utf-8");
  execFileSync("git", ["add", "app.js"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial base commit"], { cwd: repoRoot, stdio: "ignore" });

  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();

  return { tempDir, repoRoot, evalRoot, baseCommit };
}

// Assertion 1: {"in":"F2P base=fail,current=pass; P2P pass/pass","out":"exit 0; Pass@1=1; SSI=1"}
test("harness: F2P base=fail,current=pass and P2P pass/pass -> Pass@1=1, SSI=1, overall passed=true", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    // Current workspace changes app.js to value: 2
    fs.writeFileSync(path.join(repoRoot, "app.js"), "module.exports = { value: 2 };\n", "utf-8");

    // Hidden spec file
    const specContent = "trusted-spec-data";
    const specHash = crypto.createHash("sha256").update(specContent).digest("hex");
    fs.writeFileSync(path.join(evalRoot, "harness", "specs", "spec1.txt"), specContent, "utf-8");

    // Task 1: F2P - fails when value !== 2 (fails on base=1, passes on current=2)
    const taskF2P = {
      schemaVersion: 1,
      id: "task-01-f2p",
      title: "Update value to 2",
      kind: "f2p",
      command: {
        argv: [process.execPath, "-e", "const a = require('./app.js'); if (a.value !== 2) process.exit(1);"],
        timeoutMs: 10000
      },
      hiddenAssertions: [
        {
          path: "harness/specs/spec1.txt",
          sha256: specHash
        }
      ]
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-01.json"), JSON.stringify(taskF2P), "utf-8");

    // Task 2: P2P - passes when app.js exists (passes on base and current)
    const taskP2P = {
      schemaVersion: 1,
      id: "task-02-p2p",
      title: "Ensure app.js exists",
      kind: "p2p",
      command: {
        argv: [process.execPath, "-e", "require('./app.js'); process.exit(0);"],
        timeoutMs: 10000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-02.json"), JSON.stringify(taskP2P), "utf-8");

    const reportPath = path.join(tempDir, "report.json");
    const report = await runEvaluation({
      repoRoot,
      evalRoot,
      baseCommit,
      outputPath: reportPath
    });

    assert.equal(report.passed, true);
    assert.equal(report.metrics.passAt1, 1);
    assert.equal(report.metrics.ssi, 1);
    assert.ok(fs.existsSync(reportPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 2: {"in":"F2P base=fail,current=fail","out":"exit 1; Pass@1=0"}
test("harness: F2P base=fail,current=fail -> Pass@1=0, overall passed=false", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    // Current workspace did NOT fix app.js (value is still 1)
    const taskF2P = {
      schemaVersion: 1,
      id: "task-01-f2p",
      title: "Update value to 2",
      kind: "f2p",
      command: {
        argv: [process.execPath, "-e", "const a = require('./app.js'); if (a.value !== 2) process.exit(1);"],
        timeoutMs: 10000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-01.json"), JSON.stringify(taskF2P), "utf-8");

    const taskP2P = {
      schemaVersion: 1,
      id: "task-02-p2p",
      title: "Regression check",
      kind: "p2p",
      command: {
        argv: [process.execPath, "-e", "process.exit(0);"],
        timeoutMs: 10000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-02.json"), JSON.stringify(taskP2P), "utf-8");

    const report = await runEvaluation({
      repoRoot,
      evalRoot,
      baseCommit,
      outputPath: path.join(tempDir, "report.json")
    });

    assert.equal(report.passed, false);
    assert.equal(report.metrics.passAt1, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 3: {"in":"P2P base=pass,current=fail","out":"exit 1; SSI=0"}
test("harness: P2P base=pass,current=fail -> SSI=0, overall passed=false", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    // Current workspace breaks app.js
    fs.writeFileSync(path.join(repoRoot, "app.js"), "throw new Error('syntax crash');\n", "utf-8");

    const taskF2P = {
      schemaVersion: 1,
      id: "task-01-f2p",
      title: "Sample feature",
      kind: "f2p",
      command: {
        argv: [process.execPath, "-e", "if (process.env.KINS_EVAL_MODE === 'base') process.exit(1); else process.exit(0);"],
        timeoutMs: 10000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-01.json"), JSON.stringify(taskF2P), "utf-8");

    const taskP2P = {
      schemaVersion: 1,
      id: "task-02-p2p",
      title: "Ensure app runs without crash",
      kind: "p2p",
      command: {
        argv: [process.execPath, "app.js"],
        timeoutMs: 10000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-02.json"), JSON.stringify(taskP2P), "utf-8");

    const report = await runEvaluation({
      repoRoot,
      evalRoot,
      baseCommit,
      outputPath: path.join(tempDir, "report.json")
    });

    assert.equal(report.passed, false);
    assert.equal(report.metrics.ssi, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 4: {"in":"hidden assertion hash mismatch","out":"exit 2; no tasks executed"}
test("harness: hidden assertion hash mismatch throws integrity error before running tasks", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    fs.writeFileSync(path.join(evalRoot, "harness", "specs", "spec.txt"), "tampered-content", "utf-8");

    const taskWithTamperedAssertion = {
      schemaVersion: 1,
      id: "task-01-tampered",
      title: "Tampered assertion task",
      kind: "f2p",
      command: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 5000
      },
      hiddenAssertions: [
        {
          path: "harness/specs/spec.txt",
          sha256: "0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-01.json"), JSON.stringify(taskWithTamperedAssertion), "utf-8");

    await assert.rejects(
      async () => {
        await runEvaluation({
          repoRoot,
          evalRoot,
          baseCommit,
          outputPath: path.join(tempDir, "report.json")
        });
      },
      /TAMPERING DETECTED/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Assertion 5: {"in":"two equivalent runs","out":"byte-identical JSON reports"}
test("harness: two equivalent runs produce byte-identical reports", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    const taskP2P = {
      schemaVersion: 1,
      id: "task-p2p",
      title: "Deterministic P2P",
      kind: "p2p",
      command: {
        argv: [process.execPath, "-e", "process.exit(0);"],
        timeoutMs: 5000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-p2p.json"), JSON.stringify(taskP2P), "utf-8");

    const taskF2P = {
      schemaVersion: 1,
      id: "task-f2p",
      title: "Deterministic F2P",
      kind: "f2p",
      command: {
        argv: [process.execPath, "-e", "if (process.env.KINS_EVAL_MODE === 'base') process.exit(1); else process.exit(0);"],
        timeoutMs: 5000
      },
      hiddenAssertions: []
    };
    fs.writeFileSync(path.join(evalRoot, "harness", "tasks", "task-f2p.json"), JSON.stringify(taskF2P), "utf-8");

    const out1 = path.join(tempDir, "out1.json");
    const out2 = path.join(tempDir, "out2.json");

    await runEvaluation({ repoRoot, evalRoot, baseCommit, outputPath: out1 });
    await runEvaluation({ repoRoot, evalRoot, baseCommit, outputPath: out2 });

    const c1 = fs.readFileSync(out1, "utf-8");
    const c2 = fs.readFileSync(out2, "utf-8");
    assert.equal(c1, c2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("harness: zero discovered tasks returns schema-valid empty report with passed=true", async () => {
  const { tempDir, repoRoot, evalRoot, baseCommit } = setupHermeticGitFixture();
  try {
    // Note: No task files written to evalRoot/harness/tasks
    const out = path.join(tempDir, "empty-report.json");
    const report = await runEvaluation({ repoRoot, evalRoot, baseCommit, outputPath: out });

    assert.equal(report.passed, true);
    assert.equal(report.metrics.passAt1, 0);
    assert.equal(report.results.length, 0);
    assert.equal(report.violations.length, 0);
    assert.equal(fs.existsSync(out), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
