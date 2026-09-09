import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LoopError } from "../errors.js";
import { parseSha256Hex, sha256Bytes, timingSafeDigestEqual, type Sha256Hex } from "../checksum.js";
import type { LoopState, GoldenAssertion } from "../engine.js";

export interface BlueprintArtifactVerifier {
  verifyReadyBlueprint(state: LoopState, workspaceRoot?: string): Promise<void>;
}

export function canonicalizeGoldenAssertions(
  assertions: readonly GoldenAssertion[]
): string {
  const canonical = assertions.map((a) => ({ in: a.in, out: a.out }));
  return JSON.stringify(canonical);
}

export function parseBlueprintGoldenAssertions(
  markdown: string
): readonly GoldenAssertion[] {
  if (!markdown || typeof markdown !== "string") {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      "Blueprint markdown content is empty or invalid"
    );
  }

  // Find JSON array in code block or trailing text
  let jsonString: string | null = null;
  const codeBlockRegex = /```(?:json)?\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/g;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    lastMatch = match;
  }

  if (lastMatch && lastMatch[1]) {
    // Check that there is no substantive trailing prose after the JSON code block
    const afterCodeBlock = markdown.slice(lastMatch.index + lastMatch[0].length).trim();
    // Allow empty string, horizontal rules, or token usage comment markers
    const nonTrivialAfter = afterCodeBlock
      .replace(/^---[\s\S]*$/m, "")
      .replace(/^📊.*$/gm, "")
      .replace(/^<!--[\s\S]*?-->/g, "")
      .trim();

    if (nonTrivialAfter.length > 0) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Blueprint assertion table must be the terminal substantive section. Found trailing content: "${nonTrivialAfter.slice(0, 40)}..."`
      );
    }
    jsonString = lastMatch[1];
  } else {
    // Fallback: search for standalone JSON array at the end of markdown
    const arrayMatch = /(\[\s*\{[\s\S]*?\}\s*\])\s*$/m.exec(markdown.trim());
    if (arrayMatch && arrayMatch[1]) {
      jsonString = arrayMatch[1];
    }
  }

  if (!jsonString) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      "No valid JSON golden assertions array found in blueprint"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      `Failed to parse golden assertions JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      "Golden assertions must be a JSON array"
    );
  }

  if (parsed.length < 3 || parsed.length > 5) {
    throw new LoopError(
      "ASSERTION_SCHEMA_INVALID",
      "validation",
      `Golden assertions must contain between 3 and 5 items, found ${parsed.length}`
    );
  }

  const result: GoldenAssertion[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Golden assertion at index ${i} must be an object with string properties 'in' and 'out'`
      );
    }

    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("in") || !keys.includes("out")) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Golden assertion at index ${i} has invalid properties: [${keys.join(", ")}]. Must have exactly 'in' and 'out'`
      );
    }

    const inVal = (item as Record<string, unknown>).in;
    const outVal = (item as Record<string, unknown>).out;

    if (typeof inVal !== "string" || !inVal.trim()) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Golden assertion at index ${i} has empty or non-string 'in'`
      );
    }
    if (typeof outVal !== "string" || !outVal.trim()) {
      throw new LoopError(
        "ASSERTION_SCHEMA_INVALID",
        "validation",
        `Golden assertion at index ${i} has empty or non-string 'out'`
      );
    }

    result.push({ in: inVal.trim(), out: outVal.trim() });
  }

  return Object.freeze(result);
}

export class FileBlueprintArtifactVerifier implements BlueprintArtifactVerifier {
  constructor(private readonly defaultWorkspaceRoot: string = process.cwd()) {}

  async verifyReadyBlueprint(state: LoopState, workspaceRoot?: string): Promise<void> {
    const wsRoot = workspaceRoot || this.defaultWorkspaceRoot;
    const bp = state.blueprint;

    if (!bp) {
      throw new LoopError(
        "BLUEPRINT_REQUIRED",
        "state",
        "No blueprint record exists in loop state"
      );
    }

    if (bp.status !== "ready") {
      throw new LoopError(
        "BLUEPRINT_REQUIRED",
        "state",
        `Blueprint is not ready (current status: '${bp.status}')`
      );
    }

    if (bp.invocationCount !== 1) {
      throw new LoopError(
        "BLUEPRINT_REQUIRED",
        "state",
        `Blueprint invocationCount must be 1, found ${bp.invocationCount}`
      );
    }

    const artifactRelPath = bp.artifactPath || ".ai/blueprint.md";
    const artifactFullPath = path.resolve(wsRoot, artifactRelPath);

    let fileContent: string;
    try {
      const stat = await fs.stat(artifactFullPath);
      if (!stat.isFile()) {
        throw new Error("Target is not a regular file");
      }
      fileContent = await fs.readFile(artifactFullPath, "utf-8");
    } catch (err: unknown) {
      throw new LoopError(
        "BLUEPRINT_INTEGRITY",
        "integrity",
        `Blueprint artifact missing or unreadable at '${artifactRelPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Verify artifact file hash
    const computedFileSha = sha256Bytes(Buffer.from(fileContent, "utf-8"));
    if (bp.artifactSha256) {
      if (!timingSafeDigestEqual(computedFileSha, bp.artifactSha256)) {
        throw new LoopError(
          "BLUEPRINT_INTEGRITY",
          "integrity",
          `Blueprint artifact SHA-256 mismatch: expected ${bp.artifactSha256}, calculated ${computedFileSha}`
        );
      }
    }

    // Parse and verify golden assertions
    const parsedAssertions = parseBlueprintGoldenAssertions(fileContent);

    if (bp.goldenAssertions) {
      if (parsedAssertions.length !== bp.goldenAssertions.length) {
        throw new LoopError(
          "BLUEPRINT_INTEGRITY",
          "integrity",
          `Parsed assertions count (${parsedAssertions.length}) does not match state goldenAssertions (${bp.goldenAssertions.length})`
        );
      }
      for (let i = 0; i < parsedAssertions.length; i++) {
        const p = parsedAssertions[i];
        const s = bp.goldenAssertions[i];
        if (!p || !s || p.in !== s.in || p.out !== s.out) {
          throw new LoopError(
            "BLUEPRINT_INTEGRITY",
            "integrity",
            `Parsed assertion at index ${i} does not match state assertion: expected {"in":"${s?.in}","out":"${s?.out}"}, found {"in":"${p?.in}","out":"${p?.out}"}`
          );
        }
      }
    }

    if (bp.assertionsSha256) {
      const canon = canonicalizeGoldenAssertions(parsedAssertions);
      const computedAssertionsSha = sha256Bytes(Buffer.from(canon, "utf-8"));
      if (!timingSafeDigestEqual(computedAssertionsSha, bp.assertionsSha256)) {
        throw new LoopError(
          "BLUEPRINT_INTEGRITY",
          "integrity",
          `Blueprint assertions SHA-256 mismatch: expected ${bp.assertionsSha256}, calculated ${computedAssertionsSha}`
        );
      }
    }
  }
}
