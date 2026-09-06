/**
 * scripts/harness/judge.mjs
 * Layer 1 Architectural Compliance & LLM-as-a-Judge Engine.
 * Evaluates patch diffs against Karpathy simplicity invariants and SWE-bench best practices:
 * Minimal Surgical Diff, Simplicity First, Modularity & Contracts, and Maintainability.
 * Computes the composite Architecture Quality Index (AQI 1.0 - 5.0) via deterministic AQI v2.0 engine.
 */

import {
  analyzeArchitectureChange,
  scoreArchitectureAnalysis,
  TASK_PROFILES,
  FINDING_CODES
} from './aqi.mjs';

export const DEFAULT_MIN_AQI = 3.5;
export { TASK_PROFILES, FINDING_CODES };

/**
 * Evaluates architectural quality and surgical diff compliance of a git patch.
 *
 * @param {string} diffText Raw git diff unified output
 * @param {object} [options={}]
 * @returns {{ aqi: number, passed: boolean, criteriaScores: { surgicalDiff: number, simplicity: number, modularity: number, maintainability: number }, feedback: string[], taskType?: string, findings?: object[], hardFailures?: string[], metrics?: object }}
 */
export function evaluateArchitecturalCompliance(diffText, options = {}) {
  const minAqi = typeof options.minAqi === 'number' ? options.minAqi : DEFAULT_MIN_AQI;
  const taskType = options.taskType || 'fix';
  const repoRoot = options.repoRoot || process.cwd();

  const analysis = analyzeArchitectureChange(diffText, {
    taskType,
    repoRoot,
    sourcePairs: options.sourcePairs
  });

  const score = scoreArchitectureAnalysis(analysis, { minAqi });

  return {
    aqi: score.aqi,
    passed: score.passed,
    criteriaScores: score.criteriaScores,
    feedback: score.feedback,
    taskType: score.taskType,
    threshold: score.threshold,
    findings: score.findings,
    hardFailures: score.hardFailures,
    metrics: score.metrics
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
