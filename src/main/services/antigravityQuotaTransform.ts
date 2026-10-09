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
interface ResolvedReset {
  readonly resetIso: string | null;
  readonly resetMs: number | null;
}

function resolveResetMetadata(rawQuota: RawQuotaObject | null, observedMs: number): ResolvedReset {
  if (!rawQuota) {
    return { resetIso: null, resetMs: null };
  }

  // 1. String resetTime
  if (typeof rawQuota.resetTime === "string") {
    const trimmed = rawQuota.resetTime.trim();
    if (trimmed.length > 0) {
      const parsedDate = new Date(trimmed);
      const t = parsedDate.getTime();
      if (Number.isFinite(t) && t > 0) {
        return { resetIso: parsedDate.toISOString(), resetMs: t };
      }
    }
  }

  // 2. Numeric resetTime
  if (typeof rawQuota.resetTime === "number" && Number.isFinite(rawQuota.resetTime) && rawQuota.resetTime >= 0) {
    const epochMs = rawQuota.resetTime < 1_000_000_000_000 ? rawQuota.resetTime * 1000 : rawQuota.resetTime;
    const parsedDate = new Date(epochMs);
    const t = parsedDate.getTime();
    if (Number.isFinite(t) && t > 0) {
      return { resetIso: parsedDate.toISOString(), resetMs: t };
    }
  }

  // 3. timeUntilResetMs
  if (
    typeof rawQuota.timeUntilResetMs === "number" &&
    Number.isFinite(rawQuota.timeUntilResetMs) &&
    rawQuota.timeUntilResetMs >= 0
  ) {
    const epochMs = observedMs + rawQuota.timeUntilResetMs;
    const parsedDate = new Date(epochMs);
    const t = parsedDate.getTime();
    if (Number.isFinite(t) && t > 0) {
      return { resetIso: parsedDate.toISOString(), resetMs: t };
    }
  }

  return { resetIso: null, resetMs: null };
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

  // Support userStatus.quota.models and quota.models precedence, with cascadeModelConfigData.clientModelConfigs fallback
  let modelsArray: unknown = undefined;
  if (
    isRecord(payload["userStatus"]) &&
    isRecord(payload["userStatus"]["quota"]) &&
    Array.isArray(payload["userStatus"]["quota"]["models"]) &&
    payload["userStatus"]["quota"]["models"].length > 0
  ) {
    modelsArray = payload["userStatus"]["quota"]["models"];
  } else if (
    isRecord(payload["quota"]) &&
    Array.isArray(payload["quota"]["models"]) &&
    payload["quota"]["models"].length > 0
  ) {
    modelsArray = payload["quota"]["models"];
  } else if (
    isRecord(payload["userStatus"]) &&
    isRecord(payload["userStatus"]["cascadeModelConfigData"]) &&
    Array.isArray(payload["userStatus"]["cascadeModelConfigData"]["clientModelConfigs"])
  ) {
    modelsArray = payload["userStatus"]["cascadeModelConfigData"]["clientModelConfigs"];
  } else if (
    isRecord(payload["cascadeModelConfigData"]) &&
    Array.isArray(payload["cascadeModelConfigData"]["clientModelConfigs"])
  ) {
    modelsArray = payload["cascadeModelConfigData"]["clientModelConfigs"];
  } else if (isRecord(payload["userStatus"]) && isRecord(payload["userStatus"]["quota"])) {
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
    if (!isRecord(item)) {
      continue;
    }

    let rawModelId: string | null = null;
    const candidates = [item["modelId"], item["modelName"], item["label"]];
    for (const cand of candidates) {
      if (typeof cand === "string" && cand.trim()) {
        const trimmed = cand.trim();
        if (isGeminiScope(trimmed)) {
          rawModelId = trimmed;
          break;
        }
      }
    }

    if (!rawModelId) {
      for (const cand of candidates) {
        if (typeof cand === "string" && cand.trim()) {
          const trimmed = cand.trim();
          const normalized = trimmed.toLowerCase().replace(/\s+/g, "-");
          if (isGeminiScope(normalized)) {
            rawModelId = normalized;
            break;
          }
        }
      }
    }

    if (!rawModelId || !isGeminiScope(rawModelId)) {
      continue;
    }

    const modelId = rawModelId;

    if (scopeMap.has(modelId)) {
      duplicateScopes.add(modelId);
      continue;
    }

    let rawQuota: RawQuotaObject | null = isRecord(item["quota"]) ? item["quota"] : null;
    if (!rawQuota && isRecord(item["quotaInfo"])) {
      const qInfo = item["quotaInfo"] as Record<string, unknown>;
      const fraction =
        typeof qInfo["remainingFraction"] === "number" &&
        Number.isFinite(qInfo["remainingFraction"]) &&
        qInfo["remainingFraction"] >= 0 &&
        qInfo["remainingFraction"] <= 1
          ? qInfo["remainingFraction"]
          : null;
      rawQuota = {
        remainingPercentage: fraction !== null ? fraction * 100 : undefined,
        resetTime:
          typeof qInfo["resetTime"] === "string" || typeof qInfo["resetTime"] === "number"
            ? (qInfo["resetTime"] as string | number)
            : undefined,
        timeUntilResetMs: typeof qInfo["timeUntilResetMs"] === "number" ? qInfo["timeUntilResetMs"] : undefined
      };
    }
    const isExhaustedVal = typeof item["isExhausted"] === "boolean" ? item["isExhausted"] : null;

    let validAbsolute = false;
    let validPercentageOnly = false;
    let limitVal: number | null = null;
    let remainingVal: number | null = null;
    let percentageVal: number | null = null;

    if (rawQuota) {
      const rawLimit = rawQuota.limit;
      const rawRemaining = rawQuota.remaining;
      const rawRemainingPercentage = rawQuota.remainingPercentage;

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

      if (hasValidLimit && hasValidRemaining && !isContradictoryDiscrete) {
        validAbsolute = true;
        limitVal = rawLimit as number;
        remainingVal = rawRemaining as number;
        percentageVal = Math.min(100, Math.max(0, Math.round((remainingVal / limitVal) * 1000) / 10));
      } else if (
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

    if (validAbsolute || validPercentageOnly) {
      const resolvedReset = resolveResetMetadata(rawQuota, observedMs);
      let effectiveResetIso: string | null = null;
      let effectiveExpiresIso: string | null = null;
      let windowKind: "fixed" | "unknown" = "unknown";

      if (resolvedReset.resetMs !== null && resolvedReset.resetIso !== null) {
        effectiveResetIso = resolvedReset.resetIso;
        if (resolvedReset.resetMs > observedMs) {
          windowKind = "fixed";
          const effectiveExpireMs = Math.min(resolvedReset.resetMs, maxFreshnessMs);
          effectiveExpiresIso = new Date(effectiveExpireMs).toISOString();
        } else {
          // Reset timestamp already reached
          effectiveExpiresIso = resolvedReset.resetIso;
        }
      } else {
        effectiveExpiresIso = new Date(maxFreshnessMs).toISOString();
      }

      scopeMap.set(modelId, {
        provider: "gemini",
        scope: modelId,
        metric: "requests",
        limit: limitVal,
        remaining: remainingVal,
        remainingPercentage: percentageVal,
        resetAt: effectiveResetIso,
        windowSeconds: null,
        windowKind,
        source: "provider",
        observedAt: observedAtIso,
        expiresAt: effectiveExpiresIso
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

export type QuotaReadResult =
  | { readonly status: "available"; readonly quota: readonly ProviderCapacity[]; readonly observedAtMs: number }
  | {
      readonly status: "unavailable";
      readonly reason: "NOT_FOUND" | "TIMEOUT" | "AUTH_REQUIRED" | "SCHEMA_UNSUPPORTED";
    };

export function parseQuotaResponse(
  payload: unknown,
  observedAt: Date = new Date(),
  freshnessMs: number = 120_000
): QuotaReadResult {
  if (payload === null || payload === undefined) {
    return { status: "unavailable", reason: "NOT_FOUND" };
  }

  const capacities = parseAntigravityQuota(payload, observedAt, freshnessMs);
  const providerActive = capacities.filter(
    (c) => c.source === "provider" && c.remainingPercentage !== null
  );

  if (providerActive.length > 0) {
    return {
      status: "available",
      quota: capacities,
      observedAtMs: observedAt.getTime()
    };
  }

  return { status: "unavailable", reason: "SCHEMA_UNSUPPORTED" };
}

