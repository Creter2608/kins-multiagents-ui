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
  readonly resetAt: string | null;
  readonly windowSeconds: number | null;
  readonly windowKind: WindowKind;
  readonly source: CapacitySource;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
}

/**
 * Calculates remaining quota percentage.
 * Returns null if limit or remaining are invalid, non-finite, or non-positive.
 */
export function calculateRemainingPercentage(capacity: ProviderCapacity): number | null {
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
 * Golden Assertion 4: Expired observations must never be presented as active.
 */
export function isCapacityActive(capacity: ProviderCapacity, nowMs: number = Date.now()): boolean {
  if (capacity.source === "unavailable") {
    return false;
  }
  if (capacity.expiresAt) {
    const expiresMs = new Date(capacity.expiresAt).getTime();
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
      return false;
    }
  }
  return true;
}
