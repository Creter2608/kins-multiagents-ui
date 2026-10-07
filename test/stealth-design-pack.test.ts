import test from "node:test";
import * as assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuleBundleCompilerService } from "../src/main/services/ruleBundleCompilerService.js";
import { WorkspaceStealthRuleService } from "../src/main/services/workspaceStealthRuleService.js";
import { compileFrontendDesignStealthPack, FRONTEND_DESIGN_PACK_REVISION } from "../src/main/services/frontendDesignStealthPack.js";
import type { WorkspaceContext } from "../src/shared/contracts.js";

// Golden Assertion G-01: includeDesignPack omitted vs false produces 100% byte-identical output
test("G-01: includeDesignPack omitted vs false -> identical output; baseline unchanged", () => {
  const compiler = new RuleBundleCompilerService();
  const defaultBundle = compiler.compileUniversalRules();
  const falseBundle = compiler.compileUniversalRules({ includeDesignPack: false });

  assert.equal(defaultBundle.agentsMarkdown, falseBundle.agentsMarkdown);
  assert.equal(defaultBundle.claudeMarkdown, falseBundle.claudeMarkdown);
  assert.equal(defaultBundle.geminiMarkdown, falseBundle.geminiMarkdown);
  assert.equal(defaultBundle.cursorMdc, falseBundle.cursorMdc);
});

// Golden Assertion G-02: includeDesignPack true appends curated appendix under token ceiling
test("G-02: includeDesignPack true -> includes Impeccable + UI/UX Pro Max appendix under 1200 tokens", () => {
  const compiler = new RuleBundleCompilerService();
  const baseline = compiler.compileUniversalRules();
  const packBundle = compiler.compileUniversalRules({ includeDesignPack: true });

  assert.ok(packBundle.agentsMarkdown.length > baseline.agentsMarkdown.length);
  assert.ok(packBundle.claudeMarkdown.length > baseline.claudeMarkdown.length);

  // Check key markers and invariants
  assert.ok(packBundle.agentsMarkdown.includes("FRONTEND_DESIGN_STEALTH_PACK_START"));
  assert.ok(packBundle.agentsMarkdown.includes("Security & Accessibility (WCAG AA)"));
  assert.ok(packBundle.agentsMarkdown.includes("Incumbent Project Design System"));
  assert.ok(packBundle.agentsMarkdown.includes("Anti-AI Slop Invariants"));
  assert.ok(packBundle.agentsMarkdown.includes("/critique"));
  assert.ok(packBundle.agentsMarkdown.includes("/polish"));
  assert.ok(packBundle.agentsMarkdown.includes("44×44px"));

  // Word count / approximate token check (rule of thumb: ~0.75 words per token -> 1200 tokens ~ 900 words)
  const appendix = compileFrontendDesignStealthPack("agents");
  const words = appendix.trim().split(/\s+/).length;
  assert.ok(words > 100, "Appendix must be substantial");
  assert.ok(words < 900, `Appendix word count (${words}) must be well below 900 words (~1200 tokens)`);
  assert.equal(typeof FRONTEND_DESIGN_PACK_REVISION, "string");
});

// Golden Assertion G-03: equip refuses to overwrite pre-existing unmanaged AGENTS.md
test("G-03: equip refuses to overwrite existing unmanaged AGENTS.md -> success=false; bytes untouched", async () => {
  const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "kins-stealth-unmanaged-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-stealth-sidecar-"));

  try {
    execSync("git init", { cwd: tempGit, stdio: "pipe" });
    const userOriginalContent = "# My Custom Company Invariants\nDo not touch.\n";
    fs.writeFileSync(path.join(tempGit, "AGENTS.md"), userOriginalContent, "utf-8");
    execSync("git add AGENTS.md && git -c user.name=Test -c user.email=test@example.com commit -m 'init'", {
      cwd: tempGit,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: "v1:unmanaged-test",
      root: path.resolve(tempGit),
      displayName: "unmanaged-test",
      sidecarDirectory: path.resolve(tempSidecar),
      rules: []
    };

    const stealthService = new WorkspaceStealthRuleService();

    // Must throw error or reject without touching file
    await assert.rejects(
      async () => {
        await stealthService.equip(context, { includeDesignPack: true });
      },
      /already exists and was not created by Kin/
    );

    // Verify user file was untouched
    const currentContent = fs.readFileSync(path.join(tempGit, "AGENTS.md"), "utf-8");
    assert.equal(currentContent, userOriginalContent);
  } finally {
    fs.rmSync(tempGit, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Golden Assertion G-04: equip with includeDesignPack records status in manifest
test("G-04: equip({ includeDesignPack: true }) -> records includeDesignPack in status & manifest", async () => {
  const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "kins-designpack-git-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-designpack-sidecar-"));

  try {
    execSync("git init", { cwd: tempGit, stdio: "pipe" });
    fs.writeFileSync(path.join(tempGit, "main.ts"), "console.log('hi');");
    execSync("git add main.ts && git -c user.name=Test -c user.email=test@example.com commit -m 'init'", {
      cwd: tempGit,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: "v1:designpack-test",
      root: path.resolve(tempGit),
      displayName: "designpack-test",
      sidecarDirectory: path.resolve(tempSidecar),
      rules: []
    };

    const stealthService = new WorkspaceStealthRuleService();

    const equipRes = await stealthService.equip(context, { includeDesignPack: true });
    assert.equal(equipRes.success, true);
    assert.equal(equipRes.excluded, true);

    const status = await stealthService.getStatus(context);
    assert.equal(status.equipped, true);
    assert.equal(status.excluded, true);
    assert.equal(status.includeDesignPack, true);

    // Check file content has design pack
    const agentsContent = fs.readFileSync(path.join(tempGit, "AGENTS.md"), "utf-8");
    assert.ok(agentsContent.includes("FRONTEND_DESIGN_STEALTH_PACK_START"));

    // Unequip
    const unequipRes = await stealthService.unequip(context);
    assert.equal(unequipRes.success, true);
    assert.equal(fs.existsSync(path.join(tempGit, "AGENTS.md")), false);

    const afterStatus = await stealthService.getStatus(context);
    assert.equal(afterStatus.equipped, false);
    assert.equal(afterStatus.includeDesignPack, false);
  } finally {
    fs.rmSync(tempGit, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Golden Assertion G-05: concurrent equip/unequip calls are serialized safely
test("G-05: concurrent equip operations on same workspace -> serialized without corruption", async () => {
  const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "kins-concurrent-git-"));
  const tempSidecar = fs.mkdtempSync(path.join(os.tmpdir(), "kins-concurrent-sidecar-"));

  try {
    execSync("git init", { cwd: tempGit, stdio: "pipe" });
    fs.writeFileSync(path.join(tempGit, "main.ts"), "export const a = 1;");
    execSync("git add main.ts && git -c user.name=Test -c user.email=test@example.com commit -m 'init'", {
      cwd: tempGit,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: "v1:concurrent-test",
      root: path.resolve(tempGit),
      displayName: "concurrent-test",
      sidecarDirectory: path.resolve(tempSidecar),
      rules: []
    };

    const stealthService = new WorkspaceStealthRuleService();

    // Trigger concurrent equip operations
    const [res1, res2] = await Promise.all([
      stealthService.equip(context, { includeDesignPack: true }),
      stealthService.equip(context, { includeDesignPack: true })
    ]);

    assert.equal(res1.success, true);
    assert.equal(res2.success, true);

    const status = await stealthService.getStatus(context);
    assert.equal(status.equipped, true);
    assert.equal(status.includeDesignPack, true);

    // Exclude file must have exactly one KINS exclude block, not duplicate
    const excludePath = await stealthService.resolveGitExcludePath(tempGit);
    const excludeContent = fs.readFileSync(excludePath, "utf-8");
    const matches = excludeContent.match(/# KINS:BEGIN STEALTH RULES/g);
    assert.equal(matches?.length, 1);
  } finally {
    fs.rmSync(tempGit, { recursive: true, force: true });
    fs.rmSync(tempSidecar, { recursive: true, force: true });
  }
});

// Stage 4 Adversarial QA Tests: F-01 & Content Contract Verification
test("Stage 4 Adversarial: design appendix contains no standalone placeholder sections", () => {
  for (const target of ["agents", "claude"] as const) {
    const appendix = compileFrontendDesignStealthPack(target);

    assert.doesNotMatch(
      appendix,
      /^\s*(?:\.{3}|…)\s*$/m,
      `${target}: generated guidance must not contain placeholder-only lines`
    );
  }
});

test("Stage 4 Adversarial: both contracted guidance sections contain actual body content", () => {
  for (const target of ["agents", "claude"] as const) {
    const appendix = compileFrontendDesignStealthPack(target);

    const sections = [
      {
        heading: "### 2. Anti-AI Slop Invariants (Impeccable Rules)",
        end: "### 3. UX Quality & Pre-Delivery Checklist (UI/UX Pro Max)"
      },
      {
        heading: "### 3. UX Quality & Pre-Delivery Checklist (UI/UX Pro Max)",
        end: "<!-- FRONTEND_DESIGN_STEALTH_PACK_END -->"
      }
    ];

    for (const section of sections) {
      const start = appendix.indexOf(section.heading);
      assert.notEqual(start, -1, `${target}: missing section ${section.heading}`);

      const bodyStart = start + section.heading.length;
      const end = appendix.indexOf(section.end, bodyStart);
      assert.notEqual(end, -1, `${target}: missing section boundary ${section.end}`);

      const meaningfulLines = appendix
        .slice(bodyStart, end)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !/^(?:\.{3}|…)$/.test(line) &&
            !/^#{1,6}\s/.test(line) &&
            !/^<!--.*-->$/.test(line)
        );

      assert.ok(
        meaningfulLines.length > 0,
        `${target}: ${section.heading} contains no guidance body`
      );
    }
  }
});

test("Stage 4 Adversarial: design appendix preserves markers and precedence on both targets", () => {
  for (const target of ["agents", "claude"] as const) {
    const appendix = compileFrontendDesignStealthPack(target);
    const startMarker = "<!-- FRONTEND_DESIGN_STEALTH_PACK_START -->";
    const endMarker = "<!-- FRONTEND_DESIGN_STEALTH_PACK_END -->";

    assert.equal(appendix.split(startMarker).length - 1, 1);
    assert.equal(appendix.split(endMarker).length - 1, 1);
    assert.ok(appendix.startsWith(startMarker));
    assert.ok(appendix.endsWith(endMarker));

    const security = appendix.indexOf("1. **Security & Accessibility (WCAG AA)**");
    const incumbent = appendix.indexOf("2. **Incumbent Project Design System**");
    const aesthetics = appendix.indexOf("3. **Anti-AI Slop & Aesthetic Guidance**");

    assert.ok(security >= 0, `${target}: missing highest-priority rule`);
    assert.ok(
      incumbent > security,
      `${target}: project conventions must follow security/accessibility`
    );
    assert.ok(
      aesthetics > incumbent,
      `${target}: aesthetic guidance must remain lowest priority`
    );
  }
});

