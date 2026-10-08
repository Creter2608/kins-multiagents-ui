import type { ProviderCapacity } from "../../shared/providerCapacity.js";
import { isGeminiScope, isGeminiProScope } from "../../shared/providerCapacity.js";

export { isGeminiScope, isGeminiProScope };

interface RawModelEntry {
  readonly modelId?: unknown;
  readonly quota?: unknown;
  readonly isExhausted?: unknown;
}

interface RawQuotaObject {
  readonly limit?: unknown;
  readonly remaining?: unknown;
  readonly remainingPercentage?: unknown;
  readonly usedPercentage?: unknown;
  readonly resetTime?: unknown;
  readonly timeUntilResetMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses raw Antigravity Language Server GetUserStatus response into strongly-typed ProviderCapacity items.
 * Adheres strictly to Stage 2 GPT Blueprint:
 * - Accepts Pro, Flash, and general Gemini scopes while preserving each modelId.
 * - Supports discrete request counts (limit/remaining) AND percentage-only payloads with future resetTime.
 * - For percentage-only with future resetTime: sets limit=null, remaining=null, remainingPercentage=pct, source="provider".
 * - Bounded freshness expiration by the reset deadline; never fabricates counts like limit: 100.
 */
export function parseAntigravityQuota(
  payload: unknown,
  observedAt: Date = new Date(),
  freshnessMs: number = 120_000
): readonly ProviderCapacity[] {
  if (!isRecord(payload)) {
    return Object.freeze([]);
  }

  // Support both { userStatus: { quota: { models: [...] } } } and { quota: { models: [...] } }
  let modelsArray: unknown = undefined;
  if (isRecord(payload["userStatus"]) && isRecord(payload["userStatus"]["quota"])) {
    modelsArray = payload["userStatus"]["quota"]["models"];
  } else if (isRecord(payload["quota"])) {
    modelsArray = payload["quota"]["models"];
  }

  if (!Array.isArray(modelsArray) || modelsArray.length === 0) {
    return Object.freeze([]);
  }

  const observedMs = observedAt.getTime();
  const observedAtIso = observedAt.toISOString();
  const maxFreshnessMs = observedMs + Math.max(1000, freshnessMs);

  const scopeMap = new Map<string, ProviderCapacity>();
  const duplicateScopes = new Set<string>();

  for (const item of modelsArray) {
    if (!isRecord(item) || typeof item["modelId"] !== "string") {
      continue;
    }

    const modelId = item["modelId"].trim();
    if (!isGeminiScope(modelId)) {
      continue;
    }

    if (scopeMap.has(modelId)) {
      duplicateScopes.add(modelId);
      continue;
    }

    const rawQuota: RawQuotaObject | null = isRecord(item["quota"]) ? item["quota"] : null;
    const isExhaustedVal = typeof item["isExhausted"] === "boolean" ? item["isExhausted"] : null;

    let validAbsolute = false;
    let validPercentageOnly = false;
    let limitVal: number | null = null;
    let remainingVal: number | null = null;
    let percentageVal: number | null = null;
    let resetIso: string | null = null;
    let expiresAtIso: string | null = null;

    if (rawQuota) {
      const rawLimit = rawQuota.limit;
      const rawRemaining = rawQuota.remaining;
      const rawResetTime = rawQuota.resetTime;
      const rawRemainingPercentage = rawQuota.remainingPercentage;

      let hasValidFutureReset = false;
      if (typeof rawResetTime === "string" && rawResetTime.trim().length > 0) {
        const parsedResetDate = new Date(rawResetTime.trim());
        const resetMs = parsedResetDate.getTime();
        if (Number.isFinite(resetMs) && resetMs > observedMs) {
          hasValidFutureReset = true;
          resetIso = parsedResetDate.toISOString();
          const effectiveExpireMs = Math.min(resetMs, maxFreshnessMs);
          expiresAtIso = new Date(effectiveExpireMs).toISOString();
        }
      }

      // Check discrete request counts
      const hasValidLimit =
        typeof rawLimit === "number" &&
        Number.isInteger(rawLimit) &&
        rawLimit > 0;

      const hasValidRemaining =
        typeof rawRemaining === "number" &&
        Number.isInteger(rawRemaining) &&
        hasValidLimit &&
        rawRemaining >= 0 &&
        rawRemaining <= (rawLimit as number);

      // Check exhaustion contradiction for discrete counts
      let isContradictoryDiscrete = false;
      if (isExhaustedVal === true && hasValidRemaining && (rawRemaining as number) > 0) {
        isContradictoryDiscrete = true;
      } else if (isExhaustedVal === false && hasValidRemaining && (rawRemaining as number) === 0) {
        isContradictoryDiscrete = true;
      }

      if (hasValidLimit && hasValidRemaining && hasValidFutureReset && !isContradictoryDiscrete) {
        validAbsolute = true;
        limitVal = rawLimit as number;
        remainingVal = rawRemaining as number;
        percentageVal = Math.min(100, Math.max(0, Math.round((remainingVal / limitVal) * 1000) / 10));
      } else if (
        hasValidFutureReset &&
        typeof rawRemainingPercentage === "number" &&
        Number.isFinite(rawRemainingPercentage) &&
        rawRemainingPercentage >= 0 &&
        rawRemainingPercentage <= 100
      ) {
        // Percentage-only branch
        let isContradictoryPct = false;
        if (isExhaustedVal === true && rawRemainingPercentage > 0) {
          isContradictoryPct = true;
        } else if (isExhaustedVal === false && rawRemainingPercentage === 0) {
          isContradictoryPct = true;
        }

        if (!isContradictoryPct) {
          validPercentageOnly = true;
          percentageVal = Math.min(100, Math.max(0, Math.round(rawRemainingPercentage * 10) / 10));
        }
      }
    }

    if ((validAbsolute || validPercentageOnly) && resetIso !== null && expiresAtIso !== null) {
      scopeMap.set(modelId, {
        provider: "gemini",
        scope: modelId,
        metric: "requests",
        limit: limitVal,
        remaining: remainingVal,
        remainingPercentage: percentageVal,
        resetAt: resetIso,
        windowSeconds: null,
        windowKind: "fixed",
        source: "provider",
        observedAt: observedAtIso,
        expiresAt: expiresAtIso
      });
    } else {
      scopeMap.set(modelId, {
        provider: "gemini",
        scope: modelId,
        metric: "requests",
        limit: null,
        remaining: null,
        remainingPercentage: null,
        resetAt: null,
        windowSeconds: null,
        windowKind: "unknown",
        source: "unavailable",
        observedAt: observedAtIso,
        expiresAt: null
      });
    }
  }

  // Invalidate duplicate recognized scopes
  for (const dupScope of duplicateScopes) {
    scopeMap.set(dupScope, {
      provider: "gemini",
      scope: dupScope,
      metric: "requests",
      limit: null,
      remaining: null,
      remainingPercentage: null,
      resetAt: null,
      windowSeconds: null,
      windowKind: "unknown",
      source: "unavailable",
      observedAt: observedAtIso,
      expiresAt: null
    });
  }

  return Object.freeze(Array.from(scopeMap.values()));
}
