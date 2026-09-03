export * from "./errors.js";
export * from "./checksum.js";
export * from "./golden.js";
export * from "./engine.js";

import { loadVerifiedGoldenAssertions, evaluateGoldenAssertions, type GoldenAssertionResult } from "./golden.js";

export interface ValidateWorkspaceOptions {
  readonly goldenPath: string;
  readonly expectedSha256: string;
}

export async function validateWorkspace(
  options: ValidateWorkspaceOptions
): Promise<readonly GoldenAssertionResult[]> {
  const { document } = await loadVerifiedGoldenAssertions(
    options.goldenPath,
    options.expectedSha256
  );
  return evaluateGoldenAssertions(document);
}
