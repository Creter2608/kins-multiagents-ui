import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { ProjectService, type ProjectScopedServices } from "../src/main/services/ProjectService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When compiled to dist/test, go up two directories; when in test, go up one directory
const APP_ROOT = fs.existsSync(path.join(__dirname, "..", "scripts"))
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "../..");
const AI_LOOP_SCRIPT = path.join(APP_ROOT, "scripts", "ai-loop.mjs");
const PITFALL_URL = pathToFileURL(path.join(APP_ROOT, "scripts", "harness", "pitfall-matcher.mjs")).href;
const { resolvePitfallsPath, matchPitfalls, parsePitfallsCatalog } = (await import(PITFALL_URL)) as typeof import("../scripts/harness/pitfall-matcher.d.mts");

function createTempGitRepo(prefix = "ext-repo-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("Assertion 1: --project-root routes all Git, state, and evaluation operations to target repo, never app repo", () => {
  const extDir = createTempGitRepo("ext-target-");
  const randomCwd = fs.mkdtempSync(path.join(os.tmpdir(), "random-cwd-"));

  try {
    // Initial commit in target repo so git commands succeed
    fs.writeFileSync(path.join(extDir, "README.md"), "# External Target\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: extDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: extDir, stdio: "ignore" });

    // 1. Run ai-loop init with --project-root from unrelated cwd
    const initOutput = execFileSync(
      "node",
      [AI_LOOP_SCRIPT, "init", "--project-root", extDir, "--run-id", "test-ext-1", "--json"],
      { cwd: randomCwd, encoding: "utf-8" }
    );
    const initState = JSON.parse(initOutput);
    assert.equal(initState.runId, "test-ext-1");
    assert.equal(initState.currentPhase, "INITIALIZE");

    // Verify state was written to extDir/.ai/state.json, NOT in randomCwd or APP_ROOT
    const extStateFile = path.join(extDir, ".ai", "state.json");
    assert.ok(fs.existsSync(extStateFile), "State file must exist in target repo");
    assert.ok(!fs.existsSync(path.join(randomCwd, ".ai", "state.json")), "State file must NOT exist in cwd");

    // 2. Run transition SPEC_GATE
    const transOutput = execFileSync(
      "node",
      [AI_LOOP_SCRIPT, "transition", "SPEC_GATE", "--project-root", extDir, "--json"],
      { cwd: randomCwd, encoding: "utf-8" }
    );
    const transState = JSON.parse(transOutput);
    assert.equal(transState.currentPhase, "SPEC_GATE");

    // 3. Run isolate --task test-task-1
    const isolateOutput = execFileSync(
      "node",
      [AI_LOOP_SCRIPT, "isolate", "--task", "test-task-1", "--project-root", extDir, "--json"],
      { cwd: randomCwd, encoding: "utf-8" }
    );
    const isolateRes = JSON.parse(isolateOutput);
    assert.equal(isolateRes.taskId, "test-task-1");
    assert.equal(path.resolve(isolateRes.worktree), path.resolve(extDir, ".worktrees", "test-task-1"));
    assert.ok(fs.existsSync(path.join(extDir, ".worktrees", "test-task-1")), "Worktree must be inside target project");

    // 4. Run status with --project-root
    const statusOutput = execFileSync(
      "node",
      [AI_LOOP_SCRIPT, "status", "--project-root", extDir, "--json"],
      { cwd: randomCwd, encoding: "utf-8" }
    );
    const statusState = JSON.parse(statusOutput);
    assert.equal(statusState.currentPhase, "SPEC_GATE");
  } finally {
    // Cleanup worktrees before removing directory
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: extDir, stdio: "ignore" });
    } catch {}
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(randomCwd, { recursive: true, force: true });
  }
});

test("Assertion 2: TranscriptIngestionService clears watchers/state on switch and ignores delayed events from previous project", async () => {
  const dirA = createTempGitRepo("proj-a-");
  const dirB = createTempGitRepo("proj-b-");
  const telemetryService = new TelemetryService();
  const mcpService = new McpMonitorService(dirA);
  const transcriptService = new TranscriptIngestionService(telemetryService, mcpService, null, null, null);

  try {
    await transcriptService.setProjectRoot(dirA);
    const initialGen = transcriptService.getSessionGeneration();

    // Ingest a line in project A
    const sampleGptLineA = "📊 [GPT Token Usage]: Input: 150 (Cached: 0) | Output: 50 | Total: 200";
    transcriptService.processLine(sampleGptLineA, initialGen);

    const snapA = telemetryService.getSnapshot();
    assert.equal(snapA.gptPromptTokens, 150);
    assert.equal(snapA.gptCompletionTokens, 50);

    // Switch to project B
    await transcriptService.setProjectRoot(dirB);
    telemetryService.resetCurrentSession();
    assert.equal(transcriptService.getSessionGeneration(), initialGen + 1);

    // Verify session counters were reset
    const snapBReset = telemetryService.getSnapshot();
    assert.equal(snapBReset.gptPromptTokens, 0);
    assert.equal(snapBReset.gptCompletionTokens, 0);

    // Late event arrives from Project A with old generation
    const lateGptLineA = "📊 [GPT Token Usage]: Input: 300 (Cached: 0) | Output: 100 | Total: 400";
    transcriptService.processLine(lateGptLineA, initialGen); // older generation!

    // Late event MUST BE IGNORED
    const snapAfterLate = telemetryService.getSnapshot();
    assert.equal(snapAfterLate.gptPromptTokens, 0, "Late event from prior generation must be ignored");
    assert.equal(snapAfterLate.gptCompletionTokens, 0, "Late event from prior generation must be ignored");

    // Event arriving with current generation is processed
    const freshGptLineB = "📊 [GPT Token Usage]: Input: 80 (Cached: 0) | Output: 20 | Total: 100";
    transcriptService.processLine(freshGptLineB, transcriptService.getSessionGeneration());
    const snapB = telemetryService.getSnapshot();
    assert.equal(snapB.gptPromptTokens, 80);
    assert.equal(snapB.gptCompletionTokens, 20);
  } finally {
    transcriptService.dispose();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test("Assertion 3: resolvePitfallsPath selects project-local wiki when present", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pitfall-local-"));
  try {
    const wikiDir = path.join(targetDir, "wiki");
    fs.mkdirSync(wikiDir, { recursive: true });
    const localPitfalls = path.join(wikiDir, "pitfalls.md");
    fs.writeFileSync(localPitfalls, "| ID | Name | Class | Symptom | Invariant |\n|---|---|---|---|---|\n| **PITFALL-999** | Custom Pitfall | Custom | Test Symptom | Test Invariant |\n", "utf-8");

    const resolved = resolvePitfallsPath({
      targetProjectRoot: targetDir,
      appRoot: APP_ROOT
    });

    assert.ok(resolved !== null);
    assert.equal(path.resolve(resolved), path.resolve(localPitfalls));

    const catalog = parsePitfallsCatalog({ targetProjectRoot: targetDir, appRoot: APP_ROOT });
    assert.ok(catalog.some((e) => e.id === "PITFALL-999"));
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test("Assertion 4: resolvePitfallsPath selects packaged read-only fallback when project lacks wiki", () => {
  const emptyTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pitfall-fallback-"));
  try {
    const resolved = resolvePitfallsPath({
      targetProjectRoot: emptyTargetDir,
      appRoot: APP_ROOT
    });

    const expectedAppWiki = path.join(APP_ROOT, "wiki", "pitfalls.md");
    assert.ok(resolved !== null);
    assert.equal(path.resolve(resolved), path.resolve(expectedAppWiki));

    const matchRes = matchPitfalls("worktree isolation git", {
      targetProjectRoot: emptyTargetDir,
      appRoot: APP_ROOT
    });
    assert.ok(matchRes.matches.length > 0, "Packaged fallback must match invariant pitfalls");
  } finally {
    fs.rmSync(emptyTargetDir, { recursive: true, force: true });
  }
});

test("Assertion 5: Initialized repo with unborn HEAD opens safely; worktree isolation reports actionable error without auto-commit", () => {
  const unbornDir = fs.mkdtempSync(path.join(os.tmpdir(), "unborn-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: unbornDir, stdio: "ignore" });

  try {
    // 1. Initializing state in unborn repo succeeds without modifying or committing files
    const initOutput = execFileSync(
      "node",
      [AI_LOOP_SCRIPT, "init", "--project-root", unbornDir, "--run-id", "unborn-test-1", "--json"],
      { encoding: "utf-8" }
    );
    const initState = JSON.parse(initOutput);
    assert.equal(initState.currentPhase, "INITIALIZE");

    // Verify no commits were created
    let hasCommits = true;
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: unbornDir, stdio: "ignore" });
    } catch {
      hasCommits = false;
    }
    assert.equal(hasCommits, false, "Repo must remain unborn without automated commits");

    // 2. Isolate on unborn HEAD throws clear, actionable error instead of crashing or corrupting git
    assert.throws(() => {
      execFileSync(
        "node",
        [AI_LOOP_SCRIPT, "isolate", "--task", "unborn-task", "--project-root", unbornDir],
        { stdio: "pipe" }
      );
    }, /unborn HEAD|initial commit is required/i);
  } finally {
    fs.rmSync(unbornDir, { recursive: true, force: true });
  }
});
