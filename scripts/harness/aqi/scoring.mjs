/**
 * scripts/harness/aqi/scoring.mjs
 * AQI task profiles, finding codes, and composite score calculation.
 */

export const TASK_PROFILES = Object.freeze({
  fix: Object.freeze({
    id: 'fix',
    fileBudget: 4,
    churnBudget: 120,
    hunkBudget: 8,
    minAqi: 3.8,
    floors: Object.freeze({ surgicalDiff: 3.5 })
  }),
  feat: Object.freeze({
    id: 'feat',
    fileBudget: 12,
    churnBudget: 500,
    hunkBudget: 30,
    minAqi: 3.5,
    floors: Object.freeze({ modularity: 3.5 })
  }),
  refactor: Object.freeze({
    id: 'refactor',
    fileBudget: 20,
    churnBudget: 800,
    hunkBudget: 50,
    minAqi: 3.7,
    floors: Object.freeze({ modularity: 3.5, maintainability: 3.5 })
  }),
  bootstrap: Object.freeze({
    id: 'bootstrap',
    fileBudget: 50,
    churnBudget: 3500,
    hunkBudget: 150,
    minAqi: 3.5,
    floors: Object.freeze({ modularity: 3.5 })
  })
});

export const FINDING_CODES = Object.freeze({
  DEBUG_OUTPUT: 'DEBUG_OUTPUT',
  DEBUGGER_STATEMENT: 'DEBUGGER_STATEMENT',
  COMMENTED_CODE: 'COMMENTED_CODE',
  HIGH_COMPLEXITY: 'HIGH_COMPLEXITY',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  WEAK_PUBLIC_CONTRACT: 'WEAK_PUBLIC_CONTRACT',
  TIGHT_COUPLING: 'TIGHT_COUPLING',
  DEEP_INTERNAL_IMPORT: 'DEEP_INTERNAL_IMPORT',
  GOD_MODULE: 'GOD_MODULE',
  UNSAFE_SUPPRESSION: 'UNSAFE_SUPPRESSION',
  EXPLICIT_ANY: 'EXPLICIT_ANY',
  LARGE_FOOTPRINT: 'LARGE_FOOTPRINT',
  SPECULATIVE_EXPANSION: 'SPECULATIVE_EXPANSION',
  PLACEHOLDER_MARKER: 'PLACEHOLDER_MARKER'
});

/**
 * Computes AQI composite scores, category deductions, and pass/fail verdict.
 *
 * @param {object} analysis ArchitectureAnalysis from analyzeArchitectureChange
 * @param {object} [options={}]
 * @returns {object} ArchitectureScore
 */
export function scoreArchitectureAnalysis(analysis, options = {}) {
  const profile = TASK_PROFILES[analysis.taskType] || TASK_PROFILES.fix;
  const minAqi = typeof options.minAqi === 'number' ? options.minAqi : profile.minAqi;

  let surgicalDiff = 5.0;
  let simplicity = 5.0;
  let modularity = 5.0;
  let maintainability = 5.0;
  const feedback = [];

  // Empty diff check
  if (analysis.files.length === 0) {
    return {
      aqi: 5.0,
      passed: true,
      taskType: analysis.taskType,
      threshold: minAqi,
      criteriaScores: { surgicalDiff: 5.0, simplicity: 5.0, modularity: 5.0, maintainability: 5.0 },
      hardFailures: [],
      findings: [],
      metrics: analysis.metrics,
      feedback: ['Empty diff, no modifications evaluated.']
    };
  }

  // 1. Surgical Diff Churn & Footprint Deductions
  // In bootstrap/init mode, file footprint and additions are exempt from churn penalties
  if (analysis.taskType !== 'bootstrap') {
    if (analysis.touchedFilesCount > profile.fileBudget) {
      const overFiles = (analysis.touchedFilesCount - profile.fileBudget) / profile.fileBudget;
      const penalty = Math.min(2.0, Math.round(overFiles * 1.5 * 10) / 10);
      surgicalDiff -= penalty;
      feedback.push(`Large file footprint: ${analysis.touchedFilesCount} files modified in a single patch.`);
    }

    if (analysis.metrics.semanticChurn > profile.churnBudget) {
      const overChurn = (analysis.metrics.semanticChurn - profile.churnBudget) / profile.churnBudget;
      const penalty = Math.min(2.0, Math.round(overChurn * 1.5 * 10) / 10);
      surgicalDiff -= penalty;
      feedback.push(`High churn: ${analysis.metrics.semanticChurn} total line changes exceed budget ${profile.churnBudget}.`);
    }

    // Retain legacy feature creep rule for backward compatibility
    if (analysis.metrics.addedLinesCount > 800 && analysis.metrics.deletedLinesCount < 20) {
      simplicity -= 2.0;
      feedback.push(`Potential speculative feature creep: +${analysis.metrics.addedLinesCount} lines added vs -${analysis.metrics.deletedLinesCount} deleted.`);
    }
  }

  // 2. Apply findings by category
  for (const finding of analysis.findings) {
    if (finding.category === 'surgicalDiff') {
      surgicalDiff -= finding.penalty;
    } else if (finding.category === 'simplicity') {
      simplicity -= finding.penalty;
    } else if (finding.category === 'modularity') {
      modularity -= finding.penalty;
    } else if (finding.category === 'maintainability') {
      maintainability -= finding.penalty;
    }
    feedback.push(finding.evidence);
  }

  // 3. Clamp scores to [1.0, 5.0]
  surgicalDiff = Math.max(1.0, Math.min(5.0, Math.round(surgicalDiff * 10) / 10));
  simplicity = Math.max(1.0, Math.min(5.0, Math.round(simplicity * 10) / 10));
  modularity = Math.max(1.0, Math.min(5.0, Math.round(modularity * 10) / 10));
  maintainability = Math.max(1.0, Math.min(5.0, Math.round(maintainability * 10) / 10));

  // 4. Weighted Composite AQI (30% Surgical, 30% Simplicity, 20% Modularity, 20% Maintainability)
  const composite = (surgicalDiff * 0.3) + (simplicity * 0.3) + (modularity * 0.2) + (maintainability * 0.2);
  const aqi = Math.round(composite * 100) / 100;

  // 5. Evaluate Floors & Hard Failures
  let passed = aqi >= minAqi && analysis.hardFailures.length === 0;

  if (profile.floors) {
    if (profile.floors.surgicalDiff && surgicalDiff < profile.floors.surgicalDiff) {
      passed = false;
      feedback.push(`Surgical diff score ${surgicalDiff} falls below category floor ${profile.floors.surgicalDiff}`);
    }
    if (profile.floors.modularity && modularity < profile.floors.modularity) {
      passed = false;
      feedback.push(`Modularity score ${modularity} falls below category floor ${profile.floors.modularity}`);
    }
    if (profile.floors.maintainability && maintainability < profile.floors.maintainability) {
      passed = false;
      feedback.push(`Maintainability score ${maintainability} falls below category floor ${profile.floors.maintainability}`);
    }
  }

  if (analysis.hardFailures.length > 0) {
    passed = false;
    for (const hf of analysis.hardFailures) {
      feedback.push(`HARD FAILURE: ${hf}`);
    }
  }

  if (!passed && aqi < minAqi) {
    feedback.push(`AQI score ${aqi} falls below required quality gate ${minAqi}`);
  }

  return {
    aqi,
    passed,
    taskType: analysis.taskType,
    threshold: minAqi,
    criteriaScores: {
      surgicalDiff,
      simplicity,
      modularity,
      maintainability
    },
    hardFailures: analysis.hardFailures,
    findings: analysis.findings,
    metrics: analysis.metrics,
    feedback
  };
}
