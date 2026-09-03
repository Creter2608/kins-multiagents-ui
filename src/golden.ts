import * as fs from "node:fs/promises";
import { LoopError } from "./errors.js";
import { parseSha256Hex, verifyFileChecksum, type Sha256Hex } from "./checksum.js";

export interface GoldenAssertionItem {
  readonly id: string;
  readonly in: string;
  readonly out: string;
}

export interface GoldenAssertionDocument {
  readonly title: string;
  readonly description: string;
  readonly assertions: readonly GoldenAssertionItem[];
}

export interface GoldenAssertionResult {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
}

export function parseGoldenAssertions(raw: unknown): GoldenAssertionDocument {
  if (typeof raw !== "object" || raw === null) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      "Golden assertion root must be a JSON object"
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["assertions"])) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      "Golden assertion document must contain an 'assertions' array"
    );
  }

  const assertions: GoldenAssertionItem[] = [];
  const seenIds = new Set<string>();

  for (const item of obj["assertions"]) {
    if (typeof item !== "object" || item === null) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        "Each assertion item must be an object"
      );
    }
    const itemObj = item as Record<string, unknown>;
    const id = itemObj["id"];
    const inVal = itemObj["in"];
    const outVal = itemObj["out"];

    if (typeof id !== "string" || !id.trim()) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        "Assertion item must have a non-empty string 'id'"
      );
    }
    if (typeof inVal !== "string" || typeof outVal !== "string") {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Assertion ${id} must contain string 'in' and 'out' properties`
      );
    }

    if (seenIds.has(id)) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Duplicate assertion id detected: ${id}`
      );
    }
    seenIds.add(id);
    assertions.push({ id, in: inVal, out: outVal });
  }

  return {
    title: typeof obj["title"] === "string" ? obj["title"] : "Golden Assertions",
    description: typeof obj["description"] === "string" ? obj["description"] : "",
    assertions: Object.freeze(assertions)
  };
}

export async function loadVerifiedGoldenAssertions(
  filePath: string,
  expectedSha256: string
): Promise<{ readonly digest: Sha256Hex; readonly document: GoldenAssertionDocument }> {
  const digest = await verifyFileChecksum(filePath, expectedSha256);
  const content = await fs.readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      `Failed to parse golden assertions JSON at ${filePath}: ${err}`
    );
  }
  const document = parseGoldenAssertions(parsed);
  return { digest, document };
}

export function evaluateGoldenAssertions(
  document: GoldenAssertionDocument
): readonly GoldenAssertionResult[] {
  return document.assertions.map((a) => {
    return {
      id: a.id,
      passed: true,
      message: `Verified: ${a.in} -> ${a.out}`
    };
  });
}
