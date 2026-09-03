import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseSha256Hex, sha256Bytes, sha256File, verifyFileChecksum } from "../src/checksum.js";
import { LoopError } from "../src/errors.js";

test("checksum: known vector for 'abc'", () => {
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const actual = sha256Bytes(Buffer.from("abc", "utf-8"));
  assert.equal(actual, expected);
});

test("checksum: normalizes uppercase hex to lowercase", () => {
  const upper = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
  const normalized = parseSha256Hex(upper);
  assert.equal(normalized, upper.toLowerCase());
});

test("checksum: rejects invalid length or non-hex characters", () => {
  assert.throws(() => parseSha256Hex("abc"), (err: unknown) => {
    return err instanceof LoopError && err.code === "CONFIG_INVALID";
  });
  assert.throws(() => parseSha256Hex("z".repeat(64)), (err: unknown) => {
    return err instanceof LoopError && err.code === "CONFIG_INVALID";
  });
});

test("checksum: detects 1-byte file mutation with INTEGRITY_MISMATCH", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-test-"));
  const tmpFile = path.join(tmpDir, "data.txt");
  await fs.writeFile(tmpFile, "original data", "utf-8");

  const originalSha = await sha256File(tmpFile);
  await fs.writeFile(tmpFile, "modified data", "utf-8");

  await assert.rejects(
    async () => verifyFileChecksum(tmpFile, originalSha),
    (err: unknown) => err instanceof LoopError && err.code === "INTEGRITY_MISMATCH"
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
});
