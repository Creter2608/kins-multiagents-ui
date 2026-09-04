/**
 * scripts/harness/judge.mjs
 * Layer 1 Architectural Compliance & LLM-as-a-Judge Engine.
 * Evaluates patch diffs against Karpathy simplicity invariants and SWE-bench best practices:
 * Minimal Surgical Diff, Simplicity First, Modularity & Contracts, and Maintainability.
 * Computes the composite Architecture Quality Index (AQI 1.0 - 5.0).
 */

export const DEFAULT_MIN_AQI = 3.5;

/**
 * Evaluates architectural quality and surgical diff compliance of a git patch.
 *
 * @param {string} diffText Raw git diff unified output
 * @param {object} [options={}]
 * @returns {{ aqi: number, passed: boolean, criteriaScores: { surgicalDiff: number, simplicity: number, modularity: number, maintainability: number }, feedback: string[] }}
 */
export function evaluateArchitecturalCompliance(diffText, options = {}) {
  const minAqi = typeof options.minAqi === 'number' ? options.minAqi : DEFAULT_MIN_AQI;

  if (typeof diffText !== 'string' || !diffText.trim()) {
    return {
      aqi: 5.0,
      passed: true,
      criteriaScores: {
        surgicalDiff: 5.0,
        simplicity: 5.0,
        modularity: 5.0,
        maintainability: 5.0
      },
      feedback: ['Empty diff, no modifications evaluated.']
    };
  }

  const feedback = [];
  let surgicalDiff = 5.0;
  let simplicity = 5.0;
  let modularity = 5.0;
  let maintainability = 5.0;

  const lines = diffText.split('\n');
  let addedLinesCount = 0;
  let deletedLinesCount = 0;
  const touchedFiles = new Set();

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const parts = line.split(' ');
      if (parts[2]) {
        touchedFiles.add(parts[2].replace(/^a\//, ''));
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLinesCount++;
      const trimmed = line.slice(1).trim();

      // Detect leftover debugging prints
      if (/\bconsole\.(log|debug|info)\(/.test(trimmed)) {
        maintainability -= 0.5;
        feedback.push(`Suspicious debug logging added: "${trimmed.slice(0, 60)}"`);
      }

      // Detect debugger statements
      if (/^\s*debugger;?$/.test(trimmed)) {
        maintainability -= 1.0;
        feedback.push('Debugger statement detected in patch');
      }

      // Detect commented-out code blocks
      if (/^\s*\/\/\s*(const|let|var|function|class|import|export)\b/.test(trimmed)) {
        surgicalDiff -= 0.5;
        feedback.push(`Commented-out code detected: "${trimmed.slice(0, 60)}"`);
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletedLinesCount++;
    }
  }

  // File breadth penalty if too many files touched for a surgical fix
  if (touchedFiles.size > 15) {
    surgicalDiff -= 2.0;
    feedback.push(`Large file footprint: ${touchedFiles.size} files modified in a single patch.`);
  }

  // Ratio check: speculative expansion penalty if disproportionate additions
  if (addedLinesCount > 800 && deletedLinesCount < 20) {
    simplicity -= 2.0;
    feedback.push(`Potential speculative feature creep: +${addedLinesCount} lines added vs -${deletedLinesCount} deleted.`);
  }

  // Clamp criteria scores between 1.0 and 5.0
  surgicalDiff = Math.max(1.0, Math.min(5.0, Math.round(surgicalDiff * 10) / 10));
  simplicity = Math.max(1.0, Math.min(5.0, Math.round(simplicity * 10) / 10));
  modularity = Math.max(1.0, Math.min(5.0, Math.round(modularity * 10) / 10));
  maintainability = Math.max(1.0, Math.min(5.0, Math.round(maintainability * 10) / 10));

  // Weighted composite AQI calculation:
  // Surgical Diff: 30%, Simplicity: 30%, Modularity: 20%, Maintainability: 20%
  const compositeAqi = (surgicalDiff * 0.3) + (simplicity * 0.3) + (modularity * 0.2) + (maintainability * 0.2);
  const aqi = Math.round(compositeAqi * 100) / 100;

  const passed = aqi >= minAqi;
  if (!passed) {
    feedback.push(`AQI score ${aqi} falls below required quality gate ${minAqi}`);
  }

  return {
    aqi,
    passed,
    criteriaScores: {
      surgicalDiff,
      simplicity,
      modularity,
      maintainability
    },
    feedback
  };
}

/**
 * Builds a structured evaluation prompt for Layer 1 LLM-as-a-Judge when offline heuristic is complemented by an external model.
 *
 * @param {string} diffText
 * @param {object} [context={}]
 * @returns {string}
 */
export function buildJudgeEvaluationPrompt(diffText, context = {}) {
  const taskDesc = context.taskDescription || 'Candidate patch resolution';
  return `
You are the Layer 1 Architectural Judge for Autonomous Coding Agents.
Evaluate the following git diff against our core engineering invariants:
1. Surgical Changes (1-5): Touches only what it must. Zero unrelated reformatting.
2. Simplicity First (1-5): Minimum code that solves the problem. No speculative abstractions.
3. Modularity & Clean Contracts (1-5): Clear boundaries, typed contracts.
4. Maintainability (1-5): Clean naming, no leftover debug code or commented-out debris.

Task Description: ${taskDesc}

\`\`\`diff
${diffText}
\`\`\`

Return a JSON object:
{
  "aqi": 4.5,
  "criteriaScores": { "surgicalDiff": 5, "simplicity": 4, "modularity": 5, "maintainability": 4 },
  "verdict": "ACCEPT" | "REJECT",
  "rationale": "Explanation"
}
`.trim();
}
