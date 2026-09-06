import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

function setupTestGitRepo(prefix = "ext-repo-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("builtin judge: external repository with commit and no local judge uses built-in judge fallback", async () => {
  const repoDir = setupTestGitRepo("ext-repo-clean-");
  try {
    fs.writeFileSync(path.join(repoDir, "index.ts"), "export const hello = 'world';\n", "utf-8");
    execFileSync("git", ["add", "index.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: initial commit"], { cwd: repoDir, stdio: "ignore" });

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.ok(compliance !== null, "Compliance should not be null");
    assert.strictEqual(typeof compliance.aqi, "number");
    assert.strictEqual(compliance.taskType, "feat");
    assert.ok(compliance.aqi >= 3.0, "Clean commit should receive acceptable AQI");
    assert.strictEqual(service.getSnapshot().architecturalCompliance?.taskType, "feat");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: external repository with staged changes evaluates active repoRoot diff", async () => {
  const repoDir = setupTestGitRepo("ext-repo-staged-");
  try {
    fs.writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1;\n", "utf-8");
    execFileSync("git", ["add", "a.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

    // Stage a change that adds a console.log debug statement
    fs.writeFileSync(path.join(repoDir, "a.ts"), "export const a = 1;\nconsole.log('DEBUG: test');\n", "utf-8");
    execFileSync("git", ["add", "a.ts"], { cwd: repoDir, stdio: "ignore" });

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.ok(compliance !== null, "Compliance should not be null");
    assert.ok(
      compliance.feedback.some((f: string) => f.toLowerCase().includes("debug")),
      "Should detect staged debug statement in target repo"
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: repository-local judge overrides built-in fallback and receives repoRoot and taskType", async () => {
  const repoDir = setupTestGitRepo("ext-repo-custom-judge-");
  try {
    fs.writeFileSync(path.join(repoDir, "file.ts"), "export const x = 1;\n", "utf-8");
    execFileSync("git", ["add", "file.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "refactor: custom judge test"], { cwd: repoDir, stdio: "ignore" });

    // Create custom local judge at scripts/harness/judge.mjs
    const harnessDir = path.join(repoDir, "scripts", "harness");
    fs.mkdirSync(harnessDir, { recursive: true });
    const customJudgeCode = `
      export function evaluateArchitecturalCompliance(diff, options = {}) {
        return {
          aqi: 4.9,
          passed: true,
          criteriaScores: { surgicalDiff: 5, simplicity: 5, modularity: 4.8, maintainability: 4.8 },
          feedback: ["Custom local judge executed successfully"],
          taskType: options.taskType || "custom"
        };
      }
    `;
    fs.writeFileSync(path.join(harnessDir, "judge.mjs"), customJudgeCode, "utf-8");

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.ok(compliance !== null, "Compliance should not be null");
    assert.strictEqual(compliance.aqi, 4.9);
    assert.strictEqual(compliance.feedback[0], "Custom local judge executed successfully");
    assert.strictEqual(compliance.taskType, "refactor");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: external repository entering COMPLETE populates compliance snapshot automatically", async () => {
  const repoDir = setupTestGitRepo("ext-repo-complete-");
  try {
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const ready = true;\n", "utf-8");
    execFileSync("git", ["add", "app.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: ready for release"], { cwd: repoDir, stdio: "ignore" });

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    // Advance to COMPLETE
    service.advanceToPhase("COMPLETE", "Done");
    // Wait for async evaluateArchitecture to complete
    await new Promise((r) => setTimeout(r, 100));

    const snapshot = service.getSnapshot();
    assert.ok(snapshot.architecturalCompliance !== undefined, "architecturalCompliance must be populated on COMPLETE");
    assert.strictEqual(typeof snapshot.architecturalCompliance.aqi, "number");
    assert.strictEqual(snapshot.architecturalCompliance.taskType, "feat");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: setProjectRoot on external git repo resets prior state and proactively evaluates architecture", async () => {
  const repoDir = setupTestGitRepo("ext-repo-switch-");
  try {
    fs.writeFileSync(path.join(repoDir, "code.ts"), "export function run() {}\n", "utf-8");
    execFileSync("git", ["add", "code.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init project"], { cwd: repoDir, stdio: "ignore" });

    const initialService = new LoopStateService(path.resolve(".ai/state.json"));
    initialService.setAppRootForTesting(process.cwd());

    await initialService.setProjectRoot(repoDir);
    // Allow background evaluation
    await new Promise((r) => setTimeout(r, 100));

    const snapshot = initialService.getSnapshot();
    assert.ok(snapshot.architecturalCompliance !== undefined, "Switched project should have architecturalCompliance evaluated");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: clean tree with docs-only HEAD looks back to previous code commit and extracts taskType", async () => {
  const repoDir = setupTestGitRepo("ext-repo-docs-head-");
  try {
    // 1. First commit with code: feat
    fs.writeFileSync(path.join(repoDir, "service.ts"), "export const serviceActive = true;\n", "utf-8");
    execFileSync("git", ["add", "service.ts"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implement core service"], { cwd: repoDir, stdio: "ignore" });

    // 2. Second commit with only docs
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Project Readme\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs(wiki): record delivery"], { cwd: repoDir, stdio: "ignore" });

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.ok(compliance !== null, "Compliance should not be null");
    assert.strictEqual(compliance.taskType, "feat", "taskType should be derived from the code commit, not docs");
    const metrics = (compliance as any)?.metrics;
    assert.ok(metrics && metrics.productionFiles >= 1, "Should have evaluated the production code file");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: repository with only documentation commits returns null", async () => {
  const repoDir = setupTestGitRepo("ext-repo-docs-only-");
  try {
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(repoDir, `doc${i}.md`), `# Doc ${i}\n`, "utf-8");
      execFileSync("git", ["add", `doc${i}.md`], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `docs: update doc ${i}`], { cwd: repoDir, stdio: "ignore" });
    }

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.strictEqual(compliance, null, "Should return null when all commits are documentation-only");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("builtin judge: dirty code in working tree takes precedence over docs commit at HEAD", async () => {
  const repoDir = setupTestGitRepo("ext-repo-dirty-precedence-");
  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Init Docs\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs: initialize documentation"], { cwd: repoDir, stdio: "ignore" });

    // Modify a code file in working tree (dirty)
    fs.writeFileSync(path.join(repoDir, "worker.ts"), "export function doWork() {}\n", "utf-8");
    execFileSync("git", ["add", "worker.ts"], { cwd: repoDir, stdio: "ignore" });

    const stateFile = path.join(repoDir, ".ai", "state.json");
    const service = new LoopStateService(stateFile);
    service.setAppRootForTesting(process.cwd());

    const compliance = await service.evaluateArchitecture();
    assert.ok(compliance !== null, "Compliance should not be null for dirty code");
    const metrics = (compliance as any)?.metrics;
    assert.ok(metrics && metrics.productionFiles >= 1, "Should evaluate the working-tree code file");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
