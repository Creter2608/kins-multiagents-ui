import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const MERGER_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "harness", "ast-merger.mjs")).href;
const {
  mergeSource3Way,
  mergeFiles3Way,
  mergeWorktrees3Way
} = await import(MERGER_URL) as typeof import("../scripts/harness/ast-merger.d.mts");

// Compact Assertion 1: current imports A; incoming imports B from foo -> one valid merge containing A and B
test("ast-merger: merges disjoint named imports from same module without conflict", () => {
  const baseCode = `import { X } from "foo";\nconsole.log(X);`;
  const currentCode = `import { X, A } from "foo";\nconsole.log(X, A);`;
  const incomingCode = `import { X, B } from "foo";\nconsole.log(X, B);`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, true);
  assert.equal(res.conflictsCount, 0);
  assert.ok(res.autoMergedCount >= 1);
  assert.ok(res.code.includes("A"));
  assert.ok(res.code.includes("B"));
  assert.ok(res.code.includes("X"));
  assert.ok(!res.code.includes("<<<<<<<"));
});

// Compact Assertion 2: current adds foo; incoming adds bar -> clean output contains both functions
test("ast-merger: merges disjoint function additions seamlessly", () => {
  const baseCode = `export const VERSION = "1.0.0";`;
  const currentCode = `export const VERSION = "1.0.0";\n\nexport function foo() {\n  return "foo";\n}`;
  const incomingCode = `export const VERSION = "1.0.0";\n\nexport function bar() {\n  return "bar";\n}`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, true);
  assert.equal(res.conflictsCount, 0);
  assert.ok(res.autoMergedCount >= 1);
  assert.ok(res.code.includes("function foo()"));
  assert.ok(res.code.includes("function bar()"));
  assert.ok(!res.code.includes("<<<<<<<"));
});

// Compact Assertion 3: interfaces add disjoint x:string and y:number -> one interface containing both properties
test("ast-merger: merges disjoint interface properties cleanly", () => {
  const baseCode = `export interface UserProfile {\n  id: string;\n}`;
  const currentCode = `export interface UserProfile {\n  id: string;\n  x: string;\n}`;
  const incomingCode = `export interface UserProfile {\n  id: string;\n  y: number;\n}`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, true);
  assert.equal(res.conflictsCount, 0);
  assert.ok(res.autoMergedCount >= 1);
  assert.ok(res.code.includes("x: string;"));
  assert.ok(res.code.includes("y: number;"));
  assert.ok(res.code.includes("id: string;"));
  assert.ok(!res.code.includes("<<<<<<<"));
});

// Compact Assertion 4: both make the same edit -> edit emitted once; zero conflicts
test("ast-merger: deduplicates identical concurrent edits without conflicts", () => {
  const baseCode = `export function getPort(): number {\n  return 3000;\n}`;
  const currentCode = `export function getPort(): number {\n  return 8080;\n}`;
  const incomingCode = `export function getPort(): number {\n  return 8080;\n}`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, true);
  assert.equal(res.conflictsCount, 0);
  assert.ok(res.autoMergedCount >= 1);
  assert.ok(res.code.includes("return 8080;"));
  // Emitted only once
  const matches = res.code.match(/return 8080;/g);
  assert.equal(matches?.length, 1);
});

// Compact Assertion 5: same function gets different bodies -> one conflict with CURRENT/INCOMING markers
test("ast-merger: emits standard conflict markers on genuine concurrent conflicting edits", () => {
  const baseCode = `export function calculate(val: number): number {\n  return val;\n}`;
  const currentCode = `export function calculate(val: number): number {\n  return val * 2;\n}`;
  const incomingCode = `export function calculate(val: number): number {\n  return val * 3;\n}`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, false);
  assert.equal(res.conflictsCount, 1);
  assert.ok(res.code.includes("<<<<<<< CURRENT"));
  assert.ok(res.code.includes("val * 2"));
  assert.ok(res.code.includes("======="));
  assert.ok(res.code.includes("val * 3"));
  assert.ok(res.code.includes(">>>>>>> INCOMING"));
});

test("ast-merger: flags conflicting interface property types as conflict", () => {
  const baseCode = `export interface Config {\n  port: number;\n}`;
  const currentCode = `export interface Config {\n  port: number;\n  timeout: number;\n}`;
  const incomingCode = `export interface Config {\n  port: number;\n  timeout: string;\n}`;

  const res = mergeSource3Way(baseCode, currentCode, incomingCode);
  assert.equal(res.clean, false);
  assert.equal(res.conflictsCount, 1);
  assert.ok(res.code.includes("<<<<<<< CURRENT"));
  assert.ok(res.code.includes(">>>>>>> INCOMING"));
});

test("ast-merger: mergeFiles3Way correctly merges files on disk", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ast-file-test-"));
  const bPath = path.join(tmp, "base.ts");
  const cPath = path.join(tmp, "current.ts");
  const iPath = path.join(tmp, "incoming.ts");

  try {
    fs.writeFileSync(bPath, `export const A = 1;`, "utf-8");
    fs.writeFileSync(cPath, `export const A = 1;\nexport const B = 2;`, "utf-8");
    fs.writeFileSync(iPath, `export const A = 1;\nexport const C = 3;`, "utf-8");

    const fileRes = await mergeFiles3Way(bPath, cPath, iPath);
    assert.equal(fileRes.clean, true);
    assert.ok(fileRes.code.includes("B = 2"));
    assert.ok(fileRes.code.includes("C = 3"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ast-merger: mergeWorktrees3Way merges full directories and handles additions and deletions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ast-worktree-test-"));
  const baseDir = path.join(tmp, "base");
  const currentDir = path.join(tmp, "current");
  const incomingDir = path.join(tmp, "incoming");
  const outDir = path.join(tmp, "out");

  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(incomingDir, { recursive: true });

  try {
    // 1. Shared file modified on both sides non-conflictly
    fs.writeFileSync(path.join(baseDir, "index.ts"), `export const v = 1;`, "utf-8");
    fs.writeFileSync(path.join(currentDir, "index.ts"), `export const v = 1;\nexport const x = 10;`, "utf-8");
    fs.writeFileSync(path.join(incomingDir, "index.ts"), `export const v = 1;\nexport const y = 20;`, "utf-8");

    // 2. Incoming added new file
    fs.writeFileSync(path.join(incomingDir, "new-incoming.ts"), `export const incomingOnly = true;`, "utf-8");

    // 3. Current added new file
    fs.writeFileSync(path.join(currentDir, "new-current.ts"), `export const currentOnly = true;`, "utf-8");

    const wtRes = await mergeWorktrees3Way(baseDir, currentDir, incomingDir, { outputDir: outDir });
    assert.equal(wtRes.clean, true);
    assert.equal(wtRes.conflictsCount, 0);

    // Verify output files exist and merged properly
    assert.ok(fs.existsSync(path.join(outDir, "index.ts")));
    assert.ok(fs.existsSync(path.join(outDir, "new-incoming.ts")));
    assert.ok(fs.existsSync(path.join(outDir, "new-current.ts")));

    const mergedIndex = fs.readFileSync(path.join(outDir, "index.ts"), "utf-8");
    assert.ok(mergedIndex.includes("x = 10"));
    assert.ok(mergedIndex.includes("y = 20"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ast-merger: mergeWorktrees3Way protects .eval/ from being target directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ast-security-test-"));
  const baseDir = path.join(tmp, "base");
  const currentDir = path.join(tmp, "current");
  const incomingDir = path.join(tmp, "incoming");
  const evalDir = path.join(tmp, ".eval");

  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(incomingDir, { recursive: true });

  try {
    await assert.rejects(async () => {
      await mergeWorktrees3Way(baseDir, currentDir, incomingDir, { outputDir: evalDir });
    }, /Security Violation.*\.eval/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
