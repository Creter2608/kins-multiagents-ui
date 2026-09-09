import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveLoopStatePath } from "../src/main/services/LoopStateService.js";

test("resolveLoopStatePath uses the sidecar without creating .ai in an external project", () => {
  const root = mkdtempSync(join(tmpdir(), "kins-sidecar-state-"));

  try {
    const workspaceRoot = join(root, "external project");
    const sidecarDirectory = join(root, "sidecar directory");

    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(sidecarDirectory, { recursive: true });

    const statePath = resolveLoopStatePath(
      workspaceRoot,
      sidecarDirectory,
    );

    assert.equal(
      statePath,
      join(sidecarDirectory, "state", "state.json"),
    );
    assert.equal(
      existsSync(join(workspaceRoot, ".ai")),
      false,
      "path resolution must not pollute the external project",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace path containing '.ai' text is not mistaken for an existing .ai directory", () => {
  const root = mkdtempSync(join(tmpdir(), "kins-dot-ai-boundary-"));

  try {
    const workspaceRoot = join(root, "customer.ai-project");
    const sidecarDirectory = join(root, "sidecar");

    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(sidecarDirectory, { recursive: true });

    const statePath = resolveLoopStatePath(
      workspaceRoot,
      sidecarDirectory,
    );

    assert.equal(
      statePath,
      join(sidecarDirectory, "state", "state.json"),
    );
    assert.equal(existsSync(join(workspaceRoot, ".ai")), false);
    assert.equal(resolve(statePath).startsWith(resolve(sidecarDirectory)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected .eval content has no staged, unstaged, or untracked changes", () => {
  const repositoryRoot = process.cwd();

  const unstaged = execFileSync(
    "git",
    ["diff", "--", ".eval"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  const staged = execFileSync(
    "git",
    ["diff", "--cached", "--", ".eval"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--", ".eval"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(unstaged, "", ".eval contains unstaged modifications");
  assert.equal(staged, "", ".eval contains staged modifications");
  assert.equal(status, "", ".eval contains modified or untracked content");
});
