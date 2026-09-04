import test from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const MATCHER_URL = pathToFileURL(
  path.join(REPO_ROOT, "scripts", "harness", "pitfall-matcher.mjs")
).href;

const {
  parsePitfallsCatalog,
  matchPitfalls
} = (await import(MATCHER_URL)) as typeof import("../scripts/harness/pitfall-matcher.d.mts");

test("pitfall-matcher: parsePitfallsCatalog extracts all 13 pitfalls from wiki/pitfalls.md", () => {
  const catalog = parsePitfallsCatalog();
  assert.ok(catalog.length >= 13, `Catalog must have at least 13 pitfalls, found ${catalog.length}`);
  const ids = catalog.map((p) => p.id);
  assert.ok(ids.includes("PITFALL-001"));
  assert.ok(ids.includes("PITFALL-003"));
  assert.ok(ids.includes("PITFALL-006"));
  assert.ok(ids.includes("PITFALL-013"));
});

test("pitfall-matcher: matches PITFALL-003 for docker sandbox queries", () => {
  const result = matchPitfalls("docker sandbox execution host leakage");
  assert.ok(result.matches.length > 0);
  assert.equal(result.matches[0]?.id, "PITFALL-003");
  assert.ok(result.markdown.includes("PITFALL-003"));
  assert.ok(result.tokenEstimate < 200);
});

test("pitfall-matcher: matches PITFALL-002 and PITFALL-004 for checksum and eval queries", () => {
  const result = matchPitfalls("checksum sha256 eval golden assertions");
  assert.ok(result.matches.length >= 2);
  const ids = result.matches.map((m) => m.id);
  assert.ok(ids.includes("PITFALL-002") || ids.includes("PITFALL-004"));
  assert.ok(result.tokenEstimate < 300);
});

test("pitfall-matcher: matches PITFALL-001 for worktree path queries", () => {
  const result = matchPitfalls("git worktree test path resolve");
  assert.ok(result.matches.length > 0);
  const ids = result.matches.map((m) => m.id);
  assert.ok(ids.includes("PITFALL-001"));
});

test("pitfall-matcher: respects maxResults and produces compact markdown within budget", () => {
  const result = matchPitfalls("docker git checksum state regex log prompt commit", {
    maxResults: 2
  });
  assert.equal(result.matches.length, 2);
  assert.ok(result.tokenEstimate <= 400);
});

test("pitfall-matcher: enforces strict tokenBudget cutoff when selecting items", () => {
  const result = matchPitfalls("docker git checksum state regex log prompt commit", {
    maxResults: 10,
    tokenBudget: 60
  });
  assert.ok(result.matches.length <= 1, `Matches length should be <= 1 under tight budget, got ${result.matches.length}`);
  assert.ok(result.tokenEstimate <= 60, `Token estimate should be <= 60, got ${result.tokenEstimate}`);
});

test("pitfall-matcher: handles irrelevant queries gracefully", () => {
  const result = matchPitfalls("completely unrelated query xyz123");
  assert.equal(result.matches.length, 0);
  assert.equal(result.markdown, "");
  assert.equal(result.tokenEstimate, 0);
});
