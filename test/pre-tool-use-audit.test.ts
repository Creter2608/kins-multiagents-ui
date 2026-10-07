import test, { mock } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import { WorkspaceStealthRuleService } from "../src/main/services/workspaceStealthRuleService.js";
import { RuleBundleCompilerService } from "../src/main/services/ruleBundleCompilerService.js";
import type { WorkspaceContext } from "../src/shared/contracts.js";

test("A-01: opaque tool without explicit paths uses active current workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kins-audit-cwd-"));
  const workspace = path.join(root, "workspace");
  const sidecar = path.join(root, "sidecar");
  const previousCwd = process.cwd();

  fs.mkdirSync(workspace);
  fs.mkdirSync(sidecar);

  try {
    execFileSync("git", ["init"], {
      cwd: workspace,
      stdio: "pipe"
    });

    const context: WorkspaceContext = {
      id: path.basename(root),
      root: workspace,
      displayName: "audit-current-directory",
      sidecarDirectory: sidecar,
      rules: []
    };

    const hook = new PreToolUseHookService();
    const stealth = new WorkspaceStealthRuleService(
      new RuleBundleCompilerService(),
      hook
    );

    const equipped = await stealth.equip(context, {
      includeDesignPack: true
    });
    assert.equal(equipped.success, true);

    process.chdir(workspace);

    // Confirm that the explicit-path form discovers active policy.
    const explicit = await evaluatePreToolUseHook({
      toolCall: { name: "bash" },
      workspacePaths: [workspace]
    });
    assert.equal(explicit.decision, "deny");
    assert.match(explicit.reason, /UNSUPPORTED_TOOL/);

    // Omitting optional workspacePaths must not bypass that policy.
    const implicit = await evaluatePreToolUseHook({
      toolCall: { name: "bash" }
    });
    assert.equal(implicit.decision, "deny");
    assert.match(implicit.reason, /UNSUPPORTED_TOOL/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-02: unsigned registry entries cannot cause sidecar manifest reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kins-audit-hmac-"));
  const workspace = path.join(root, "workspace");
  const userData = path.join(root, "user-data");
  const sidecar = path.join(root, "untrusted-sidecar");
  const manifest = path.join(sidecar, "stealth", "manifest.json");
  const previousUserData = process.env.ANTIGRAVITY_HOOK_USER_DATA;

  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(userData, "hooks"), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });

  fs.writeFileSync(
    manifest,
    JSON.stringify({
      workspaceId: path.basename(root),
      policyRevision: "audit",
      excludePath: path.join(workspace, ".git", "info", "exclude"),
      files: [],
      includeDesignPack: true
    }),
    "utf8"
  );

  // Deliberately lacks entryHmac: no authenticated authority to read sidecar.
  fs.writeFileSync(
    path.join(userData, "hooks", "workspaces.json"),
    JSON.stringify({
      workspaces: {
        [workspace]: {
          canonicalWorkspacePath: workspace,
          sidecarStatePath: path.join(sidecar, "state.json"),
          mutationPolicyMode: "strict",
          schemaVersion: 1
        }
      }
    }),
    "utf8"
  );

  process.env.ANTIGRAVITY_HOOK_USER_DATA = userData;

  const io = fs.promises;
  const originalReadFile = io.readFile;
  let unauthorizedReads = 0;

  const interception = mock.method(
    io,
    "readFile",
    (...args: Parameters<typeof originalReadFile>) => {
      if (
        typeof args[0] === "string" &&
        path.resolve(args[0]) === path.resolve(manifest)
      ) {
        unauthorizedReads += 1;
      }
      return originalReadFile(...args);
    }
  );

  try {
    await evaluatePreToolUseHook({
      toolCall: { name: "bash" },
      workspacePaths: [workspace]
    });

    assert.equal(
      unauthorizedReads,
      0,
      "Registry authentication must precede every sidecar manifest read"
    );
  } finally {
    interception.mock.restore();

    if (previousUserData === undefined) {
      delete process.env.ANTIGRAVITY_HOOK_USER_DATA;
    } else {
      process.env.ANTIGRAVITY_HOOK_USER_DATA = previousUserData;
    }

    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A-03: malformed mutation targets return deny instead of throwing", async () => {
  const malformedTargets = [42, {}, [], true];

  for (const target of malformedTargets) {
    // The public entry accepts unknown because its payload originates as JSON.
    const payload: unknown = {
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: target }
      },
      workspacePaths: [os.tmpdir()]
    };

    const decision = await evaluatePreToolUseHook(payload);

    assert.equal(
      decision.decision,
      "deny",
      `Malformed target ${JSON.stringify(target)} must be denied`
    );
    assert.equal(typeof decision.reason, "string");
    assert.ok(decision.reason.length > 0);
  }
});
