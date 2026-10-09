import React, { useState, useEffect, useRef } from "react";
import type { ProviderCapacity } from "../../shared/contracts.js";
import { calculateRemainingPercentage, isCapacityActive } from "../../shared/contracts.js";
import { RefreshCw } from "lucide-react";

export interface GeminiQuotaRingProps {
  readonly capacity: ProviderCapacity | null;
  readonly onRefresh?: () => Promise<void>;
}

function formatCountdown(targetMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = diffSec % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export const GeminiQuotaRing: React.FC<GeminiQuotaRingProps> = ({
  capacity,
  onRefresh
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const isMountedRef = useRef(true);

  const [lastKnown, setLastKnown] = useState<{
    capacity: ProviderCapacity;
    pct: number;
  } | null>(() => {
    if (capacity) {
      const initialPct = calculateRemainingPercentage(capacity);
      if (initialPct !== null && initialPct >= 0 && initialPct <= 100) {
        return { capacity, pct: initialPct };
      }
    }
    return null;
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isActive = capacity ? isCapacityActive(capacity, nowMs) : false;
  const currentPct = capacity && isActive ? calculateRemainingPercentage(capacity) : null;

  useEffect(() => {
    if (capacity && isActive && currentPct !== null && currentPct >= 0 && currentPct <= 100) {
      setLastKnown({ capacity, pct: currentPct });
    }
  }, [capacity, isActive, currentPct]);

  // Handle scope change: if capacity is present with a different scope, don't leak previous scope's cached percentage
  const currentScope = capacity?.scope ?? null;
  const lastKnownScope = lastKnown?.capacity.scope ?? null;
  const isSameScopeOrNoCurrent = !currentScope || !lastKnownScope || currentScope === lastKnownScope;
  const effectiveLastKnown = isSameScopeOrNoCurrent ? lastKnown : null;

  const isCurrentlyAvailable = !(!capacity || !isActive || currentPct === null);
  const isStale = !isCurrentlyAvailable && effectiveLastKnown !== null;
  const displayCapacity = isCurrentlyAvailable ? capacity! : (effectiveLastKnown ? effectiveLastKnown.capacity : null);
  const pct = isCurrentlyAvailable ? currentPct : (effectiveLastKnown ? effectiveLastKnown.pct : null);
  const isUnavailable = pct === null;

  // 1-second interval clock only when a future resetAt exists
  const resetEpochMs = displayCapacity?.resetAt ? new Date(displayCapacity.resetAt).getTime() : null;
  const hasFutureReset = resetEpochMs !== null && Number.isFinite(resetEpochMs) && resetEpochMs > nowMs;

  useEffect(() => {
    if (!hasFutureReset) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [hasFutureReset, resetEpochMs]);

  // SVG Geometry: 24x24 px, center (12, 12), radius 9, stroke width 3
  const radius = 9;
  const circumference = 2 * Math.PI * radius; // ~56.55
  const strokeOffset = pct !== null ? circumference * (1 - pct / 100) : circumference;

  let ringColor = "text-zinc-600";
  let strokeColor = "stroke-zinc-600";
  let badgeTextColor = "text-zinc-400";

  if (!isUnavailable && pct !== null) {
    if (isStale) {
      ringColor = "text-zinc-500";
      strokeColor = "stroke-zinc-500";
      badgeTextColor = "text-zinc-400";
    } else if (pct >= 50) {
      ringColor = "text-emerald-400";
      strokeColor = "stroke-emerald-400";
      badgeTextColor = "text-emerald-300";
    } else if (pct >= 20) {
      ringColor = "text-amber-400";
      strokeColor = "stroke-amber-400";
      badgeTextColor = "text-amber-300";
    } else {
      ringColor = "text-rose-500";
      strokeColor = "stroke-rose-500";
      badgeTextColor = "text-rose-400";
    }
  }

  const handleRefreshClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // Gracefully contain refresh error so React event handler promise settles cleanly
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  };

  // Tooltip content strings
  const scopeLower = (displayCapacity?.scope || "").toLowerCase();
  const labelText = scopeLower.includes("flash") ? "Flash" : scopeLower.includes("pro") ? "Pro" : "Gemini";
  const scopeName = displayCapacity?.scope || `Gemini ${labelText}`;
  let statusText = `Antigravity Gemini · Unavailable / Standby`;
  let countdownText = "";

  if (isCurrentlyAvailable && pct !== null) {
    const countInfo =
      displayCapacity &&
      displayCapacity.limit !== null &&
      displayCapacity.remaining !== null
        ? ` (${displayCapacity.remaining}/${displayCapacity.limit} requests)`
        : "";
    statusText = `Antigravity Gemini · ${scopeName}\nRemaining: ${pct}%${countInfo}`;
    if (resetEpochMs) {
      if (nowMs >= resetEpochMs) {
        countdownText = "\nReported reset reached; awaiting fresh status.";
      } else {
        const localTimeStr = new Date(resetEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        countdownText = `\nReported reset: ${localTimeStr}\nResets in: ${formatCountdown(resetEpochMs, nowMs)}`;
      }
    }
    countdownText += "\n(Fixed-window presentation assumption; click to refresh)";
  } else if (isStale && pct !== null) {
    statusText = `Antigravity Gemini · ${scopeName}\nLast known quota: ${pct}%; awaiting refresh.\n(Click to refresh)`;
  } else if (capacity && resetEpochMs && nowMs >= resetEpochMs) {
    statusText = `Antigravity Gemini · ${scopeName}\nReset reached; awaiting fresh status.\nClick to refresh status.`;
  } else {
    statusText = `Antigravity Gemini · Unavailable\nLanguage Server connection standby.\nClick to probe local status.`;
  }

  return (
    <button
      type="button"
      onClick={handleRefreshClick}
      title={`${statusText}${countdownText}`}
      aria-label={`Gemini Quota (${scopeName}): ${isUnavailable ? "Unavailable" : isStale ? `Last known ${pct}% remaining (awaiting refresh)` : `${pct}% remaining`}. Click to refresh.`}
      className="group relative flex items-center space-x-1 px-1.5 py-0.5 rounded-md bg-zinc-800/90 hover:bg-zinc-700/80 border border-zinc-700/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer text-[11px] font-mono min-h-[26px]"
    >
      {/* 24x24 SVG Donut Gauge */}
      <div className="relative w-5 h-5 flex items-center justify-center">
        <svg
          className="w-5 h-5 -rotate-90 origin-center"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          {/* Background Track */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-zinc-700/80"
          />

          {/* Active Progress Stroke */}
          {!isUnavailable && pct !== null && (
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray={circumference}
              strokeDashoffset={strokeOffset}
              strokeLinecap="round"
              className={`${strokeColor} transition-all duration-500 ease-out`}
            />
          )}
        </svg>

        {/* Small Center Icon / Refresh Spinner on Hover or Refreshing */}
        {isRefreshing ? (
          <RefreshCw className="absolute w-2.5 h-2.5 text-zinc-300 animate-spin" />
        ) : isUnavailable ? (
          <span className="absolute text-[8px] font-sans font-bold text-zinc-400">?</span>
        ) : null}
      </div>

      {/* Label and Percentage */}
      <span className="text-zinc-400 uppercase font-sans font-semibold text-[10px]">
        {labelText}
      </span>
      <span className={`font-semibold tabular-nums ${badgeTextColor}`}>
        {isUnavailable ? "N/A" : isStale ? `~${pct}%` : `${pct}%`}
      </span>
    </button>
  );
};
