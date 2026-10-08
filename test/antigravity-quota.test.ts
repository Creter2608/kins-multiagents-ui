import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AddressInfo } from "node:net";
import ts from "typescript";
import {
  isGeminiScope,
  isGeminiProScope,
  parseAntigravityQuota
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
