import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const PREFLIGHT_URL = pathToFileURL(path.join(REPO_ROOT, "scripts", "preflight.mjs")).href;

const {
  checkSyntaxDiagnostics,
  benchmarkPreflight,
  getChangedTsFiles
} = await import(PREFLIGHT_URL) as typeof import("../scripts/preflight.d.mts");

test("preflight: valid TypeScript files pass syntax diagnostics with 0 errors", () => {
  const result = checkSyntaxDiagnostics([
    path.resolve("src/engine.ts"),
    path.resolve("src/loop/LoopCommandService.ts")
  ]);

  assert.equal(result.passed, true);
  assert.equal(result.checkedCount, 2);
  assert.equal(result.errors.length, 0);
});

test("preflight: syntax error is caught with accurate line and column", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
  const badFile = path.join(tempDir, "broken.ts");
  // Intentional syntax error: unclosed brace and invalid statement
  fs.writeFileSync(badFile, "export function badSyntax() {\n  const x = ;;\n", "utf-8");

  try {
    const result = checkSyntaxDiagnostics([badFile]);
    assert.equal(result.passed, false);
    assert.equal(result.checkedCount, 1);
    assert.ok(result.errors.length > 0);
    const firstErr = result.errors[0];
    assert.ok(firstErr);
    assert.equal(firstErr.line, 2);
    assert.ok(firstErr.message.length > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("preflight: benchmark p95 meets < 300ms SLA", () => {
  const bench = benchmarkPreflight([path.resolve("src/engine.ts")], 10);
  assert.ok(bench.p95Ms < 300, `p95 ${bench.p95Ms}ms must be below 300ms SLA`);
  assert.ok(bench.minMs > 0);
  assert.ok(bench.avgMs >= bench.minMs);
  assert.ok(bench.maxMs >= bench.avgMs);
});

test("preflight: getChangedTsFiles returns array without throwing", () => {
  const files = getChangedTsFiles();
  assert.ok(Array.isArray(files));
});
