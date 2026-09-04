import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const JUDGE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'judge.mjs')).href;

const {
  evaluateArchitecturalCompliance,
  buildJudgeEvaluationPrompt,
  DEFAULT_MIN_AQI
} = await import(JUDGE_URL) as typeof import('../scripts/harness/judge.d.mts');

test('judge: evaluateArchitecturalCompliance scores clean minimal surgical diffs highly', () => {
  const cleanDiff = `
diff --git a/src/utils.ts b/src/utils.ts
index 1234..5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,3 +10,3 @@
-export function compute(x: number): number {
-  return x * 2;
+export function compute(x: number, factor = 2): number {
+  return x * factor;
 }
`;

  const result = evaluateArchitecturalCompliance(cleanDiff);
  assert.strictEqual(result.passed, true);
  assert.ok(result.aqi >= 4.5, `AQI ${result.aqi} should be >= 4.5`);
  assert.strictEqual(result.criteriaScores.surgicalDiff, 5.0);
  assert.strictEqual(result.criteriaScores.maintainability, 5.0);
});

test('judge: evaluateArchitecturalCompliance detects debug statements, debugger, and dead code', () => {
  const dirtyDiff = `
diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -20,6 +20,10 @@
+    console.log("DEBUG: reaching point A", data);
+    debugger;
+    // const oldImplementation = computeOld();
+    return true;
`;

  const result = evaluateArchitecturalCompliance(dirtyDiff);
  assert.ok(result.criteriaScores.maintainability < 5.0, 'Maintainability should be penalized');
  assert.ok(result.criteriaScores.surgicalDiff < 5.0, 'Surgical diff should be penalized for commented-out code');
  assert.ok(result.feedback.some(f => f.includes('debug logging')));
  assert.ok(result.feedback.some(f => f.includes('Debugger statement')));
  assert.ok(result.feedback.some(f => f.includes('Commented-out code')));
});

test('judge: evaluateArchitecturalCompliance penalizes non-surgical footprint and speculative expansion', () => {
  // Generate a diff modifying 18 files with massive additions
  let wideDiff = '';
  for (let i = 1; i <= 18; i++) {
    wideDiff += `
diff --git a/file${i}.ts b/file${i}.ts
--- a/file${i}.ts
+++ b/file${i}.ts
@@ -1,1 +1,50 @@
${Array.from({ length: 50 }, (_, j) => `+const speculativeVar${j} = ${j};`).join('\n')}
`;
  }

  const result = evaluateArchitecturalCompliance(wideDiff, { minAqi: 4.0 });
  assert.strictEqual(result.passed, false);
  assert.ok(result.aqi < 4.0);
  assert.ok(result.feedback.some(f => f.includes('Large file footprint')));
  assert.ok(result.feedback.some(f => f.includes('speculative feature creep')));
});

test('judge: buildJudgeEvaluationPrompt formats structured Layer 1 rubric', () => {
  const prompt = buildJudgeEvaluationPrompt('diff --git a/foo.ts', {
    taskDescription: 'Fix auth session expiration'
  });

  assert.ok(prompt.includes('Layer 1 Architectural Judge'));
  assert.ok(prompt.includes('Surgical Changes'));
  assert.ok(prompt.includes('Simplicity First'));
  assert.ok(prompt.includes('Modularity & Clean Contracts'));
  assert.ok(prompt.includes('Maintainability'));
  assert.ok(prompt.includes('Fix auth session expiration'));
});
