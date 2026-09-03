import test from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { loadVerifiedGoldenAssertions, parseGoldenAssertions, evaluateGoldenAssertions } from "../src/golden.js";
import { LoopError } from "../src/errors.js";

const GOLDEN_PATH = path.resolve(".eval/golden_assertions.json");
const SHA_PATH = path.resolve(".eval/golden_assertions.sha256");

async function getTrustedSha(): Promise<string> {
  const content = await fs.readFile(SHA_PATH, "utf-8");
  const parts = content.trim().split(/\s+/);
  const sha = parts[0];
  if (!sha) {
    throw new Error("Missing SHA-256 in " + SHA_PATH);
  }
  return sha;
}

test("golden: verifies repository golden assertions against trusted sha", async () => {
  const trustedSha = await getTrustedSha();
  const { digest, document } = await loadVerifiedGoldenAssertions(GOLDEN_PATH, trustedSha);
  assert.equal(digest, trustedSha);
  assert.ok(document.assertions.length > 0);

  const results = evaluateGoldenAssertions(document);
  assert.equal(results.length, document.assertions.length);
  assert.ok(results.every((r) => r.passed));
});

test("golden: rejects duplicate assertion IDs", () => {
  const malformed = {
    assertions: [
      { id: "DUP", in: "a", out: "b" },
      { id: "DUP", in: "c", out: "d" }
    ]
  };
  assert.throws(
    () => parseGoldenAssertions(malformed),
    (err: unknown) => err instanceof LoopError && err.code === "ASSERTION_SCHEMA_INVALID"
  );
});

test("golden: repository .eval/golden_assertions.json remains unmodified after tests", async () => {
  const currentBytes = await fs.readFile(GOLDEN_PATH);
  const crypto = await import("node:crypto");
  const actualSha = crypto.createHash("sha256").update(currentBytes).digest("hex");
  const trustedSha = await getTrustedSha();
  assert.equal(actualSha, trustedSha, "Golden file integrity violation!");
});
