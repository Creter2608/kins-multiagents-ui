import type { ProviderId } from "./usage.js";

export type QuotaMetric = "requests" | "tokens";
export type WindowKind = "rolling" | "fixed" | "unknown";
export type CapacitySource = "provider" | "local-estimate" | "unavailable";

export interface ProviderCapacity {
  readonly provider: ProviderId;
  readonly scope: string; // Opaque account/model/limit-bucket identity
  readonly metric: QuotaMetric;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly remainingPercentage?: number | null | undefined;
  readonly resetAt: string | null;
  readonly windowSeconds: number | null;
  readonly windowKind: WindowKind;
  readonly source: CapacitySource;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
}

/**
 * Calculates remaining quota percentage.
 * 1. Finite remainingPercentage in [0, 100] takes precedence.
 * 2. Otherwise derived from remaining/limit request counts.
 * Returns null if data is invalid or unavailable.
 */
export function calculateRemainingPercentage(capacity: ProviderCapacity): number | null {
  if (
    typeof capacity.remainingPercentage === "number" &&
    Number.isFinite(capacity.remainingPercentage) &&
    capacity.remainingPercentage >= 0 &&
    capacity.remainingPercentage <= 100
  ) {
    return Math.min(100, Math.max(0, Math.round(capacity.remainingPercentage * 10) / 10));
  }

  if (
    typeof capacity.limit !== "number" ||
    typeof capacity.remaining !== "number" ||
    !Number.isFinite(capacity.limit) ||
    !Number.isFinite(capacity.remaining) ||
    capacity.limit <= 0
  ) {
    return null;
  }
  const pct = (capacity.remaining / capacity.limit) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

/**
 * Checks if a capacity observation is currently active and has not expired.
 * Golden Assertion 3 & 4: Expired or reset observations must never be presented as active.
 */
export function isCapacityActive(capacity: ProviderCapacity, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(nowMs)) {
    return false;
  }
  if (capacity.source === "unavailable") {
    return false;
  }
  if (capacity.expiresAt) {
    const expiresMs = new Date(capacity.expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return false;
    }
  }
  if (capacity.windowKind === "fixed" && capacity.resetAt) {
    const resetMs = new Date(capacity.resetAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
      return false;
    }
  }
  return true;
}

/**
 * Validates if the given model scope represents any Gemini model.
 * Matches: gemini-2.5-pro, gemini-3.8-flash, gemini-1.5-flash, gemini-pro, etc.
 */
export function isGeminiScope(scope: string): boolean {
  if (typeof scope !== "string" || !scope.trim()) {
    return false;
  }
  return /^gemini(?:-|$)/i.test(scope.trim());
}

/**
 * Validates if the given model scope represents a Gemini Pro model.
 * Matches: gemini-2.5-pro, gemini-1.5-pro, gemini-pro, etc.
 * Deliberately excludes Flash, lite, and non-Pro variants.
 */
export function isGeminiProScope(scope: string): boolean {
  if (!isGeminiScope(scope)) {
    return false;
  }
  const trimmed = scope.trim().toLowerCase();
  if (trimmed.includes("flash") || trimmed.includes("lite")) {
    return false;
  }
  return /(?:^|-)pro(?:-|$)/i.test(trimmed) || /^gemini-\d+(?:\.\d+)?-pro$/i.test(trimmed);
}

