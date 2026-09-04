import type {
  AntiGamingOptions,
  AntiGamingResult,
  AntiGamingViolation,
  AntiGamingViolationCode
} from "../../src/shared/harness.js";

export type {
  AntiGamingOptions,
  AntiGamingResult,
  AntiGamingViolation,
  AntiGamingViolationCode
};

export function validateGitDiffIntegrity(
  repoRoot: string,
  baseCommit: string,
  options?: AntiGamingOptions
): Promise<AntiGamingResult>;
