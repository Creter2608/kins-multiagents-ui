import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { LoopError } from "./errors.js";

export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

const SHA256_REGEX = /^[0-9a-f]{64}$/i;

export function parseSha256Hex(value: string): Sha256Hex {
  const trimmed = value.trim();
  if (!SHA256_REGEX.test(trimmed)) {
    throw new LoopError(
      "CONFIG_INVALID",
      "configuration",
      `Invalid SHA-256 digest: expected 64 hex characters, received '${value}'`
    );
  }
  return trimmed.toLowerCase() as Sha256Hex;
}

export function sha256Bytes(bytes: Uint8Array): Sha256Hex {
  return crypto.createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
}

export async function sha256File(filePath: string): Promise<Sha256Hex> {
  const fileBytes = await fs.readFile(filePath);
  return sha256Bytes(fileBytes);
}

export function timingSafeDigestEqual(actual: Sha256Hex, expected: Sha256Hex): boolean {
  const actBuf = Buffer.from(actual, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (actBuf.length !== expBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actBuf, expBuf);
}

export async function verifyFileChecksum(
  filePath: string,
  expectedHex: string
): Promise<Sha256Hex> {
  const validExpected = parseSha256Hex(expectedHex);
  const actualSha = await sha256File(filePath);
  if (!timingSafeDigestEqual(actualSha, validExpected)) {
    throw new LoopError(
      "INTEGRITY_MISMATCH",
      "integrity",
      `Checksum mismatch for ${filePath}. Expected ${validExpected}, found ${actualSha}`,
      { expected: validExpected, actual: actualSha, path: filePath }
    );
  }
  return actualSha;
}
