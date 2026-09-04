import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const TELEMETRY_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'telemetry.mjs')).href;
const {
  normalizeTokenUsage,
  loadPricingCatalog,
  calculateCostAttribution,
  calculateDollarEfficiencyIndex,
  AuditEventStream,
  computeAuditEventHash,
  canonicalJsonStringify,
  buildBatchEvaluationReport
} = await import(TELEMETRY_URL) as typeof import('../scripts/harness/telemetry.d.mts');

test('telemetry: normalizeTokenUsage handles diverse provider schemas deterministically', () => {
  // Standard format
  const std = normalizeTokenUsage({
    promptTokens: 100,
    completionTokens: 50,
    cacheReadTokens: 25,
    cacheWriteTokens: 10,
    source: 'provider'
  });
  assert.deepEqual(std, {
    promptTokens: 100,
    completionTokens: 50,
    cacheReadTokens: 25,
    cacheWriteTokens: 10,
    source: 'provider'
  });

  // OpenAI format
  const openai = normalizeTokenUsage({
    prompt_tokens: 1500,
    completion_tokens: 400,
    prompt_tokens_details: { cached_tokens: 300 }
  });
  assert.strictEqual(openai.promptTokens, 1500);
  assert.strictEqual(openai.completionTokens, 400);
  assert.strictEqual(openai.cacheReadTokens, 300);
  assert.strictEqual(openai.cacheWriteTokens, 0);
  assert.strictEqual(openai.source, 'provider');

  // Anthropic format
  const anthropic = normalizeTokenUsage({
    input_tokens: 2000,
    output_tokens: 800,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 250
  });
  assert.strictEqual(anthropic.promptTokens, 2000);
  assert.strictEqual(anthropic.completionTokens, 800);
  assert.strictEqual(anthropic.cacheReadTokens, 500);
  assert.strictEqual(anthropic.cacheWriteTokens, 250);

  // Google Gemini format
  const gemini = normalizeTokenUsage({
    promptTokenCount: 3500,
    candidatesTokenCount: 1200,
    cachedContentTokenCount: 600
  });
  assert.strictEqual(gemini.promptTokens, 3500);
  assert.strictEqual(gemini.completionTokens, 1200);
  assert.strictEqual(gemini.cacheReadTokens, 600);
  assert.strictEqual(gemini.cacheWriteTokens, 0);

  // Malformed / Empty fallback
  const empty = normalizeTokenUsage(null);
  assert.deepEqual(empty, {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'unavailable'
  });

  // Negative numbers clamped to zero
  const clamped = normalizeTokenUsage({ promptTokens: -50, completionTokens: -20 });
  assert.strictEqual(clamped.promptTokens, 0);
  assert.strictEqual(clamped.completionTokens, 0);
});

test('telemetry: loadPricingCatalog loads valid schema and rejects invalid catalogs', () => {
  const catalog = loadPricingCatalog();
  assert.ok(catalog.version, 'Catalog should have a version');
  assert.strictEqual(catalog.currency, 'USD');
  assert.ok(catalog.models['gpt-4o'], 'Should include gpt-4o');
  assert.ok(catalog.models['claude-3-5-sonnet-20241022'], 'Should include claude-3-5-sonnet');
  assert.ok(catalog.models['gemini-1.5-pro'], 'Should include gemini-1.5-pro');

  // Invalid catalog without version
  assert.throws(() => {
    loadPricingCatalog({ currency: 'USD', models: {} } as any);
  }, /missing 'version' or 'models'/);

  // Invalid path
  assert.throws(() => {
    loadPricingCatalog('/path/to/nonexistent/catalog.json');
  }, /Pricing catalog not found/);
});

test('telemetry: calculateCostAttribution computes exact integer micro-USD without float drift', () => {
  // Test case with GPT-4o
  // input: 1M tokens @ 2,500,000 microUSD/1M = 2,500,000
  // output: 500k tokens @ 10,000,000 microUSD/1M = 5,000,000
  // cacheRead: 1M tokens @ 1,250,000 microUSD/1M = 1,250,000
  const usage = {
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    source: 'provider' as const
  };

  const cost = calculateCostAttribution(usage, 'gpt-4o');
  assert.strictEqual(cost.currency, 'USD');
  assert.strictEqual(cost.inputMicroUsd, 2_500_000);
  assert.strictEqual(cost.outputMicroUsd, 5_000_000);
  assert.strictEqual(cost.cacheMicroUsd, 1_250_000);
  assert.strictEqual(cost.surchargeMicroUsd, 0);
  assert.strictEqual(cost.totalMicroUsd, 8_750_000);

  // Integer verification: all fields must be integer
  assert.ok(Number.isInteger(cost.inputMicroUsd));
  assert.ok(Number.isInteger(cost.outputMicroUsd));
  assert.ok(Number.isInteger(cost.cacheMicroUsd));
  assert.ok(Number.isInteger(cost.totalMicroUsd));

  // Custom rates and surcharge
  const customCost = calculateCostAttribution(
    { promptTokens: 10_000, completionTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'gateway' as const },
    'custom-model',
    {
      customRates: {
        provider: 'custom',
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 2_000_000
      },
      surchargeMicroUsd: 50
    }
  );
  assert.strictEqual(customCost.inputMicroUsd, 10_000);
  assert.strictEqual(customCost.outputMicroUsd, 10_000);
  assert.strictEqual(customCost.surchargeMicroUsd, 50);
  assert.strictEqual(customCost.totalMicroUsd, 20_050);

  // Unknown model throws
  assert.throws(() => {
    calculateCostAttribution(usage, 'unknown-unlisted-model');
  }, /not found in pricing catalog/);
});

test('telemetry: calculateDollarEfficiencyIndex matches compact test assertion and prevents division by zero', () => {
  // Compact assertion table from Roadmap:
  // Input Scenario: passedWeight=4, cost=2,000,000 microUSD -> Expected Output: DEI = 2.0
  const dei = calculateDollarEfficiencyIndex(4, 2_000_000);
  assert.strictEqual(dei, 2.0);

  // Additional ratio checks
  const deiHalf = calculateDollarEfficiencyIndex(1, 2_000_000);
  assert.strictEqual(deiHalf, 0.5);

  const deiZeroPass = calculateDollarEfficiencyIndex(0, 1_000_000);
  assert.strictEqual(deiZeroPass, 0);

  // Zero cost resolves to null (avoids division by zero)
  assert.strictEqual(calculateDollarEfficiencyIndex(5, 0), null);

  // Negative or invalid costs resolve to null
  assert.strictEqual(calculateDollarEfficiencyIndex(5, -100), null);
  assert.strictEqual(calculateDollarEfficiencyIndex(5, NaN), null);
});

test('telemetry: AuditEventStream guarantees sequence integrity and catches payload tampering', () => {
  const stream = new AuditEventStream();

  const ev0 = stream.append('TASK_STARTED', { taskId: 'task-1' });
  assert.strictEqual(ev0.sequence, 0);
  assert.strictEqual(ev0.prevHash, '0'.repeat(64));
  assert.strictEqual(typeof ev0.hash, 'string');
  assert.strictEqual(ev0.hash.length, 64);

  const ev1 = stream.append('TASK_COMPLETED', { taskId: 'task-1', passed: true });
  assert.strictEqual(ev1.sequence, 1);
  assert.strictEqual(ev1.prevHash, ev0.hash);

  const ev2 = stream.append('BATCH_COMPLETED', { passedCount: 1 });
  assert.strictEqual(ev2.sequence, 2);
  assert.strictEqual(ev2.prevHash, ev1.hash);

  // Verify valid stream
  const check = stream.verify();
  assert.strictEqual(check.valid, true);
  assert.strictEqual(stream.getDigest(), ev2.hash);

  // Test JSONL roundtrip
  const jsonl = stream.toJSONL();
  const reconstructed = AuditEventStream.fromJSONL(jsonl);
  assert.strictEqual(reconstructed.length, 3);
  assert.strictEqual(reconstructed.verify().valid, true);
  assert.strictEqual(reconstructed.getDigest(), ev2.hash);

  // Tamper detection: modifying an event payload must invalidate the chain
  const tamperedJsonl = jsonl.replace('"passed":true', '"passed":false');
  assert.throws(() => {
    AuditEventStream.fromJSONL(tamperedJsonl);
  }, /Corrupted audit stream: Tampered event payload/);
});

test('telemetry: buildBatchEvaluationReport produces complete conformant batch report', () => {
  const stream = new AuditEventStream();
  stream.append('BATCH_STARTED', { total: 2 });
  stream.append('BATCH_COMPLETED', { total: 2 });

  const tasks = [
    {
      schemaVersion: 1 as const,
      id: 'task-1',
      title: 'T1',
      kind: 'f2p' as const,
      command: { argv: ['echo'] as const, timeoutMs: 1000 },
      hiddenAssertions: [],
      weight: 3
    },
    {
      schemaVersion: 1 as const,
      id: 'task-2',
      title: 'T2',
      kind: 'p2p' as const,
      command: { argv: ['echo'] as const, timeoutMs: 1000 },
      hiddenAssertions: [],
      weight: 1
    }
  ];

  const attempts = [
    {
      runId: 'run-1',
      taskId: 'task-1',
      attempt: 1,
      workerId: 'worker-1',
      containerId: 'c-1',
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: '2026-09-04T00:00:01.000Z',
      tokenUsage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'provider' as const },
      cost: {
        pricingCatalogVersion: '2026-09-01',
        currency: 'USD' as const,
        inputMicroUsd: 1_000_000,
        outputMicroUsd: 1_000_000,
        cacheMicroUsd: 0,
        surchargeMicroUsd: 0,
        totalMicroUsd: 2_000_000
      }
    }
  ];

  const taskReports = [
    {
      schemaVersion: 1 as const,
      baseCommit: 'HEAD',
      metrics: { passAt1: 1, passAtK: 1, k: 1 as const, ssi: 0 },
      passed: true,
      results: [
        {
          id: 'task-1',
          kind: 'f2p' as const,
          base: { exitCode: 1, passed: false, signal: null, timedOut: false },
          current: { exitCode: 0, passed: true, signal: null, timedOut: false },
          passed: true
        }
      ],
      violations: []
    }
  ];

  const report = buildBatchEvaluationReport({
    attempts,
    taskReports,
    tasks,
    auditStream: stream
  });

  assert.strictEqual(report.schemaVersion, 1);
  assert.strictEqual(report.weightedPassed, 3); // task-1 has weight 3
  assert.strictEqual(report.totalCostMicroUsd, 2_000_000);
  assert.strictEqual(report.dollarEfficiencyIndex, 1.5); // 3 * 1,000,000 / 2,000,000 = 1.5
  assert.strictEqual(report.auditDigest, stream.getDigest());
});
