import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AddressInfo } from "node:net";
import ts from "typescript";
import {
  isGeminiScope,
  isGeminiProScope,
  parseAntigravityQuota,
  parseQuotaResponse
} from "../src/main/services/antigravityQuotaTransform.js";
import {
  AntigravityQuotaClient,
  type AntigravityEndpoint,
  type AntigravityQuotaTransport
} from "../src/main/services/AntigravityQuotaClient.js";
import {
  AntigravityQuotaService
} from "../src/main/services/AntigravityQuotaService.js";
import { ProviderCapacityService } from "../src/main/services/ProviderCapacityService.js";
import {
  calculateRemainingPercentage,
  isCapacityActive,
  type ProviderCapacity
} from "../src/shared/providerCapacity.js";
import { selectBestGeminiCapacity } from "../src/renderer/components/TelemetryHud.js";

test("Golden Assertion 1: Flash: 37%, no counts, future reset -> provider; counts=null; percentage=37", () => {
  const nowMs = 1770000000000;
  const observedAt = new Date(nowMs);
  const futureResetIso = new Date(nowMs + 3600000).toISOString(); // +1 hour

  const payload = {
    userStatus: {
      email: "test@example.com",
      quota: {
        models: [
          {
            modelId: "gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            quota: {
              remainingPercentage: 37.0,
              usedPercentage: 63.0,
              resetTime: futureResetIso,
              timeUntilResetMs: 3600000
            },
            isExhausted: false
          }
        ]
      }
    }
  };

  const capacities = parseAntigravityQuota(payload, observedAt, 120000);
  assert.equal(capacities.length, 1);

  const cap = capacities[0]!;
  assert.equal(cap.provider, "gemini");
  assert.equal(cap.scope, "gemini-2.5-flash");
  assert.equal(cap.source, "provider");
  assert.equal(cap.limit, null, "counts must be null when only percentage is supplied");
  assert.equal(cap.remaining, null, "counts must be null when only percentage is supplied");
  assert.equal(cap.remainingPercentage, 37.0);
  assert.equal(cap.resetAt, futureResetIso);
  assert.equal(cap.windowKind, "fixed");

  const pct = calculateRemainingPercentage(cap);
  assert.equal(pct, 37, "Percentage must calculate to 37 directly from remainingPercentage");
  assert.equal(isCapacityActive(cap, nowMs), true);
});

test("Golden Assertion 2: active Flash + Pro; active model=Flash -> select exact Flash", () => {
  const nowMs = 1770000000000;
  const flashCap: ProviderCapacity = {
    provider: "gemini",
    scope: "gemini-2.5-flash",
    metric: "requests",
    limit: null,
    remaining: null,
    remainingPercentage: 50,
    resetAt: new Date(nowMs + 3600000).toISOString(),
    windowSeconds: null,
    windowKind: "fixed",
    source: "provider",
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 3600000).toISOString()
  };

  const proCap: ProviderCapacity = {
    provider: "gemini",
    scope: "gemini-2.5-pro",
    metric: "requests",
    limit: 100,
    remaining: 80,
    remainingPercentage: 80,
    resetAt: new Date(nowMs + 3600000).toISOString(),
    windowSeconds: null,
    windowKind: "fixed",
    source: "provider",
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 3600000).toISOString()
  };

  const selected = selectBestGeminiCapacity([proCap, flashCap], "gemini-2.5-flash", nowMs);
  assert.ok(selected);
  assert.equal(selected.scope, "gemini-2.5-flash", "Must select exact active model Flash over Pro");

  // Fallback when active model is not specified or doesn't match: prefers Pro
  const fallbackSelected = selectBestGeminiCapacity([flashCap, proCap], undefined, nowMs);
  assert.ok(fallbackSelected);
  assert.equal(fallbackSelected.scope, "gemini-2.5-pro", "Must prefer Pro when active model is unset");
});

test("Golden Assertion 3: invalid env; valid config; WMI denied -> discover config endpoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-quota-test-"));
  const configPath = path.join(tempDir, "antigravity-endpoint.json");
  fs.writeFileSync(configPath, JSON.stringify({ address: "127.0.0.1:45678", csrfToken: "cfg-tok" }));

  const prevAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const prevConfig = process.env.ANTIGRAVITY_LS_CONFIG_PATH;

  try {
    process.env.ANTIGRAVITY_LS_ADDRESS = "http://malicious-external-host.com:9999"; // Invalid remote host
    process.env.ANTIGRAVITY_LS_CONFIG_PATH = configPath;

    const client = new AntigravityQuotaClient({ userDataPath: tempDir });
    const endpoints = await client.discover();

    assert.ok(endpoints.length >= 1, "Must fall through to config file endpoint");
    assert.equal(endpoints[0]?.port, 45678);
    assert.equal(endpoints[0]?.csrfToken, "cfg-tok");
  } finally {
    if (prevAddress !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = prevAddress;
    else delete process.env.ANTIGRAVITY_LS_ADDRESS;

    if (prevConfig !== undefined) process.env.ANTIGRAVITY_LS_CONFIG_PATH = prevConfig;
    else delete process.env.ANTIGRAVITY_LS_CONFIG_PATH;

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 4: now = resetAt or expiresAt -> inactive", () => {
  const nowMs = 1770000000000;
  const resetIso = new Date(nowMs).toISOString();

  const cap: ProviderCapacity = {
    provider: "gemini",
    scope: "gemini-2.5-pro",
    metric: "requests",
    limit: 200,
    remaining: 150,
    resetAt: resetIso,
    windowSeconds: null,
    windowKind: "fixed",
    source: "provider",
    observedAt: new Date(nowMs - 60000).toISOString(),
    expiresAt: new Date(nowMs + 60000).toISOString()
  };

  assert.equal(isCapacityActive(cap, nowMs), false, "At exact reset epoch, must be inactive");
  assert.equal(isCapacityActive(cap, nowMs + 1000), false, "After reset epoch, must be inactive");
  assert.equal(isCapacityActive(cap, nowMs - 1000), true, "Before reset epoch, remains active");

  const capExpires: ProviderCapacity = {
    ...cap,
    resetAt: new Date(nowMs + 60000).toISOString(),
    expiresAt: new Date(nowMs).toISOString()
  };
  assert.equal(isCapacityActive(capExpires, nowMs), false, "At exact expiresAt epoch, must be inactive");
});

test("Golden Assertion 5: HTTP 302 to remote host -> client strictly rejects; no token forwarding", async () => {
  let redirectedCount = 0;
  const server = http.createServer((req, res) => {
    redirectedCount++;
    res.writeHead(302, {
      Location: "http://malicious-external-host.com/steal-token"
    });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;

  try {
    const client = new AntigravityQuotaClient();
    const endpoint: AntigravityEndpoint = {
      port: address.port,
      csrfToken: "secret-token-123"
    };

    await assert.rejects(
      async () => {
        await client.getUserStatus(endpoint);
      },
      /Redirects strictly forbidden/i,
      "Must reject HTTP 302 and never follow redirects"
    );

    assert.equal(redirectedCount, 1, "Only 1 request sent to 302 server; zero redirected requests");
  } finally {
    server.close();
  }
});

test("isGeminiScope and isGeminiProScope: boundary validation", () => {
  assert.equal(isGeminiScope("gemini-2.5-pro"), true);
  assert.equal(isGeminiScope("gemini-2.5-flash"), true);
  assert.equal(isGeminiScope("gemini-3.8-flash"), true);
  assert.equal(isGeminiScope("gemini-pro"), true);
  assert.equal(isGeminiScope("gpt-4o"), false);
  assert.equal(isGeminiScope(""), false);

  assert.equal(isGeminiProScope("gemini-2.5-pro"), true);
  assert.equal(isGeminiProScope("gemini-1.5-pro"), true);
  assert.equal(isGeminiProScope("gemini-3-pro"), true);
  assert.equal(isGeminiProScope("gemini-pro"), true);
  assert.equal(isGeminiProScope("gemini-2.5-flash"), false);
  assert.equal(isGeminiProScope("gpt-4o"), false);
  assert.equal(isGeminiProScope(""), false);
});

test("AntigravityQuotaService: single-flight deduplication and candidate fallback", async () => {
  const capacityService = new ProviderCapacityService();

  let callCount = 0;
  const mockTransport: AntigravityQuotaTransport = {
    async discover() {
      // Return 2 endpoints: first fails, second succeeds
      return [
        { port: 11111, csrfToken: "fail" },
        { port: 22222, csrfToken: "ok" }
      ];
    },
    async getUserStatus(ep) {
      callCount++;
      if (ep.port === 11111) {
        throw new Error("Connection refused on first endpoint");
      }
      return {
        userStatus: {
          quota: {
            models: [
              {
                modelId: "gemini-2.5-flash",
                quota: {
                  remainingPercentage: 80,
                  resetTime: new Date(Date.now() + 60000).toISOString()
                }
              }
            ]
          }
        }
      };
    }
  };

  const service = new AntigravityQuotaService(capacityService, mockTransport, {
    cooldownMs: 0,
    pollingIntervalMs: 60000
  });

  // Call concurrent refreshes
  const p1 = service.refresh("manual");
  const p2 = service.refresh("manual");
  await Promise.all([p1, p2]);

  // Total calls should be 2 (first failed, second succeeded within the single flight)
  assert.equal(callCount, 2, "Must fall through to second candidate within single flight");

  const snapshot = capacityService.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.scope, "gemini-2.5-flash");
  assert.equal(snapshot[0]?.remainingPercentage, 80);

  service.dispose();
});

function loadQuotaRefreshHandler(
  refresh: () => Promise<{ success: boolean }>,
  setQuotaRefreshError: (message: string | null) => void
): () => Promise<void> {
  const directUrl = new URL("../src/renderer/components/TelemetryHud.tsx", import.meta.url);
  const distUrl = new URL("../../src/renderer/components/TelemetryHud.tsx", import.meta.url);
  const fileUrl = fs.existsSync(directUrl) ? directUrl : distUrl;
  const source = fs.readFileSync(fileUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    "TelemetryHud.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  let initializer: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "handleRefreshQuota"
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  assert.ok(
    initializer,
    "The production handleRefreshQuota initializer must exist"
  );

  const javascript = ts.transpileModule(
    `(${initializer.getText(sourceFile)})`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None
      }
    }
  ).outputText;

  const result: unknown = vm.runInNewContext(
    javascript,
    {
      window: {
        cockpitApi: {
          providerCapacity: { refresh }
        }
      },
      setQuotaRefreshError
    },
    { timeout: 1000 }
  );

  assert.equal(typeof result, "function");
  return result as () => Promise<void>;
}

test("quota refresh contains IPC rejection and exposes an error", async () => {
  let calls = 0;
  const messages: Array<string | null> = [];

  const handler = loadQuotaRefreshHandler(
    async () => {
      calls++;
      throw new Error("quota IPC unavailable");
    },
    (message) => {
      messages.push(message);
    }
  );

  await assert.doesNotReject(
    handler,
    "A rejected IPC invocation must not escape the click handler"
  );

  assert.equal(calls, 1);
  assert.ok(
    messages.some(
      (message) =>
        typeof message === "string" && message.trim().length > 0
    ),
    "The failure must be reported, not silently swallowed"
  );
});

test("quota refresh preserves successful IPC invocation", async () => {
  let calls = 0;
  const messages: Array<string | null> = [];

  const handler = loadQuotaRefreshHandler(
    async () => {
      calls++;
      return { success: true };
    },
    (message) => {
      messages.push(message);
    }
  );

  await assert.doesNotReject(handler);
  assert.equal(calls, 1);
  assert.equal(
    messages.some(
      (message) =>
        typeof message === "string" && message.trim().length > 0
    ),
    false,
    "Successful refresh must not report a failure"
  );
});

test("Assertion Table 1: 50%, no reset, observed 2026-01-01T00:00Z -> resetAt=null; expiresAt=00:01Z", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");
  const payload = {
    quota: {
      models: [
        {
          modelId: "gemini-2.5-flash",
          quota: {
            remainingPercentage: 50
          }
        }
      ]
    }
  };

  const caps = parseAntigravityQuota(payload, observedAt, 60000);
  assert.equal(caps.length, 1);
  assert.equal(caps[0]?.source, "provider");
  assert.equal(caps[0]?.remainingPercentage, 50);
  assert.equal(caps[0]?.resetAt, null);
  assert.equal(caps[0]?.expiresAt, "2026-01-01T00:01:00.000Z");
  assert.equal(isCapacityActive(caps[0]!, observedAt.getTime()), true);
});

test("Assertion Table 2: remaining=0, limit=100, no reset -> valid capacity; 0%", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");
  const payload = {
    quota: {
      models: [
        {
          modelId: "gemini-2.5-pro",
          quota: {
            limit: 100,
            remaining: 0
          }
        }
      ]
    }
  };

  const caps = parseAntigravityQuota(payload, observedAt, 60000);
  assert.equal(caps.length, 1);
  assert.equal(caps[0]?.source, "provider");
  assert.equal(caps[0]?.remainingPercentage, 0);
  assert.equal(caps[0]?.limit, 100);
  assert.equal(caps[0]?.remaining, 0);
  assert.equal(caps[0]?.resetAt, null);
  assert.equal(calculateRemainingPercentage(caps[0]!), 0);
});

test("Assertion Table 3: resetTime=1767225660 or 1767225660000 -> resetAt=2026-01-01T00:01:00.000Z", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");
  const payloadSeconds = {
    quota: {
      models: [
        {
          modelId: "gemini-2.5-flash",
          quota: {
            remainingPercentage: 75,
            resetTime: 1767225660 // Unix seconds
          }
        }
      ]
    }
  };

  const capsSeconds = parseAntigravityQuota(payloadSeconds, observedAt, 120000);
  assert.equal(capsSeconds.length, 1);
  assert.equal(capsSeconds[0]?.resetAt, "2026-01-01T00:01:00.000Z");

  const payloadMs = {
    quota: {
      models: [
        {
          modelId: "gemini-2.5-flash",
          quota: {
            remainingPercentage: 75,
            resetTime: 1767225660000 // Unix milliseconds
          }
        }
      ]
    }
  };

  const capsMs = parseAntigravityQuota(payloadMs, observedAt, 120000);
  assert.equal(capsMs.length, 1);
  assert.equal(capsMs[0]?.resetAt, "2026-01-01T00:01:00.000Z");
});

test("Assertion Table 4: timeUntilResetMs=60000 at 00:00Z -> resetAt=00:01Z", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");
  const payload = {
    quota: {
      models: [
        {
          modelId: "gemini-2.5-flash",
          quota: {
            remainingPercentage: 80,
            timeUntilResetMs: 60000
          }
        }
      ]
    }
  };

  const caps = parseAntigravityQuota(payload, observedAt, 120000);
  assert.equal(caps.length, 1);
  assert.equal(caps[0]?.resetAt, "2026-01-01T00:01:00.000Z");
  assert.equal(caps[0]?.expiresAt, "2026-01-01T00:01:00.000Z");
});

test("Assertion Table 5: null reset; expiresAt=00:01Z; now=00:00Z / 00:01Z -> active / inactive", () => {
  const cap: ProviderCapacity = {
    provider: "gemini",
    scope: "gemini-2.5-flash",
    metric: "requests",
    limit: null,
    remaining: null,
    remainingPercentage: 90,
    resetAt: null,
    windowSeconds: null,
    windowKind: "unknown",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z"
  };

  const nowBeforeMs = new Date("2026-01-01T00:00:30.000Z").getTime();
  const nowAtExpiryMs = new Date("2026-01-01T00:01:00.000Z").getTime();

  assert.equal(isCapacityActive(cap, nowBeforeMs), true, "Capacity must be active before expiration");
  assert.equal(isCapacityActive(cap, nowAtExpiryMs), false, "Capacity must be inactive at/after expiration");
});

test("Real Language Server format: cascadeModelConfigData.clientModelConfigs with remainingFraction", () => {
  const nowMs = 1770000000000;
  const observedAt = new Date(nowMs);
  const futureResetIso = new Date(nowMs + 3600000).toISOString();

  const realServerPayload = {
    userStatus: {
      email: "test@example.com",
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelId: "gemini-3.8-flash-high",
            label: "Gemini 3.8 Flash (High)",
            quotaInfo: {
              remainingFraction: 0.6842371,
              resetTime: futureResetIso
            }
          },
          {
            modelId: "gemini-pro-agent",
            label: "Gemini 3.1 Pro (High)",
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: futureResetIso
            }
          },
          {
            modelId: "claude-sonnet-4-6",
            label: "Claude Sonnet 4.6 (Thinking)",
            quotaInfo: {
              remainingFraction: 1.0,
              resetTime: futureResetIso
            }
          }
        ]
      }
    }
  };

  const parsed = parseAntigravityQuota(realServerPayload, observedAt, 120000);
  assert.equal(parsed.length, 2, "Should parse only the 2 Gemini models, ignoring Claude");

  const flash = parsed.find((p) => p.scope === "gemini-3.8-flash-high");
  assert.ok(flash);
  assert.equal(flash.source, "provider");
  assert.equal(flash.remainingPercentage, 68.4);
  assert.equal(flash.limit, null);
  assert.equal(flash.remaining, null);
  assert.equal(flash.resetAt, futureResetIso);

  const pro = parsed.find((p) => p.scope === "gemini-pro-agent");
  assert.ok(pro);
  assert.equal(pro.source, "provider");
  assert.equal(pro.remainingPercentage, 50);
});

test("AntigravityQuotaClient sends x-codeium-csrf-token header", async () => {
  let receivedCodeiumHeader: string | undefined;
  let receivedCsrfHeader: string | undefined;

  const server = http.createServer((req, res) => {
    receivedCodeiumHeader = req.headers["x-codeium-csrf-token"] as string | undefined;
    receivedCsrfHeader = req.headers["x-csrf-token"] as string | undefined;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new AntigravityQuotaClient();
    await client.getUserStatus({ port, csrfToken: "sample-token-12345" });

    assert.equal(receivedCodeiumHeader, "sample-token-12345");
    assert.equal(receivedCsrfHeader, "sample-token-12345");
  } finally {
    server.close();
  }
});
test("an empty cascade array must not hide userStatus.quota.models", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");

  const models = [{
    modelId: "gemini-3.8-flash-high",
    model: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash High",
    label: "Gemini 3.8 Flash High",
    modelOrAlias: { model: "gemini-3.8-flash-high" },
    quota: {
      remainingPercentage: 50,
      remaining: 50,
      limit: 100,
      resetTime: "2026-01-01T00:01:00.000Z",
    },
  }];

  const baseline = parseAntigravityQuota(
    { userStatus: { quota: { models } } },
    observedAt,
    60_000,
  );

  assert.ok(
    baseline.length > 0,
    "Precondition: the legacy quota fixture must produce capacity",
  );

  const actual = parseAntigravityQuota(
    {
      userStatus: {
        quota: { models },
        cascadeModelConfigData: { clientModelConfigs: [] },
      },
    },
    observedAt,
    60_000,
  );

  assert.deepStrictEqual(actual, baseline);
});

test("an empty cascade array must not hide top-level quota.models", () => {
  const observedAt = new Date("2026-01-01T00:00:00.000Z");

  const models = [{
    modelId: "gemini-3.8-flash-high",
    model: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash High",
    label: "Gemini 3.8 Flash High",
    modelOrAlias: { model: "gemini-3.8-flash-high" },
    quota: {
      remainingPercentage: 50,
      remaining: 50,
      limit: 100,
      resetTime: "2026-01-01T00:01:00.000Z",
    },
  }];

  const baseline = parseAntigravityQuota(
    { quota: { models } },
    observedAt,
    60_000,
  );

  assert.ok(
    baseline.length > 0,
    "Precondition: the legacy quota fixture must produce capacity",
  );

  const actual = parseAntigravityQuota(
    {
      quota: { models },
      userStatus: {
        cascadeModelConfigData: { clientModelConfigs: [] },
      },
    },
    observedAt,
    60_000,
  );

  assert.deepStrictEqual(actual, baseline);
});

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIULJ8OM/xVTFSf3ynG5FnEdbr9l8UwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAwODE3MTk0NloXDTM2MTAw
NTE3MTk0NlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAxeYWnHDDqfG6FzAij9ZncocxJ5OmPxyWAYmWKL+IIguh
ihXNo3oNVR0BUY5/JtmnhOPiv6kvqHi21Y2WEVcVMXWvgB9QRaYND6i9uyTwEgNN
1qYqHU7kWk8vEAP7sK5TOy2K/uMWlkOBGsKpzsq//TRmEgskgAMbjw71wDjPlKl6
+8Ak2ycDZxBLUI7I9CzZ/p0C9gEC43sX+u/6Xfzxcz426HoZWwUC04Eb/gNXicbZ
g/jwp/V74K7uAeI1n+9L0DGvG3nnMGe+euRBk/eegv/ZTUaH0VOTktJwIaEF9OFJ
dinc+Uva1sIcMpjZ36+VGoZR7uHGfD1zvihiaB3AIwIDAQABo1MwUTAdBgNVHQ4E
FgQUjykV5USFXHTOlS/QBSUqQjTa5mAwHwYDVR0jBBgwFoAUjykV5USFXHTOlS/Q
BSUqQjTa5mAwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAxPYu
ibB9L7HBAZr1vY7z5K4iOE/9mdzt8I1pfnE+xaUItpG4ie/dX3GHXw2Cy4W6PsrU
li5nqrmaJlQ/USC1r0jD77mdLsVXR3ENcDS1a3jyro6cUkEegsG24reIdYOmDADL
1irgCPRvcldZed1ILTktW3nV0c7nWGqg/oos7INvxSrx40azlI5woSfDMK8/T5vS
BE3i+DVuRfklzdfOuwI/FP0F+uDteZDaUTAlskAj3jfANZB67mc8Hnd9VwrVPV5p
H0tzgi/KcymLfnETU+BdbQPcC9EpyhiAepHGB4nTIz+jZc/lLHOl4WDFyD/tJsHf
ssADVu8Q1VSyPOTibw==
-----END CERTIFICATE-----`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDF5haccMOp8boX
MCKP1mdyhzEnk6Y/HJYBiZYov4giC6GKFc2jeg1VHQFRjn8m2aeE4+K/qS+oeLbV
jZYRVxUxda+AH1BFpg0PqL27JPASA03WpiodTuRaTy8QA/uwrlM7LYr+4xaWQ4Ea
wqnOyr/9NGYSCySAAxuPDvXAOM+UqXr7wCTbJwNnEEtQjsj0LNn+nQL2AQLjexf6
7/pd/PFzPjboehlbBQLTgRv+A1eJxtmD+PCn9Xvgru4B4jWf70vQMa8beecwZ756
5EGT956C/9lNRofRU5OS0nAhoQX04Ul2Kdz5S9rWwhwymNnfr5UahlHu4cZ8PXO+
KGJoHcAjAgMBAAECggEABBdTxqvSx7Eeb+Xyrkw4OuxjjkC6/O6vhTGdypLcaBkb
H6UqvqNCd6IlXv/Ao4IiuJhoyB3hxSxVr0gsNDM7gMMWO+JUgP7D91u9gbXA8XEN
tg8dAMUa6xOxp+BFNEEDqc4GY8A4Z9ErxUIFS6fyXHQtsK139Yja6X6y2Dn0b0t2
TXJ3BQgk/TUOdRV84sgzLcZ8+aNYWDlQOVkA44ygXPHvgCZiEVc6Iql7Z0mWlUOI
n9EhUiyHOqC6u17UF72WwAbL0+Ivlr+BkyzAEZ2/4bLrM5iJyMq70c0vhWpAB/bu
vXpQNAJCJUSi9OZdjdDzcy3q4kTiM/0nPnRBm/qrJQKBgQD3F7d37HO3kMWxOpYK
HhUZTmS+KwvS0wQwika5+7A1I1HeIH+CWQFniwdV4YuEjHrwejUQqayxEKKTOMy9
5xjEBvVWM87suLUbxhwAfU+y6tEUAxjVTf2+kV+mI9yWBX8GkHP50Oc4PsVPR6jf
mdSxZDAIscwik6iKlEDuJouDZwKBgQDNCGNpKW8MeKgSM7Xsu39GYJuEKahBb1oh
StPY5ANgFu3OQyqzRu0gK2rtvY1bmVmJPFMzjC9leQsO9wUBE/EssFkgkB32KmXk
HN2PVx+PPNSAWcDZ+Sz3MxRAYgTJNNS6bVZWW7uOTscgdamh/1fU6vQ9LF/nc62m
seMowaED5QKBgQDbrNkvJCfIxkwMAdMM0aveYMTOEQUk/PfXk8fHZ41D4M/TFL9o
CmtmO8NcxfW89QwDqhJtavweO3TeQHw+RSvOc4VAizTnXludgqa4hLALmBojmZFF
al4yQ5pu4akmM2K4WkrRiblXVu8iScpIaMIgp7rQsAmVoAMSmTWUxO359wKBgB6r
/pMgy6gF9L6kVbbQZb3Vfe5LfQws6ELKut5bXdXmGDUe/yhKl/aUCC8AiEEHs8k/
6QJxGjYH4YufkHQU06Nnzi184b6NoSh62Po0glgfNXrt8lepWvyv+3uWLjkbWid5
a80HdAtZ5ZgJghLl6/HCJD9yf/ZT68pgGidir/+xAoGBAMCoVPiZAVnHfNihPgEp
t9tnPO02K8DVGb9RdMsojVvKOgiz4EufyKylD10HhsYCnDLyXjTBYDBk6Hbi3Gl8
7/Fzlzy23vDQFR35R5OdxMv+7r6Gu6uOtDfFklYjmCD1ygFZXvn6Hlz6I4syRwYE
fzKu2ugtFHumeyY5Ackwbxr1
-----END PRIVATE KEY-----`;

test("Assertion Table 1: unspecified + self-signed TLS -> HTTPS success; no HTTP", async () => {
  let httpsRequestCount = 0;
  const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
    httpsRequestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new AntigravityQuotaClient();
    const result = await client.getUserStatus({ port, csrfToken: "sample-token" });
    assert.ok(result, "HTTPS request must succeed");
    assert.equal(httpsRequestCount, 1, "Only 1 HTTPS request executed");
  } finally {
    server.close();
  }
});

test("Assertion Table 2: unspecified + plain HTTP; poll twice -> fallback once; cached HTTP", async () => {
  let httpRequestCount = 0;
  let tlsProbes = 0;
  const server = http.createServer((req, res) => {
    httpRequestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });
  server.on("clientError", (_err, socket) => {
    tlsProbes++;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new AntigravityQuotaClient();
    // First call: probe HTTPS, fails, falls back to HTTP and succeeds
    const result1 = await client.getUserStatus({ port, csrfToken: "tok" });
    assert.ok(result1);
    assert.equal(tlsProbes, 1, "First call must probe HTTPS on plain HTTP server");
    assert.equal(httpRequestCount, 1, "First call must reach plain HTTP server via fallback");

    // Second call: must use cached HTTP transport directly without probing HTTPS
    const result2 = await client.getUserStatus({ port, csrfToken: "tok" });
    assert.ok(result2);
    assert.equal(tlsProbes, 1, "Second call must bypass HTTPS probe and reuse cached transport");
    assert.equal(httpRequestCount, 2, "Second call must immediately use cached HTTP transport");
  } finally {
    server.close();
  }
});

test("Assertion Table 3: explicit HTTPS + plain HTTP -> reject; no fallback", async () => {
  let httpRequestCount = 0;
  const server = http.createServer((req, res) => {
    httpRequestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  try {
    process.env.ANTIGRAVITY_LS_ADDRESS = `https://127.0.0.1:${port}`;
    const client = new AntigravityQuotaClient();
    const discovered = await client.discover();
    const endpoint = discovered.find((ep) => ep.port === port);
    assert.ok(endpoint);

    await assert.rejects(
      async () => {
        await client.getUserStatus(endpoint);
      },
      "Explicit HTTPS against plain HTTP server must reject without falling back"
    );
    assert.equal(httpRequestCount, 0, "No plain HTTP request handler should be invoked");
  } finally {
    if (prevAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
    else delete process.env.ANTIGRAVITY_LS_ADDRESS;
    server.close();
  }
});

test("parseAddressString: scheme extraction and protocol support", () => {
  const client = new AntigravityQuotaClient();
  const parse = (client as unknown as {
    parseAddressString: (addr: string, csrf: string | null) => AntigravityEndpoint | null;
  }).parseAddressString.bind(client);

  const epHttps = parse("https://127.0.0.1:49999", "tok1");
  assert.ok(epHttps);
  assert.equal(epHttps.port, 49999);
  assert.deepEqual(epHttps, { port: 49999, csrfToken: "tok1" });

  const epHttp = parse("http://127.0.0.1:49998", "tok2");
  assert.ok(epHttp);
  assert.equal(epHttp.port, 49998);
  assert.deepEqual(epHttp, { port: 49998, csrfToken: "tok2" });

  const epNoScheme = parse("127.0.0.1:49997", null);
  assert.ok(epNoScheme);
  assert.equal(epNoScheme.port, 49997);
  assert.deepEqual(epNoScheme, { port: 49997, csrfToken: null });

  assert.equal(parse("ftp://127.0.0.1:49999", null), null);
  assert.equal(parse("https://remote.example.com:49999", null), null);
});

test("discoverFromFile: protocol and https boolean flag extraction", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-proto-test-"));
  const cfgHttps = path.join(tmpDir, "endpoint-https.json");
  fs.writeFileSync(cfgHttps, JSON.stringify({ port: 12345, protocol: "https", csrfToken: "t1" }), "utf8");

  const cfgBoolTrue = path.join(tmpDir, "endpoint-bool-true.json");
  fs.writeFileSync(cfgBoolTrue, JSON.stringify({ port: 12346, https: true, csrfToken: "t2" }), "utf8");

  const cfgBoolFalse = path.join(tmpDir, "endpoint-bool-false.json");
  fs.writeFileSync(cfgBoolFalse, JSON.stringify({ port: 12347, https: false, csrfToken: "t3" }), "utf8");

  const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  try {
    process.env.ANTIGRAVITY_LS_CONFIG_PATH = cfgHttps;
    let client = new AntigravityQuotaClient();
    let endpoints = await client.discover();
    assert.deepEqual(endpoints[0], { port: 12345, csrfToken: "t1" });

    process.env.ANTIGRAVITY_LS_CONFIG_PATH = cfgBoolTrue;
    client = new AntigravityQuotaClient();
    endpoints = await client.discover();
    assert.deepEqual(endpoints[0], { port: 12346, csrfToken: "t2" });

    process.env.ANTIGRAVITY_LS_CONFIG_PATH = cfgBoolFalse;
    client = new AntigravityQuotaClient();
    endpoints = await client.discover();
    assert.deepEqual(endpoints[0], { port: 12347, csrfToken: "t3" });
  } finally {
    if (prevAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
    delete process.env.ANTIGRAVITY_LS_CONFIG_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Stage 4 Adversarial 1: TLS access-denied alert must not trigger plaintext fallback", async () => {
  const client = new AntigravityQuotaClient();
  const isProtoMismatch = (client as unknown as { isProtocolMismatch: (err: unknown) => boolean }).isProtocolMismatch.bind(client);

  const alertErr1 = new Error("SSL routines:ssl3_read_bytes:tlsv1 alert access denied");
  assert.equal(isProtoMismatch(alertErr1), false, "tlsv1 alert access denied must not trigger fallback");

  const alertErr2 = Object.assign(new Error("SSL alert"), { code: "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED" });
  assert.equal(isProtoMismatch(alertErr2), false, "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED must not trigger fallback");

  const certErr = Object.assign(new Error("Self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.equal(isProtoMismatch(certErr), false, "Certificate verification error must not trigger fallback");
});

test("Stage 4 Adversarial 2: post-handshake EPROTO / socket drops must not trigger plaintext fallback", async () => {
  let httpsConnections = 0;
  const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, _res) => {
    httpsConnections++;
    // Established TLS connection: abruptly destroy socket during request body reading
    req.socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new AntigravityQuotaClient();
    await assert.rejects(
      async () => {
        await client.getUserStatus({ port, csrfToken: "sample-token" });
      },
      "Post-handshake socket termination must reject and not fall back to plain HTTP"
    );
    assert.equal(httpsConnections, 1, "Only initial HTTPS request was attempted; no plain HTTP fallback");
  } finally {
    server.close();
  }
});

test("Stage 4 Adversarial 3: cached HTTP recovers when the same endpoint transitions to HTTPS", async () => {
  // Step 1: Start plain HTTP server
  let httpCount = 0;
  let httpsCount = 0;

  const httpServer = http.createServer((_req, res) => {
    httpCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });
  httpServer.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const client = new AntigravityQuotaClient();

  // Call against HTTP server -> caches "http"
  const res1 = await client.getUserStatus({ port, csrfToken: "tok" });
  assert.ok(res1);
  assert.equal(httpCount, 1);

  // Close HTTP server and start HTTPS server on the EXACT SAME PORT
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  const httpsServer = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
    httpsCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [{ modelId: "recovered-gemini" }] } } }));
  });

  await new Promise<void>((resolve) => httpsServer.listen(port, "127.0.0.1", resolve));

  try {
    // Call again on same client: cached "http" fails against HTTPS socket, recovers, retries HTTPS and succeeds!
    const res2 = (await client.getUserStatus({ port, csrfToken: "tok" })) as {
      userStatus: { quota: { models: Array<{ modelId: string }> } };
    };
    assert.ok(res2);
    assert.equal(httpsCount, 1, "Must successfully recover and query HTTPS server");
    assert.equal(res2.userStatus.quota.models[0]?.modelId, "recovered-gemini");
  } finally {
    httpsServer.close();
  }
});

test("AntigravityQuotaService: candidate deduplication upgrades unauthenticated endpoint to authenticated", async () => {
  const recordedEndpoints: AntigravityEndpoint[] = [];
  const fakeTransport: AntigravityQuotaTransport = {
    async discover(): Promise<readonly AntigravityEndpoint[]> {
      return [
        { port: 53272, csrfToken: null },
        { port: 53272, csrfToken: "verified-csrf-token" }
      ];
    },
    async getUserStatus(ep: AntigravityEndpoint): Promise<unknown> {
      recordedEndpoints.push(ep);
      if (!ep.csrfToken) {
        throw new Error("HTTP 401 Unauthorized");
      }
      return {
        userStatus: {
          quota: {
            models: [
              {
                modelId: "gemini-flash",
                quota: {
                  remainingPercentage: 82.4,
                  resetTime: new Date(Date.now() + 3600000).toISOString()
                }
              }
            ]
          }
        }
      };
    }
  };

  const capacityService = new ProviderCapacityService();
  const quotaService = new AntigravityQuotaService(
    capacityService,
    fakeTransport,
    { pollingIntervalMs: 60000 }
  );

  try {
    await quotaService.refresh("manual");
    // Verify that the candidate was upgraded and called with verified CSRF token first!
    assert.ok(recordedEndpoints.length > 0);
    assert.equal(recordedEndpoints[0]?.csrfToken, "verified-csrf-token");
    const snapshot = capacityService.snapshot();
    const geminiCap = snapshot.find((c) => c.provider === "gemini" && c.scope === "gemini-flash");
    assert.ok(geminiCap);
    assert.equal(geminiCap.remainingPercentage, 82.4);
  } finally {
    quotaService.dispose();
  }
});

test(
  "configured endpoint discovery preserves the original public endpoint shape",
  { concurrency: false },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "antigravity-endpoint-contract-")
    );
    const userDataPath = path.join(root, "user-data");
    const workingDirectory = path.join(root, "working-directory");
    const originalCwd = process.cwd();
    const token = `contract-token-${path.basename(root)}`;
    const port = 65123;

    try {
      fs.mkdirSync(userDataPath);
      fs.mkdirSync(workingDirectory);
      fs.writeFileSync(
        path.join(userDataPath, "antigravity-endpoint.json"),
        JSON.stringify({
          port,
          csrfToken: token,
          protocol: "https"
        }),
        "utf8"
      );
      process.chdir(workingDirectory);

      const client = new AntigravityQuotaClient({ userDataPath });
      const endpoints = await client.discover();
      const endpoint = endpoints.find(
        (candidate) =>
          candidate.port === port && candidate.csrfToken === token
      );

      assert.ok(endpoint, "The configured endpoint must remain discoverable");
      assert.deepEqual(
        endpoint,
        { port, csrfToken: token },
        "Discovery must not extend the frozen AntigravityEndpoint contract"
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "an unrelated working-directory endpoint file does not become a discovery source",
  { concurrency: false },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "antigravity-cwd-contract-")
    );
    const userDataPath = path.join(root, "user-data");
    const workingDirectory = path.join(root, "working-directory");
    const originalCwd = process.cwd();
    const token = `unconfigured-cwd-token-${path.basename(root)}`;
    const port = 65124;

    try {
      fs.mkdirSync(userDataPath);
      fs.mkdirSync(workingDirectory);
      fs.writeFileSync(
        path.join(workingDirectory, "antigravity-endpoint.json"),
        JSON.stringify({ port, csrfToken: token }),
        "utf8"
      );
      process.chdir(workingDirectory);

      const client = new AntigravityQuotaClient({ userDataPath });
      const endpoints = await client.discover();

      assert.equal(
        endpoints.some(
          (candidate) =>
            candidate.port === port && candidate.csrfToken === token
        ),
        false,
        "Changing cwd must not authorize an additional configuration source"
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test("Plan A Golden Assertion 1: root cascadeModelConfigData with modelName and fraction=0.6842371 parses as available 68.4%", () => {
  const payload = {
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          modelName: "gemini-pro",
          label: "Gemini 1.5 Pro",
          quotaInfo: {
            remainingFraction: 0.6842371,
            resetTime: "2026-10-10T00:00:00Z"
          }
        }
      ]
    }
  };

  const res = parseQuotaResponse(payload);
  assert.equal(res.status, "available");
  if (res.status === "available") {
    assert.equal(res.quota.length, 1);
    const item = res.quota[0]!;
    assert.equal(item.scope, "gemini-pro");
    assert.equal(item.remainingPercentage, 68.4);
    assert.equal(calculateRemainingPercentage(item), 68.4);
  }
});

test("Plan A Golden Assertion 2: userStatus cascadeModelConfigData with remainingFraction=0 parses as available 0%", () => {
  const payload = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelId: "gemini-3.8-flash-high",
            quotaInfo: {
              remainingFraction: 0,
              resetTime: "2026-10-10T00:00:00Z"
            }
          }
        ]
      }
    }
  };

  const res = parseQuotaResponse(payload);
  assert.equal(res.status, "available");
  if (res.status === "available") {
    assert.equal(res.quota.length, 1);
    const item = res.quota[0]!;
    assert.equal(item.remainingPercentage, 0);
    assert.equal(calculateRemainingPercentage(item), 0);
  }
});

test("Plan A Golden Assertion 3: Native ECONNRESET on HTTPS triggers HTTP fallback retry", async () => {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ userStatus: { quota: { models: [] } } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new AntigravityQuotaClient();
    // A plain HTTP server naturally resets/drops TLS handshake when contacted via HTTPS
    // isProtocolMismatch allows fallback to HTTP without requiring err.isHandshakeError === true
    const result = await client.getUserStatus({ port, csrfToken: null });
    assert.ok(result);
    assert.ok(attempts >= 1);
  } finally {
    server.close();
  }
});