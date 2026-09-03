import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "ai-loop.mjs");

function runAiLoop(args: string[], cwd: string = REPO_ROOT): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      cwd,
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

test("ai-loop: rejects state files located within protected .eval/ directory", () => {
  const result = runAiLoop(["init", "--state-file", ".eval/malicious_state.json"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Security invariant violation") || result.stderr.includes("CONFIG_INVALID"));
});

test("ai-loop: full lifecycle from init to transition and verification", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-loop-test-"));
  const stateFile = path.join(tempDir, "test-state.json");

  try {
    // 1. Init
    const initRes = runAiLoop(["init", "--state-file", stateFile, "--run-id", "test-run-42", "--json"]);
    assert.equal(initRes.status, 0, `Init failed: ${initRes.stderr}`);
    const initState = JSON.parse(initRes.stdout);
    assert.equal(initState.runId, "test-run-42");
    assert.equal(initState.currentPhase, "INITIALIZE");
    assert.equal(initState.status, "ready");

    // 2. Status
    const statusRes = runAiLoop(["status", "--state-file", stateFile, "--json"]);
    assert.equal(statusRes.status, 0);
    const statusState = JSON.parse(statusRes.stdout);
    assert.equal(statusState.runId, "test-run-42");

    // 3. Legal Transition
    const transRes = runAiLoop(["transition", "SPEC_GATE", "--state-file", stateFile, "--json"]);
    assert.equal(transRes.status, 0, `Transition failed: ${transRes.stderr}`);
    const transState = JSON.parse(transRes.stdout);
    assert.equal(transState.currentPhase, "SPEC_GATE");
    assert.equal(transState.status, "running");
    assert.equal(transState.usage.transitions, 1);

    // 4. Illegal Transition (skipping to COMPLETE)
    const illegalRes = runAiLoop(["transition", "COMPLETE", "--state-file", stateFile]);
    assert.equal(illegalRes.status, 1);
    assert.ok(illegalRes.stderr.includes("TRANSITION_INVALID"));

    // 5. Retry budget consumption
    const retry1 = runAiLoop(["retry", "1", "--state-file", stateFile, "--json"]);
    assert.equal(retry1.status, 0);
    const retry1State = JSON.parse(retry1.stdout);
    assert.equal(retry1State.usage.retries, 1);

    const retry2 = runAiLoop(["retry", "1", "--state-file", stateFile, "--json"]);
    assert.equal(retry2.status, 0);
    const retry2State = JSON.parse(retry2.stdout);
    assert.equal(retry2State.usage.retries, 2);

    // 6. Exceeding retry budget
    const retryExhausted = runAiLoop(["retry", "1", "--state-file", stateFile]);
    assert.equal(retryExhausted.status, 1);
    assert.ok(retryExhausted.stderr.includes("BUDGET_EXHAUSTED"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ai-loop: verify checks workspace against golden assertions", () => {
  const result = runAiLoop(["verify", "--json"]);
  assert.equal(result.status, 0, `Verify failed: ${result.stderr}`);
  const assertions = JSON.parse(result.stdout);
  assert.ok(Array.isArray(assertions));
  assert.ok(assertions.length > 0);
  assert.ok(assertions.every((a: { passed: boolean }) => a.passed === true));
});

test("ai-loop: rollback persists preceding phase and trims history", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-loop-rb-"));
  const stateFile = path.join(tempDir, "state.json");

  try {
    const initRes = runAiLoop(["init", "--state-file", stateFile, "--json"]);
    assert.equal(initRes.status, 0);

    const transRes = runAiLoop(["transition", "SPEC_GATE", "--state-file", stateFile, "--json"]);
    assert.equal(transRes.status, 0);
    const transState = JSON.parse(transRes.stdout);
    assert.equal(transState.currentPhase, "SPEC_GATE");

    const rbRes = runAiLoop(["rollback", "--state-file", stateFile, "--json"]);
    assert.equal(rbRes.status, 0, `Rollback failed: ${rbRes.stderr}`);
    const rbState = JSON.parse(rbRes.stdout);
    assert.equal(rbState.currentPhase, "INITIALIZE");
    assert.equal(rbState.status, "ready");
    assert.equal(rbState.history.length, 0);

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    assert.equal(persisted.currentPhase, "INITIALIZE");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ai-loop: invalid rollback exits non-zero and leaves persisted state unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-loop-rb-invalid-"));
  const stateFile = path.join(tempDir, "state.json");

  try {
    runAiLoop(["init", "--state-file", stateFile, "--json"]);
    const beforeContent = fs.readFileSync(stateFile, "utf-8");

    const rbRes = runAiLoop(["rollback", "--state-file", stateFile]);
    assert.equal(rbRes.status, 1);
    assert.ok(rbRes.stderr.includes("STATE_INVALID"));

    const afterContent = fs.readFileSync(stateFile, "utf-8");
    assert.equal(afterContent, beforeContent);

    const unknownOpt = runAiLoop(["rollback", "--unknown-opt", "--state-file", stateFile]);
    assert.equal(unknownOpt.status, 1);
    assert.ok(unknownOpt.stderr.includes("CONFIG_INVALID"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ai-loop: rollback --code restores tracked edits while preserving untracked files", () => {
  const tempGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-loop-git-rb-"));
  const stateFile = path.join(tempGitDir, "state.json");

  try {
    execFileSync("git", ["init"], { cwd: tempGitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempGitDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "runner@test.local"], { cwd: tempGitDir, stdio: "ignore" });

    const trackedFile = path.join(tempGitDir, "tracked.txt");
    fs.writeFileSync(trackedFile, "clean baseline\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: tempGitDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempGitDir, stdio: "ignore" });

    runAiLoop(["init", "--state-file", stateFile, "--json"], tempGitDir);
    runAiLoop(["transition", "SPEC_GATE", "--state-file", stateFile, "--json"], tempGitDir);

    fs.writeFileSync(trackedFile, "dirty modified content\n", "utf-8");
    const untrackedFile = path.join(tempGitDir, "scratch.tmp");
    fs.writeFileSync(untrackedFile, "should survive rollback\n", "utf-8");

    const rbRes = runAiLoop(["rollback", "--code", "--state-file", stateFile, "--json"], tempGitDir);
    assert.equal(rbRes.status, 0, `Rollback --code failed: ${rbRes.stderr}`);
    const rbState = JSON.parse(rbRes.stdout);
    assert.equal(rbState.currentPhase, "INITIALIZE");

    assert.equal(fs.readFileSync(trackedFile, "utf-8"), "clean baseline\n");

    assert.ok(fs.existsSync(untrackedFile), "Untracked file must be preserved");
    assert.equal(fs.readFileSync(untrackedFile, "utf-8"), "should survive rollback\n");
  } finally {
    fs.rmSync(tempGitDir, { recursive: true, force: true });
  }
});
