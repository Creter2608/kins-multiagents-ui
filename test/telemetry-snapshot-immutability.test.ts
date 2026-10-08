import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import type { ProviderCapacity } from "../src/shared/providerCapacity.js";

test("current-session snapshot mutation cannot change internal telemetry", () => {
  const telemetry = new TelemetryService(null);
  const exposed = telemetry.getSnapshot();
  const expected = structuredClone(exposed.currentSession);

  Reflect.set(
    exposed.currentSession,
    "estimatedCostUsd",
    expected.estimatedCostUsd + 123
  );

  assert.deepEqual(
    telemetry.getSnapshot().currentSession,
    expected,
    "getSnapshot must detach currentSession from internal state"
  );
});

test("nested all-time provider mutation cannot change internal telemetry", () => {
  const telemetry = new TelemetryService(null);
  const exposed = telemetry.getSnapshot();
  const expected = structuredClone(exposed.allTime);
  const providerMetricKey = Object.keys(exposed.allTime.gpt)[0];

  assert.ok(
    providerMetricKey,
    "The GPT provider metrics must contain at least one metric"
  );

  const originalValue = Reflect.get(
    exposed.allTime.gpt,
    providerMetricKey
  );
  const changedValue =
    typeof originalValue === "number" ? originalValue + 123 : "mutated";

  Reflect.set(
    exposed.allTime.gpt,
    providerMetricKey,
    changedValue
  );

  assert.deepEqual(
    telemetry.getSnapshot().allTime,
    expected,
    "getSnapshot must detach nested provider metrics from internal state"
  );
});

test("provider-capacity snapshot item mutation cannot change internal telemetry", () => {
  const telemetry = new TelemetryService(null);
  const cap: ProviderCapacity = {
    provider: "openai",
    scope: "gpt-4o",
    metric: "requests",
    limit: 100,
    remaining: 80,
    resetAt: null,
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };

  telemetry.updateProviderCapacity([cap]);

  const snap1 = telemetry.getSnapshot();
  assert.equal(snap1.providerCapacity?.length, 1);

  // Mutate exposed item
  const item = snap1.providerCapacity![0] as any;
  item.remaining = 0;
  item.source = "unavailable";

  const snap2 = telemetry.getSnapshot();
  assert.equal(
    snap2.providerCapacity![0]?.remaining,
    80,
    "getSnapshot must detach providerCapacity objects from internal state"
  );
  assert.equal(
    snap2.providerCapacity![0]?.source,
    "provider",
    "Source must not be mutated"
  );
});

test("mutating caller capacity object after updateProviderCapacity does not affect telemetry", () => {
  const telemetry = new TelemetryService(null);
  const cap: ProviderCapacity = {
    provider: "anthropic",
    scope: "claude-3-7-sonnet",
    metric: "tokens",
    limit: 1000,
    remaining: 900,
    resetAt: null,
    windowSeconds: 60,
    windowKind: "rolling",
    source: "provider",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };

  telemetry.updateProviderCapacity([cap]);

  // Caller modifies original object
  (cap as any).remaining = 5;

  const snap = telemetry.getSnapshot();
  assert.equal(
    snap.providerCapacity![0]?.remaining,
    900,
    "updateProviderCapacity must detach incoming objects"
  );
});
