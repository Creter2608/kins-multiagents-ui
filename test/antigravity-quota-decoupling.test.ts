import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repositoryRoot = execFileSync(
  "git",
  ["rev-parse", "--show-toplevel"],
  {
    encoding: "utf8",
    timeout: 180_000
  }
).trim();

function resolveExperimentalRef(): string | null {
  for (const candidate of [
    "refs/heads/experimental/antigravity-quota",
    "refs/remotes/origin/experimental/antigravity-quota",
    "experimental/antigravity-quota",
    "origin/experimental/antigravity-quota"
  ]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
        cwd: repositoryRoot,
        stdio: "ignore"
      });
      return candidate;
    } catch {
      // try next
    }
  }

  try {
    execFileSync(
      "git",
      ["fetch", "origin", "experimental/antigravity-quota:refs/remotes/origin/experimental/antigravity-quota"],
      { cwd: repositoryRoot, stdio: "ignore", timeout: 15_000 }
    );
    execFileSync("git", ["rev-parse", "--verify", "refs/remotes/origin/experimental/antigravity-quota^{commit}"], {
      cwd: repositoryRoot,
      stdio: "ignore"
    });
    return "refs/remotes/origin/experimental/antigravity-quota";
  } catch {
    return null;
  }
}

function gitText(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

function workingSource(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function experimentalSource(ref: string, path: string): string {
  return gitText(["show", `${ref}:${path}`]);
}

test("main bootstrap and IPC do not retain the removed quota service wiring", () => {
  const bootstrap = workingSource("src/main/index.ts");
  const ipc = workingSource("src/main/ipc.ts");

  assert.doesNotMatch(
    bootstrap,
    /\b(?:AntigravityQuotaClient|AntigravityQuotaService|antigravityQuotaService)\b/,
    "Main bootstrap must not import, construct, start, refresh, or dispose quota services"
  );

  assert.doesNotMatch(
    ipc,
    /\b(?:AntigravityQuotaService|antigravityQuota)\b/,
    "Main IPC must not retain the removed quota dependency or refresh dispatch"
  );
});

test("main HUD has no dedicated quota ring or obsolete refresh state", () => {
  const hud = workingSource("src/renderer/components/TelemetryHud.tsx");

  assert.doesNotMatch(
    hud,
    /\b(?:GeminiQuotaRing|handleRefreshQuota|quotaRefreshError|setQuotaRefreshError|selectedGeminiCapacity)\b/,
    "The HUD must not retain removed ring wiring or references to removed state"
  );
});

test("experimental branch retains quota modules, startup wiring, and regression entry points", (t) => {
  const experimentalRef = resolveExperimentalRef();
  if (!experimentalRef) {
    t.skip("experimental/antigravity-quota branch not present in current clone");
    return;
  }

  gitText(["rev-parse", "--verify", `${experimentalRef}^{commit}`]);

  const trackedFiles = gitText([
    "ls-tree",
    "-r",
    "--name-only",
    experimentalRef,
    "--",
    "src",
    "test"
  ])
    .split(/\r?\n/)
    .filter(Boolean);

  const requiredModules = [
    "src/main/services/AntigravityQuotaClient.ts",
    "src/main/services/AntigravityQuotaService.ts",
    "src/main/services/antigravityQuotaTransform.ts"
  ];

  for (const path of requiredModules) {
    assert.ok(
      trackedFiles.includes(path),
      `Experimental branch must retain ${path}`
    );
    assert.ok(
      experimentalSource(experimentalRef, path).trim().length > 0,
      `${path} must not be an empty retained artifact`
    );
  }

  assert.ok(
    trackedFiles.some((path) =>
      /^src\/renderer\/components\/GeminiQuotaRing\.tsx?$/.test(path)
    ),
    "Experimental branch must retain the Gemini quota ring component"
  );

  const bootstrap = experimentalSource(experimentalRef, "src/main/index.ts");
  assert.match(bootstrap, /\bAntigravityQuotaClient\b/);
  assert.match(bootstrap, /\bAntigravityQuotaService\b/);
  assert.match(
    bootstrap,
    /\bantigravityQuotaService\s*\.\s*start\s*\(/,
    "Experimental branch must retain quota startup"
  );

  const quotaTests = experimentalSource(
    experimentalRef,
    "test/session-auth-and-ls-quota.test.ts"
  );

  assert.match(
    quotaTests,
    /\bparseQuotaResponse\s*\(/,
    "Experimental tests must retain executable quota-transform checks"
  );

  assert.match(
    quotaTests,
    /\bnew\s+AntigravityQuotaClient\s*\(/,
    "Experimental tests must retain executable quota-client checks"
  );

  assert.match(
    quotaTests,
    /\bVerifiedLanguageServer\b/,
    "Experimental tests must retain language-server regression fixtures"
  );
});
