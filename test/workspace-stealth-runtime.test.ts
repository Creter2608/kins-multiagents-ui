import test from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import { WorkspaceStealthRuleService } from "../src/main/services/workspaceStealthRuleService.js";
import { RuleBundleCompilerService } from "../src/main/services/ruleBundleCompilerService.js";
import {
  STEALTH_TRANSPARENCY_TAG,
  type ActiveStealthRules,
  type WorkspaceContext
} from "../src/shared/contracts.js";
import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";

// Helper to create disposable Git worktree
function createTestWorkspace(): { workspaceDir: string; sidecarDir: string; context: WorkspaceContext } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-stealth-ws-"));
  const sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-stealth-sidecar-"));

  execSync("git init", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git config user.name 'Test Runner'", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git config user.email 'test@example.com'", { cwd: workspaceDir, stdio: "pipe" });

  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Test Project\n", "utf-8");
  execSync('git add README.md && git commit -m "Initial commit"', { cwd: workspaceDir, stdio: "pipe" });

  const context: WorkspaceContext = {
    id: `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    root: path.resolve(workspaceDir),
    displayName: "test-workspace",
    sidecarDirectory: path.resolve(sidecarDir),
    rules: []
  };

  return { workspaceDir, sidecarDir, context };
}

// -----------------------------------------------------------------------------
// Golden Assertion 1: compaction with active stealth -> one tagged anchor; unchanged Git status
// -----------------------------------------------------------------------------
test("GA-01: compaction with active stealth -> one tagged anchor; unchanged Git status", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const compiler = new RuleBundleCompilerService();
  const stealthService = new WorkspaceStealthRuleService(compiler, hookService);

  try {
    const equipRes = await stealthService.equip(context, { includeDesignPack: true });
    assert.equal(equipRes.success, true);

    // Initial git status must be completely clean (zero git diff)
    const initialStatus = execSync("git status --porcelain=v1", { cwd: workspaceDir, encoding: "utf-8" }).trim();
    assert.equal(initialStatus, "", "Git status must remain 100% clean after equip");

    // Simulate attention anchor retrieval (e.g. after compaction or turn start)
    const anchor1 = hookService.getAttentionAnchor(context.id);
    assert.ok(anchor1 !== undefined, "Attention anchor must be defined for active workspace");
    assert.ok(anchor1.startsWith(STEALTH_TRANSPARENCY_TAG), "Anchor must start with [KINS_STEALTH]");
    assert.ok(anchor1.includes("UI Zinc Palette"), "Anchor must specify UI Zinc Palette");

    // Retrieve again to simulate subsequent turns/compaction -> no side-effects on disk
    const anchor2 = hookService.getAttentionAnchor(context.id);
    assert.equal(anchor1, anchor2);

    const postCompactionStatus = execSync("git status --porcelain=v1", { cwd: workspaceDir, encoding: "utf-8" }).trim();
    assert.equal(postCompactionStatus, "", "Attention anchor generation must never pollute git working tree");
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Golden Assertion 2: batch edits protected and allowed files -> deny; zero writes
// -----------------------------------------------------------------------------
test("GA-02: batch edits protected and allowed files -> deny; zero writes", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const compiler = new RuleBundleCompilerService();
  const stealthService = new WorkspaceStealthRuleService(compiler, hookService);

  try {
    await stealthService.equip(context, { includeDesignPack: true });

    // File 1 is an allowed file, File 2 is a protected stealth manifest/rule file
    const allowedPath = path.join(workspaceDir, "src", "feature.ts");
    const protectedPath = path.join(workspaceDir, "AGENTS.md");

    const batchRequests = [
      { toolName: "write_to_file", targetPath: allowedPath, workspaceRoot: workspaceDir, workspaceId: context.id },
      { toolName: "write_to_file", targetPath: protectedPath, workspaceRoot: workspaceDir, workspaceId: context.id }
    ];

    let callbackInvoked = false;
    await assert.rejects(
      async () => {
        await hookService.executeBatchToolUse(batchRequests, async () => {
          callbackInvoked = true;
          fs.mkdirSync(path.dirname(allowedPath), { recursive: true });
          fs.writeFileSync(allowedPath, "console.log('injected');\n", "utf-8");
          return ["written-1", "written-2"];
        });
      },
      /\[KINS_STEALTH\] Batch execution denied: Prohibited target in batch\./
    );

    assert.equal(callbackInvoked, false, "Batch callback must NEVER be invoked on denied batch (zero writes)");
    assert.equal(fs.existsSync(allowedPath), false, "Allowed file must never have been created on disk");
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Golden Assertion 3: introduce forbidden UI color -> LEGACY_COLOR; token guidance
// -----------------------------------------------------------------------------
test("GA-03: introduce forbidden UI color -> LEGACY_COLOR; token guidance", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const compiler = new RuleBundleCompilerService();
  const stealthService = new WorkspaceStealthRuleService(compiler, hookService);

  try {
    await stealthService.equip(context, { includeDesignPack: true });

    // Case A: Introducing forbidden hex `#0c0c0c` into a React component
    const badComponentRequest = {
      toolName: "replace_file_content",
      targetPath: path.join(workspaceDir, "src", "renderer", "MyComponent.tsx"),
      projectedContent: 'export const MyComponent = () => <div className="bg-[#0c0c0c]">Hello</div>;',
      workspaceRoot: workspaceDir,
      workspaceId: context.id
    };

    const badDecision = hookService.evaluateStealthPolicy(badComponentRequest);
    assert.equal(badDecision.allowed, false);
    assert.equal(badDecision.metadata.violations[0]?.code, "LEGACY_COLOR");
    assert.ok(badDecision.metadata.violations[0]?.remediation.includes("Zinc tokens"));
    assert.ok(badDecision.denialMessage?.includes("[KINS_STEALTH]"));

    // Case B: Compliant edit using Zinc token `bg-zinc-900`
    const goodComponentRequest = {
      toolName: "replace_file_content",
      targetPath: path.join(workspaceDir, "src", "renderer", "MyComponent.tsx"),
      projectedContent: 'export const MyComponent = () => <div className="bg-zinc-900">Hello</div>;',
      workspaceRoot: workspaceDir,
      workspaceId: context.id
    };

    const goodDecision = hookService.evaluateStealthPolicy(goodComponentRequest);
    assert.equal(goodDecision.allowed, true);
    assert.equal(goodDecision.metadata.violations.length, 0);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Golden Assertion 4: edit after successful verification, then release -> VERIFICATION_REQUIRED
// -----------------------------------------------------------------------------
test("GA-04: edit after successful verification, then release -> VERIFICATION_REQUIRED", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const compiler = new RuleBundleCompilerService();
  const stealthService = new WorkspaceStealthRuleService(compiler, hookService);

  try {
    await stealthService.equip(context, { includeDesignPack: true });

    const releaseRequest = {
      toolName: "release_gate_approval",
      workspaceRoot: workspaceDir,
      workspaceId: context.id,
      isReleaseAction: true
    };

    // Step 1: Initial state before verification -> release denied with VERIFICATION_REQUIRED
    const initialDecision = hookService.evaluateStealthPolicy(releaseRequest);
    assert.equal(initialDecision.allowed, false);
    assert.equal(initialDecision.metadata.violations[0]?.code, "VERIFICATION_REQUIRED");
    assert.ok(initialDecision.metadata.violations[0]?.remediation.includes("Execute local tests"));
    assert.ok(initialDecision.denialMessage?.includes("[KINS_STEALTH] Denied:"));

    // Step 2: Passing verification recorded -> release allowed
    hookService.recordVerificationSuccess(context.id);
    assert.equal(hookService.isVerificationFresh(context.id), true);
    const verifiedDecision = hookService.evaluateStealthPolicy(releaseRequest);
    assert.equal(verifiedDecision.allowed, true);

    // Step 3: Allowed file edit occurs -> invalidates prior verification
    const allowedPath = path.join(workspaceDir, "src", "code.ts");
    await hookService.executeToolUse(
      { toolName: "write_to_file", targetPath: allowedPath, workspaceRoot: workspaceDir, workspaceId: context.id },
      async () => {
        fs.mkdirSync(path.dirname(allowedPath), { recursive: true });
        fs.writeFileSync(allowedPath, "export const x = 1;\n", "utf-8");
      }
    );
    assert.equal(hookService.isVerificationFresh(context.id), false);

    // Step 4: Post-edit release attempt -> denied with VERIFICATION_REQUIRED
    const postEditDecision = hookService.evaluateStealthPolicy(releaseRequest);
    assert.equal(postEditDecision.allowed, false);
    assert.equal(postEditDecision.metadata.violations[0]?.code, "VERIFICATION_REQUIRED");

    // Step 5: Fresh verification restored -> release re-authorized
    hookService.recordVerificationSuccess(context.id);
    assert.equal(hookService.isVerificationFresh(context.id), true);
    const reVerifiedDecision = hookService.evaluateStealthPolicy(releaseRequest);
    assert.equal(reVerifiedDecision.allowed, true);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Golden Assertion 5: opaque shell mutation under active stealth -> UNSUPPORTED_TOOL; one transparency tag
// -----------------------------------------------------------------------------
test("GA-05: opaque shell mutation under active stealth -> UNSUPPORTED_TOOL; one transparency tag", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const compiler = new RuleBundleCompilerService();
  const stealthService = new WorkspaceStealthRuleService(compiler, hookService);

  try {
    await stealthService.equip(context, { includeDesignPack: true });

    const opaqueToolRequest = {
      toolName: "bash",
      workspaceRoot: workspaceDir,
      workspaceId: context.id
    };

    const opaqueDecision = hookService.evaluateStealthPolicy(opaqueToolRequest);
    assert.equal(opaqueDecision.allowed, false);
    assert.equal(opaqueDecision.metadata.violations[0]?.code, "UNSUPPORTED_TOOL");
    assert.ok(opaqueDecision.denialMessage?.includes("[KINS_STEALTH]"));

    // Exactly one [KINS_STEALTH] tag in the denial message
    const tagMatches = (opaqueDecision.denialMessage?.match(/\[KINS_STEALTH\]/g) || []).length;
    assert.equal(tagMatches, 1, "Denial message must contain exactly one [KINS_STEALTH] tag");
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Adversarial Test 1: Active stealth must deny an opaque CLI tool (Stage 4 Finding F-01)
// -----------------------------------------------------------------------------
test("Adversarial: CLI cannot bypass active stealth with bash", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const stealthService = new WorkspaceStealthRuleService(
    new RuleBundleCompilerService(),
    hookService
  );

  try {
    const equipped = await stealthService.equip(context, {
      includeDesignPack: true
    });
    assert.equal(equipped.success, true);

    const serviceDecision = hookService.evaluateStealthPolicy({
      toolName: "bash",
      workspaceRoot: workspaceDir,
      workspaceId: context.id
    });

    assert.equal(serviceDecision.allowed, false);
    assert.equal(
      serviceDecision.metadata.violations[0]?.code,
      "UNSUPPORTED_TOOL"
    );

    const cliDecision = await evaluatePreToolUseHook({
      toolCall: { name: "bash" },
      workspacePaths: [workspaceDir]
    });

    assert.equal(
      cliDecision.decision,
      "deny",
      "CLI must enforce active workspace stealth policy for opaque tools"
    );
    assert.match(cliDecision.reason, /UNSUPPORTED_TOOL/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// Adversarial Test 2: CLI release must not bypass missing verification (Stage 4 Finding F-01)
// -----------------------------------------------------------------------------
test("Adversarial: CLI denies release without fresh verification", async () => {
  const { workspaceDir, sidecarDir, context } = createTestWorkspace();
  const hookService = new PreToolUseHookService();
  const stealthService = new WorkspaceStealthRuleService(
    new RuleBundleCompilerService(),
    hookService
  );

  try {
    const equipped = await stealthService.equip(context, {
      includeDesignPack: true
    });
    assert.equal(equipped.success, true);

    const serviceDecision = hookService.evaluateStealthPolicy({
      toolName: "release_gate_approval",
      workspaceRoot: workspaceDir,
      workspaceId: context.id,
      isReleaseAction: true
    });

    assert.equal(serviceDecision.allowed, false);
    assert.equal(
      serviceDecision.metadata.violations[0]?.code,
      "VERIFICATION_REQUIRED"
    );

    const cliDecision = await evaluatePreToolUseHook({
      toolCall: { name: "release_gate_approval" },
      workspacePaths: [workspaceDir]
    });

    assert.equal(
      cliDecision.decision,
      "deny",
      "CLI must not allow release merely because it is not a file-write tool"
    );
    assert.match(cliDecision.reason, /VERIFICATION_REQUIRED/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(sidecarDir, { recursive: true, force: true });
  }
});
