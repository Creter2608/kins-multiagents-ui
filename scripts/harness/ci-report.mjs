/**
 * scripts/harness/ci-report.mjs
 * Continuous Integration & Pull Request Quality Gate Engine.
 * Compares baseline and candidate benchmark evaluation reports, enforces regression gates
 * (Pass@1 floor, SSI regression ceiling, zero anti-gaming violations), detects incomparable
 * dataset schema/version mismatches, and generates idempotent GitHub PR markdown scorecards.
 */

export const SCORECARD_MARKER = '<!-- kins-eval-scorecard -->';

/**
 * Compares two benchmark reports and evaluates CI quality gates.
 *
 * @param {import('../../src/shared/harness.js').BatchEvaluationReport | import('../../src/shared/harness.js').EvaluationReport} baseline
 * @param {import('../../src/shared/harness.js').BatchEvaluationReport | import('../../src/shared/harness.js').EvaluationReport} candidate
 * @param {object} [options={}]
 * @returns {object}
 */
export function compareBenchmarkReports(baseline, candidate, options = {}) {
  if (!baseline || typeof baseline !== 'object') {
    throw new TypeError('baseline report must be an object');
  }
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('candidate report must be an object');
  }

  // Check schema version compatibility
  if (baseline.schemaVersion !== candidate.schemaVersion) {
    return {
      incomparable: true,
      incomparableReason: `Schema version mismatch: baseline (${baseline.schemaVersion}) vs candidate (${candidate.schemaVersion})`,
      gatePassed: false,
      failureReasons: ['Incomparable reports: schema version mismatch']
    };
  }

  // Check dataset version compatibility if both reports contain dataset metadata
  const baseDataset = /** @type {any} */ (baseline).dataset;
  const candDataset = /** @type {any} */ (candidate).dataset;
  if (baseDataset && candDataset) {
    if (baseDataset.datasetId !== candDataset.datasetId || baseDataset.version !== candDataset.version) {
      return {
        incomparable: true,
        incomparableReason: `Dataset version mismatch: baseline (${baseDataset.datasetId}@${baseDataset.version}) vs candidate (${candDataset.datasetId}@${candDataset.version})`,
        gatePassed: false,
        failureReasons: ['Incomparable reports: dataset version mismatch']
      };
    }
  }

  const baseMetrics = baseline.metrics || { passAt1: 0, ssi: 1 };
  const candMetrics = candidate.metrics || { passAt1: 0, ssi: 1 };

  const minPassAt1 = typeof options.minPassAt1 === 'number' ? options.minPassAt1 : 0.0;
  const maxPassAt1Regression = typeof options.maxPassAt1Regression === 'number' ? options.maxPassAt1Regression : 0.0;
  const maxSsiRegression = typeof options.maxSsiRegression === 'number' ? options.maxSsiRegression : 0.05;
  const requireCleanViolations = options.requireCleanViolations !== false;

  const passAt1Delta = Math.round((candMetrics.passAt1 - baseMetrics.passAt1) * 10000) / 10000;
  const ssiDelta = Math.round((candMetrics.ssi - baseMetrics.ssi) * 10000) / 10000;

  const baseViolations = Array.isArray(baseline.violations) ? baseline.violations : [];
  const candViolations = Array.isArray(candidate.violations) ? candidate.violations : [];

  const baseCost = typeof /** @type {any} */ (baseline).totalCostMicroUsd === 'number'
    ? /** @type {any} */ (baseline).totalCostMicroUsd
    : 0;
  const candCost = typeof /** @type {any} */ (candidate).totalCostMicroUsd === 'number'
    ? /** @type {any} */ (candidate).totalCostMicroUsd
    : 0;

  const baseDei = typeof /** @type {any} */ (baseline).dollarEfficiencyIndex === 'number'
    ? /** @type {any} */ (baseline).dollarEfficiencyIndex
    : null;
  const candDei = typeof /** @type {any} */ (candidate).dollarEfficiencyIndex === 'number'
    ? /** @type {any} */ (candidate).dollarEfficiencyIndex
    : null;

  const failureReasons = [];

  // 1. Pass@1 floor check
  if (candMetrics.passAt1 < minPassAt1) {
    failureReasons.push(
      `Candidate Pass@1 rate (${Math.round(candMetrics.passAt1 * 100)}%) is below minimum required floor (${Math.round(minPassAt1 * 100)}%)`
    );
  }

  // 2. Pass@1 regression check
  if (passAt1Delta < -maxPassAt1Regression) {
    failureReasons.push(
      `Pass@1 regression detected: candidate degraded by ${Math.abs(Math.round(passAt1Delta * 100))}% (allowed regression: ${Math.round(maxPassAt1Regression * 100)}%)`
    );
  }

  // 3. SSI regression check
  if (ssiDelta < -maxSsiRegression) {
    failureReasons.push(
      `SSI (System Stability Index) regression detected: candidate degraded by ${Math.abs(Math.round(ssiDelta * 100))}% (allowed regression: ${Math.round(maxSsiRegression * 100)}%)`
    );
  }

  // 4. Anti-gaming violations check
  if (requireCleanViolations && candViolations.length > 0) {
    failureReasons.push(
      `Anti-gaming check failed: candidate triggered ${candViolations.length} violation(s)`
    );
  }

  const gatePassed = failureReasons.length === 0;

  return {
    incomparable: false,
    gatePassed,
    failureReasons,
    metrics: {
      passAt1: {
        baseline: baseMetrics.passAt1,
        candidate: candMetrics.passAt1,
        delta: passAt1Delta,
        passed: passAt1Delta >= -maxPassAt1Regression && candMetrics.passAt1 >= minPassAt1
      },
      ssi: {
        baseline: baseMetrics.ssi,
        candidate: candMetrics.ssi,
        delta: ssiDelta,
        passed: ssiDelta >= -maxSsiRegression
      },
      dei: {
        baseline: baseDei,
        candidate: candDei,
        delta: (baseDei !== null && candDei !== null) ? Math.round((candDei - baseDei) * 10000) / 10000 : null
      },
      costMicroUsd: {
        baseline: baseCost,
        candidate: candCost,
        delta: candCost - baseCost
      },
      violations: {
        baselineCount: baseViolations.length,
        candidateCount: candViolations.length,
        clean: candViolations.length === 0
      }
    }
  };
}

/**
 * Generates an idempotent GitHub PR markdown comment scorecard.
 *
 * @param {object} comparison Result from compareBenchmarkReports
 * @param {object} [options={}]
 * @returns {string}
 */
export function generateMarkdownScorecard(comparison, options = {}) {
  const prNumber = options.prNumber ? ` (PR #${options.prNumber})` : '';
  const commitSha = options.commitSha ? ` \`${options.commitSha.slice(0, 8)}\`` : '';

  if (comparison.incomparable) {
    return [
      SCORECARD_MARKER,
      `## ⚠️ Incomparable Benchmark Evaluation${prNumber}`,
      '',
      `**Status:** Incomparable evaluation reports cannot be judged automatically.`,
      `**Reason:** ${comparison.incomparableReason}`,
      ''
    ].join('\n');
  }

  const statusBadge = comparison.gatePassed
    ? '✅ **GATE PASSED**'
    : '❌ **GATE FAILED**';

  const m = comparison.metrics;

  const fmtPercent = (val) => `${Math.round(val * 100)}%`;
  const fmtDeltaPercent = (val) => {
    const sign = val > 0 ? '+' : '';
    return `${sign}${Math.round(val * 100)}%`;
  };

  const fmtCost = (microUsd) => `$${(microUsd / 1_000_000).toFixed(4)}`;

  const lines = [
    SCORECARD_MARKER,
    `## 🧪 Autonomous Agent Evaluation Scorecard${prNumber}${commitSha}`,
    '',
    `**Quality Gate Status:** ${statusBadge}`,
    '',
    '| Evaluation Metric | Baseline | Candidate | Delta | Gate Status |',
    '| :--- | :---: | :---: | :---: | :---: |',
    `| **Pass@1** | ${fmtPercent(m.passAt1.baseline)} | ${fmtPercent(m.passAt1.candidate)} | ${fmtDeltaPercent(m.passAt1.delta)} | ${m.passAt1.passed ? '✅ PASS' : '❌ FAIL'} |`,
    `| **SSI (Regression Stability)** | ${fmtPercent(m.ssi.baseline)} | ${fmtPercent(m.ssi.candidate)} | ${fmtDeltaPercent(m.ssi.delta)} | ${m.ssi.passed ? '✅ PASS' : '❌ FAIL'} |`,
    `| **DEI (Dollar Efficiency)** | ${m.dei.baseline ?? 'N/A'} | ${m.dei.candidate ?? 'N/A'} | ${m.dei.delta !== null ? (m.dei.delta > 0 ? `+${m.dei.delta}` : `${m.dei.delta}`) : 'N/A'} | ℹ️ INFO |`,
    `| **Total Evaluation Cost** | ${fmtCost(m.costMicroUsd.baseline)} | ${fmtCost(m.costMicroUsd.candidate)} | ${fmtCost(m.costMicroUsd.delta)} | ℹ️ INFO |`,
    `| **Anti-Gaming Integrity** | ${m.violations.baselineCount} violations | ${m.violations.candidateCount} violations | - | ${m.violations.clean ? '✅ CLEAN' : '❌ VIOLATION'} |`
  ];

  if (!comparison.gatePassed && comparison.failureReasons?.length > 0) {
    lines.push('');
    lines.push('### 🚫 Blocking Failure Reasons:');
    for (const r of comparison.failureReasons) {
      lines.push(`- ⚠️ ${r}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*Automated by Kins Autonomous Agent Benchmark Engine v3.0 (Zero-Token CPU Verification)*');

  return lines.join('\n');
}
