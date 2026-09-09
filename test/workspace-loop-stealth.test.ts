import test from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuleBundleCompilerService } from "../src/main/services/ruleBundleCompilerService.js";
import { GlobalIdeSyncService } from "../src/main/services/globalIdeSyncService.js";
import { WorkspaceStealthRuleService } from "../src/main/services/workspaceStealthRuleService.js";
import { LoopStateService, resolveLoopStatePath } from "../src/main/services/LoopStateService.js";
import { buildSanitizedPtyEnv } from "../src/main/services/PtyService.js";
import type { WorkspaceContext } from "../src/shared/contracts.js";

// Golden Assertion 1: {"in":"project has no .ai/","out":"state stored at <sidecar>/state/state.json; no .ai created"}
test("Assertion 1: project has no .ai/ -> state stored at <sidecar>/state/state.json; no .ai created", async () => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "kins-clean-repo-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-sidecar-"));

  try {
    fs.writeFileSync(path.join(tempRepo, "app.js"), "console.log('clean');");

    // 1. Path resolver check
    const resolvedStatePath = resolveLoopStatePath(tempRepo, tempSidecar);
    const expectedStatePath = path.join(path.resolve(tempSidecar), "state", "state.json");
    assert.equal(resolvedStatePath, expectedStatePath);

    // 2. Service execution check
    const loopService = new LoopStateService(path.join(tempRepo, ".ai", "state.json"));
    try {
      await loopService.setProjectRoot(tempRepo, tempSidecar);

      assert.equal(loopService.getStateFilePath(), expectedStatePath);
      // Ensure target repo is NOT polluted with .ai/
      assert.equal(fs.existsSync(path.join(tempRepo, ".ai")), false);
    } finally {
      loopService.dispose();
    }
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Golden Assertion 2: {"in":"global sync run twice with user text","out":"one Kin block; user text preserved; bytes stable"}
test("Assertion 2: global sync run twice with user text -> one Kin block; user text preserved; bytes stable", async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kins-fake-home-"));

  try {
    const geminiDir = path.join(fakeHome, ".gemini");
    const claudeDir = path.join(fakeHome, ".claude");
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    const userGeminiText = "# User Gemini Preference\nAlways answer with high precision.\n";
    const userClaudeText = "# User Claude Notes\nPreferences for Claude.\n";

    fs.writeFileSync(path.join(geminiDir, "GEMINI.md"), userGeminiText, "utf-8");
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), userClaudeText, "utf-8");

    const compiler = new RuleBundleCompilerService();
    const syncService = new GlobalIdeSyncService(compiler, fakeHome);

    // Run 1
    const res1 = await syncService.sync();
    assert.equal(res1.success, true);
    assert.equal(res1.synced.length, 3);

    const geminiContentRun1 = fs.readFileSync(path.join(geminiDir, "GEMINI.md"), "utf-8");
    const claudeContentRun1 = fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf-8");
    const cursorRulePath = path.join(fakeHome, ".cursor", "rules", "kins-autonomous-loop.mdc");
    assert.equal(fs.existsSync(cursorRulePath), true);
    const cursorContentRun1 = fs.readFileSync(cursorRulePath, "utf-8");

    // Check user text preserved
    assert.ok(geminiContentRun1.includes("Always answer with high precision"));
    assert.ok(claudeContentRun1.includes("Preferences for Claude"));

    // Check exactly one Kin block in each file
    const geminiMatches = geminiContentRun1.match(/<!-- KINS:BEGIN UNIVERSAL RULES -->/g);
    assert.equal(geminiMatches?.length, 1);
    const claudeMatches = claudeContentRun1.match(/<!-- KINS:BEGIN UNIVERSAL RULES -->/g);
    assert.equal(claudeMatches?.length, 1);

    // Run 2: Idempotency & byte stability
    const res2 = await syncService.sync();
    assert.equal(res2.success, true);

    const geminiContentRun2 = fs.readFileSync(path.join(geminiDir, "GEMINI.md"), "utf-8");
    const claudeContentRun2 = fs.readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf-8");
    const cursorContentRun2 = fs.readFileSync(cursorRulePath, "utf-8");

    assert.equal(geminiContentRun2, geminiContentRun1);
    assert.equal(claudeContentRun2, claudeContentRun1);
    assert.equal(cursorContentRun2, cursorContentRun1);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Golden Assertion 3: {"in":"equip in clean Git worktree","out":"AGENTS.md and CLAUDE.md are git-ignored; status clean"}
test("Assertion 3: equip in clean Git worktree -> AGENTS.md and CLAUDE.md are git-ignored; status clean", async () => {
  const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "kins-git-stealth-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-stealth-sidecar-"));

  try {
    execSync("git init", { cwd: tempGit, stdio: "pipe" });
    fs.writeFileSync(path.join(tempGit, "index.ts"), "export const x = 1;");
    execSync("git add index.ts && git -c user.name=Test -c user.email=test@example.com commit -m 'initial'", {
      cwd: tempGit,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: "v1:testworktree",
      root: path.resolve(tempGit),
      displayName: "git-test",
      sidecarDirectory: path.resolve(tempSidecar),
      rules: []
    };

    const compiler = new RuleBundleCompilerService();
    const stealthService = new WorkspaceStealthRuleService(compiler);

    const equipRes = await stealthService.equip(context);
    assert.equal(equipRes.success, true);
    assert.equal(equipRes.filesCreated.length, 2);
    assert.equal(equipRes.excluded, true);

    // Ensure files exist on disk
    assert.equal(fs.existsSync(path.join(tempGit, "AGENTS.md")), true);
    assert.equal(fs.existsSync(path.join(tempGit, "CLAUDE.md")), true);

    // Invariant: Git status MUST remain 100% clean (zero git pollution)
    const status = execSync("git status --porcelain", { cwd: tempGit, encoding: "utf-8" });
    assert.equal(status.trim(), "");

    // Status check
    const stealthStatus = await stealthService.getStatus(context);
    assert.equal(stealthStatus.equipped, true);
    assert.equal(stealthStatus.excluded, true);
  } finally {
    fs.rmSync(tempGit, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Golden Assertion 4: {"in":"unequip after Kin file modified","out":"modified file preserved; no destructive deletion"}
test("Assertion 4: unequip after Kin file modified -> modified file preserved; no destructive deletion", async () => {
  const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "kins-git-mod-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-mod-sidecar-"));

  try {
    execSync("git init", { cwd: tempGit, stdio: "pipe" });
    fs.writeFileSync(path.join(tempGit, "file.txt"), "hello");
    execSync("git add file.txt && git -c user.name=Test -c user.email=test@example.com commit -m 'initial'", {
      cwd: tempGit,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: "v1:modworktree",
      root: path.resolve(tempGit),
      displayName: "git-mod-test",
      sidecarDirectory: path.resolve(tempSidecar),
      rules: []
    };

    const compiler = new RuleBundleCompilerService();
    const stealthService = new WorkspaceStealthRuleService(compiler);

    await stealthService.equip(context);

    // User modifies AGENTS.md
    fs.appendFileSync(path.join(tempGit, "AGENTS.md"), "\n## User Custom Invariant\nNever delete this.", "utf-8");

    // Unequip
    const unequipRes = await stealthService.unequip(context);
    assert.equal(unequipRes.success, true);
    // Unmodified CLAUDE.md should be removed
    assert.ok(unequipRes.filesRemoved.some((p) => p.endsWith("CLAUDE.md")));
    // Modified AGENTS.md must NOT be removed
    assert.ok(!unequipRes.filesRemoved.some((p) => p.endsWith("AGENTS.md")));
    assert.equal(fs.existsSync(path.join(tempGit, "AGENTS.md")), true);
    assert.equal(fs.existsSync(path.join(tempGit, "CLAUDE.md")), false);
  } finally {
    fs.rmSync(tempGit, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Golden Assertion 5: {"in":"packaged PTY startup","out":"KINS_* paths are absolute and harness files exist"}
test("Assertion 5: packaged PTY startup -> KINS_* paths are absolute and harness files exist", async () => {
  const context: WorkspaceContext = {
    id: "v1:ptytest",
    root: path.resolve(process.cwd()),
    displayName: "pty-test",
    sidecarDirectory: path.resolve("C:\\fakeUserData\\workspaces\\v1:ptytest"),
    rules: []
  };

  const env = buildSanitizedPtyEnv(process.env, context);

  assert.equal(env["KINS_WORKSPACE_ID"], context.id);
  assert.equal(env["KINS_WORKSPACE_ROOT"], context.root);
  assert.equal(env["KINS_SIDECAR_DIR"], context.sidecarDirectory);
  assert.equal(env["KINS_COCKPIT_ACTIVE"], "1");

  // Verify all paths are absolute
  assert.ok(path.isAbsolute(env["KINS_WORKSPACE_ROOT"]!));
  assert.ok(path.isAbsolute(env["KINS_SIDECAR_DIR"]!));
  assert.ok(path.isAbsolute(env["KINS_HARNESS_DIR"]!));
  assert.ok(path.isAbsolute(env["KINS_AQI_HARNESS"]!));
  assert.ok(path.isAbsolute(env["KINS_LOOP_SCRIPT"]!));

  // Verify harness files exist on disk in current repo/app root
  assert.equal(fs.existsSync(env["KINS_AQI_HARNESS"]!), true);
  assert.equal(fs.existsSync(env["KINS_LOOP_SCRIPT"]!), true);
});
