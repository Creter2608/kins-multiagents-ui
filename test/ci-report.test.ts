import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const CI_REPORT_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'ci-report.mjs')).href;

const {
  compareBenchmarkReports,
  generateMarkdownScorecard,
  SCORECARD_MARKER
} = await import(CI_REPORT_URL) as typeof import('../scripts/harness/ci-report.d.mts');

test('ci-report: compareBenchmarkReports passes when candidate improves without regression', () => {
  const baseline = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '1.0.0', schemaVersion: 1 as const, manifestSha256: '0'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.8, passAtK: 0.8, k: 1, ssi: 1.0 },
    violations: [],
    totalCostMicroUsd: 1_000_000,
    dollarEfficiencyIndex: 2.0
  };

  const candidate = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '1.0.0', schemaVersion: 1 as const, manifestSha256: '0'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.85, passAtK: 0.85, k: 1, ssi: 0.98 },
    violations: [],
    totalCostMicroUsd: 1_200_000,
    dollarEfficiencyIndex: 2.1
  };

  const result = compareBenchmarkReports(baseline, candidate, {
    minPassAt1: 0.8,
    maxSsiRegression: 0.05
  });

  assert.strictEqual(result.incomparable, false);
  assert.strictEqual(result.gatePassed, true);
  assert.strictEqual(result.failureReasons.length, 0);
  assert.strictEqual(result.metrics?.passAt1.delta, 0.05);
  assert.strictEqual(result.metrics?.ssi.delta, -0.02);
});

test('ci-report: compareBenchmarkReports blocks regression on Pass@1, SSI, and anti-gaming violations', () => {
  const baseline = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '1.0.0', schemaVersion: 1 as const, manifestSha256: '0'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.9, passAtK: 0.9, k: 1, ssi: 1.0 },
    violations: [],
    totalCostMicroUsd: 1_000_000,
    dollarEfficiencyIndex: 2.0
  };

  // Regressed candidate with violations
  const candidate = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '1.0.0', schemaVersion: 1 as const, manifestSha256: '0'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.7, passAtK: 0.7, k: 1, ssi: 0.8 },
    violations: [
      { code: 'FORBIDDEN_FILE_MODIFIED' as const, path: '.eval/task.json', message: 'tampered' }
    ],
    totalCostMicroUsd: 1_500_000,
    dollarEfficiencyIndex: 1.5
  };

  const result = compareBenchmarkReports(baseline, candidate, {
    maxPassAt1Regression: 0.0,
    maxSsiRegression: 0.05
  });

  assert.strictEqual(result.gatePassed, false);
  assert.ok(result.failureReasons.length >= 2, 'Should report multiple failure reasons');
  assert.ok(result.failureReasons.some(r => r.includes('Pass@1 regression')));
  assert.ok(result.failureReasons.some(r => r.includes('SSI')));
  assert.ok(result.failureReasons.some(r => r.includes('Anti-gaming check failed')));
});

test('ci-report: compareBenchmarkReports identifies incomparable reports across dataset versions', () => {
  const baseline = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '1.0.0', schemaVersion: 1 as const, manifestSha256: '0'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.8, passAtK: 0.8, k: 1, ssi: 1.0 },
    violations: []
  };

  const candidate = {
    schemaVersion: 1 as const,
    dataset: { datasetId: 'ds-1', version: '2.0.0', schemaVersion: 1 as const, manifestSha256: '1'.repeat(64), createdAt: '' },
    metrics: { passAt1: 0.85, passAtK: 0.85, k: 1, ssi: 1.0 },
    violations: []
  };

  const result = compareBenchmarkReports(baseline, candidate);
  assert.strictEqual(result.incomparable, true);
  assert.strictEqual(result.gatePassed, false);
  assert.ok(result.incomparableReason?.includes('Dataset version mismatch'));
});

test('ci-report: generateMarkdownScorecard renders idempotent markdown with valid scorecard markers', () => {
  const comparison = {
    incomparable: false,
    gatePassed: true,
    failureReasons: [],
    metrics: {
      passAt1: { baseline: 0.8, candidate: 0.85, delta: 0.05, passed: true },
      ssi: { baseline: 1.0, candidate: 0.98, delta: -0.02, passed: true },
      dei: { baseline: 2.0, candidate: 2.2, delta: 0.2 },
      costMicroUsd: { baseline: 1_000_000, candidate: 1_100_000, delta: 100_000 },
      violations: { baselineCount: 0, candidateCount: 0, clean: true }
    }
  };

  const scorecard = generateMarkdownScorecard(comparison, { prNumber: 42, commitSha: 'abcdef123456' });

  // Must begin with the idempotent marker
  assert.ok(scorecard.startsWith(SCORECARD_MARKER));
  assert.ok(scorecard.includes('PR #42'));
  assert.ok(scorecard.includes('GATE PASSED'));
  assert.ok(scorecard.includes('| **Pass@1** | 80% | 85% | +5% | ✅ PASS |'));
  assert.ok(scorecard.includes('Kins Autonomous Agent Benchmark Engine'));
});
