import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ProviderCapacityService } from "../src/main/services/ProviderCapacityService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import type { ProviderCapacity } from "../src/shared/providerCapacity.js";
import {
  calculateRemainingPercentage,
  isCapacityActive
} from "../src/shared/providerCapacity.js";
import { createDiagnosticsSnapshot } from "../src/renderer/components/TelemetryHud.js";
import type { TelemetrySnapshot, TelemetryMetrics } from "../src/shared/contracts.js";

test("Golden Assertion 4: Expired quota observation -> Unavailable; no current gauge", () => {
  const service = new ProviderCapacityService();

  const nowMs = 1770000000000;
  const expiredDate = new Date(nowMs - 5000).toISOString(); // 5 seconds ago

  const expiredObservation: ProviderCapacity = {
    provider: "openai",
    scope: "gpt-4o/rpm",
    metric: "requests",
    limit: 10000,
    remaining: 8500,
    resetAt: expiredDate,
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date(nowMs - 65000).toISOString(),
    expiresAt: expiredDate
  };

  service.record(expiredObservation);

  // Snapshot evaluated at current time (nowMs)
  const currentSnapshot = service.snapshot(new Date(nowMs));
  assert.equal(currentSnapshot.length, 1);

  const item = currentSnapshot[0]!;
  assert.equal(item.provider, "openai");
  assert.equal(item.scope, "gpt-4o/rpm");

  // Invariant 1: Source must be transformed to "unavailable"
  assert.equal(item.source, "unavailable");

  // Invariant 2: remaining and limit must be strictly nullified
  assert.equal(item.remaining, null);
  assert.equal(item.limit, null);

  // Invariant 3: isCapacityActive returns false for expired
  assert.equal(isCapacityActive(item, nowMs), false);

  // Invariant 4: calculateRemainingPercentage returns null (no gauge displayed)
  const pct = calculateRemainingPercentage(item);
  assert.equal(pct, null, "Percentage must be null when capacity is unavailable or expired");
});

test("calculateRemainingPercentage: accurate rounding and edge case handling", () => {
  const baseCap: ProviderCapacity = {
    provider: "gemini",
    scope: "gemini-2.5-pro",
    metric: "tokens",
    limit: 1_000_000,
    remaining: 450_250,
    resetAt: null,
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };

  // Normal calculation: 450,250 / 1,000,000 = 45.025% -> rounded to 45%
  assert.equal(calculateRemainingPercentage(baseCap), 45);

  // Exact decimals: 333 / 1000 = 33.3%
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: 1000, remaining: 333 }),
    33.3
  );

  // Boundary clamp: remaining > limit should be capped at 100%
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: 100, remaining: 150 }),
    100
  );

  // Boundary clamp: negative remaining clamped to 0%
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: 100, remaining: -10 }),
    0
  );

  // Invalid: limit is 0, negative, NaN or null
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: 0, remaining: 50 }),
    null
  );
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: -100, remaining: 50 }),
    null
  );
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: null, remaining: 50 }),
    null
  );
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: 100, remaining: null }),
    null
  );
  assert.equal(
    calculateRemainingPercentage({ ...baseCap, limit: NaN, remaining: 50 }),
    null
  );
});

test("ProviderCapacityService: defensive copying protects internal state from mutations", () => {
  const service = new ProviderCapacityService();

  const observation: ProviderCapacity = {
    provider: "anthropic",
    scope: "claude-3-7-sonnet",
    metric: "tokens",
    limit: 500_000,
    remaining: 350_000,
    resetAt: null,
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };

  service.record(observation);

  // Mutating caller object after record should not affect internal state
  (observation as any).remaining = 0;
  (observation as any).limit = 999;

  const snap1 = service.snapshot();
  assert.equal(snap1[0]?.remaining, 350_000);
  assert.equal(snap1[0]?.limit, 500_000);

  // Mutating snapshot item should not affect subsequent snapshots
  try {
    (snap1 as any)[0] = null;
  } catch {
    // Frozen array in strict mode throws TypeError as expected
  }
  const snap2 = service.snapshot();
  assert.equal(snap2[0]?.remaining, 350_000);
});

test("ProviderCapacityService & TelemetryService: end-to-end telemetry propagation", () => {
  const capacityService = new ProviderCapacityService();
  const telemetryService = new TelemetryService(null);

  capacityService.subscribe((capacities) => {
    telemetryService.updateProviderCapacity(capacities);
  });

  const now = Date.now();
  const activeObservation: ProviderCapacity = {
    provider: "gemini",
    scope: "flash-rpm",
    metric: "requests",
    limit: 15,
    remaining: 12,
    resetAt: new Date(now + 30000).toISOString(),
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString()
  };

  capacityService.record(activeObservation);

  const telemetrySnapshot = telemetryService.getSnapshot();
  assert.ok(telemetrySnapshot.providerCapacity);
  assert.equal(telemetrySnapshot.providerCapacity.length, 1);
  assert.equal(telemetrySnapshot.providerCapacity[0]?.provider, "gemini");
  assert.equal(telemetrySnapshot.providerCapacity[0]?.remaining, 12);

  // Diagnostics payload integration
  const dummyMetrics: TelemetryMetrics = {
    gpt: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    gemini: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0 },
    estimatedCostUsd: 0.005
  };

  const diagnostics = createDiagnosticsSnapshot(telemetrySnapshot, "session", dummyMetrics);
  assert.ok(diagnostics.telemetry.providerCapacity);
  assert.equal(diagnostics.telemetry.providerCapacity.length, 1);
  assert.equal(diagnostics.telemetry.providerCapacity[0]?.provider, "gemini");
  assert.equal(diagnostics.telemetry.providerCapacity[0]?.remaining, 12);
});
