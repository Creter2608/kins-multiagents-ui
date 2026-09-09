import test from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

interface PackageManifest {
  productName?: unknown;
  scripts?: Record<string, unknown>;
}

test("standalone-integrity: .eval remains completely untouched", () => {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ".eval"],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(
    status.trim(),
    "",
    `.eval contains staged, unstaged, or untracked changes:\n${status}`
  );
});

test("standalone-integrity: template scaffold is excluded from runtime and lifecycle hooks", async () => {
  const packageText = await readFile("package.json", "utf8");
  const manifest = JSON.parse(packageText) as PackageManifest;

  assert.equal(manifest.productName, "Kin's Multi-Agents UI");
  assert.ok(manifest.scripts, "package.json must define scripts");

  const prohibitedHooks = [
    "preinstall",
    "install",
    "postinstall",
    "prestart",
    "start",
    "poststart",
    "prepack",
    "prepare",
    "postpack"
  ];

  for (const hook of prohibitedHooks) {
    const command = manifest.scripts?.[hook];
    if (typeof command === "string") {
      assert.doesNotMatch(
        command,
        /(?:init-template|scaffold:new)/i,
        `Production lifecycle hook "${hook}" must not invoke the development scaffold`
      );
    }
  }

  assert.equal(
    manifest.scripts?.["scaffold:new"],
    "node scripts/init-template.mjs",
    "The scaffold must remain an explicit, separately invoked development command"
  );
});

test("standalone-integrity: production source does not reference the development scaffold", () => {
  let matches = "";

  try {
    matches = execFileSync(
      "git",
      ["grep", "-n", "-I", "-E", "init-template\\.mjs|scaffold:new", "--", "src"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
  } catch (error: unknown) {
    const result = error as { status?: number; stdout?: string | Buffer };
    if (result.status === 1) {
      matches =
        typeof result.stdout === "string"
          ? result.stdout
          : result.stdout?.toString("utf8") ?? "";
    } else {
      throw error;
    }
  }

  assert.equal(
    matches.trim(),
    "",
    `Production runtime is coupled to the development scaffold:\n${matches}`
  );
});
