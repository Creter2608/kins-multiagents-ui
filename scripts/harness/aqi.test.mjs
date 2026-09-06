import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiff,
  findDependencyCycles,
  isExecutableCodeComment,
  analyzeArchitectureChange,
  scoreArchitectureAnalysis,
  TASK_PROFILES,
  FINDING_CODES
} from './aqi.mjs';

test('aqi: Assertion 1 - aliased debug sink, stdout.write, and block-commented assignment penalize simplicity', () => {
  const diff = `
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,3 +10,8 @@
+/* const oldSecret = "deprecated"; */
+const emit = console.log;
+emit("DEBUG: testing alias");
+process.stdout.write("raw output");
+return true;
`;

  const analysis = analyzeArchitectureChange(diff, { taskType: 'fix' });
  const score = scoreArchitectureAnalysis(analysis);

  assert.ok(score.criteriaScores.simplicity < 5.0, `Simplicity score ${score.criteriaScores.simplicity} should be < 5.0`);
  assert.ok(score.criteriaScores.maintainability < 5.0, `Maintainability score ${score.criteriaScores.maintainability} should be < 5.0`);
  assert.ok(analysis.findings.some(f => f.code === FINDING_CODES.DEBUG_OUTPUT));
  assert.ok(analysis.findings.some(f => f.code === FINDING_CODES.COMMENTED_CODE));
});

test('aqi: Assertion 2 - newly introduced dependency cycle triggers Tarjan SCC and modularity floor failure', () => {
  const sourcePairs = new Map([
    ['src/moduleA.ts', {
      before: `export const a = 1;`,
      after: `import { b } from './moduleB.js';\nexport const a = b + 1;`
    }],
    ['src/moduleB.ts', {
      before: `export const b = 2;`,
      after: `import { a } from './moduleA.js';\nexport const b = a + 2;`
    }]
  ]);

  const diff = `
diff --git a/src/moduleA.ts b/src/moduleA.ts
--- a/src/moduleA.ts
+++ b/src/moduleA.ts
@@ -1,1 +1,2 @@
+import { b } from './moduleB.js';
+export const a = b + 1;
diff --git a/src/moduleB.ts b/src/moduleB.ts
--- a/src/moduleB.ts
+++ b/src/moduleB.ts
@@ -1,1 +1,2 @@
+import { a } from './moduleA.js';
+export const b = a + 2;
`;

  const analysis = analyzeArchitectureChange(diff, { taskType: 'feat', sourcePairs });
  const score = scoreArchitectureAnalysis(analysis);

  assert.ok(score.criteriaScores.modularity <= 3.0, `Modularity ${score.criteriaScores.modularity} should be <= 3.0`);
  assert.strictEqual(score.passed, false, 'Should fail modularity floor of feat profile (>= 3.5)');
  assert.ok(analysis.findings.some(f => f.code === FINDING_CODES.DEPENDENCY_CYCLE));
});

test('aqi: Assertion 3 - monotonic churn calculation prevents dummy deletion offset gaming', () => {
  // 801 additions + 21 dummy deletions
  const addedLines = Array.from({ length: 801 }, (_, i) => `+const v${i} = ${i};`).join('\n');
  const deletedLines = Array.from({ length: 21 }, (_, i) => `-const old${i} = ${i};`).join('\n');

  const diff = `
diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,21 +1,801 @@
${deletedLines}
${addedLines}
`;

  const files = parseUnifiedDiff(diff);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].addedLinesCount, 801);
  assert.strictEqual(files[0].deletedLinesCount, 21);
  assert.strictEqual(files[0].semanticChurn, 822);

  const analysis = analyzeArchitectureChange(diff, { taskType: 'fix' });
  const score = scoreArchitectureAnalysis(analysis);

  // High churn penalty must apply
  assert.ok(score.criteriaScores.surgicalDiff < 4.0, `Surgical diff ${score.criteriaScores.surgicalDiff} should be penalized`);
  assert.strictEqual(score.passed, false, '800+ lines churn in a fix must not pass fix gate');
});

test('aqi: Assertion 4 - clean typed feature across multiple acyclic modules passes feat profile', () => {
  let multiDiff = '';
  const sourcePairs = new Map();

  for (let i = 1; i <= 8; i++) {
    const filePath = `src/module${i}.ts`;
    const code = `
export function compute${i}(input: number): number {
  return input * ${i};
}
`;
    sourcePairs.set(filePath, { before: null, after: code });
    multiDiff += `
diff --git a/${filePath} b/${filePath}
new file mode 100644
--- /dev/null
+++ b/${filePath}
@@ -0,0 +1,5 @@
+export function compute${i}(input: number): number {
+  return input * ${i};
+}
`;
  }

  const analysis = analyzeArchitectureChange(multiDiff, { taskType: 'feat', sourcePairs });
  const score = scoreArchitectureAnalysis(analysis);

  assert.strictEqual(score.criteriaScores.modularity, 5.0, 'Clean acyclic modules should have modularity 5.0');
  assert.strictEqual(score.passed, true, `Clean feat should pass, AQI: ${score.aqi}`);
  assert.ok(score.aqi >= 4.0, `AQI ${score.aqi} should be >= 4.0`);
});

test('aqi: Assertion 5 - God-module concentration detected even when touched file count is small', () => {
  // 520 lines added into a single file with 5 top-level declarations
  const lines = Array.from({ length: 520 }, (_, i) => `export function handler${i % 5}(x: number): number { return x + ${i}; }`);
  const content = lines.join('\n');

  const diff = `
diff --git a/src/monolith.ts b/src/monolith.ts
--- a/src/monolith.ts
+++ b/src/monolith.ts
@@ -1,1 +1,520 @@
${lines.map(l => `+${l}`).join('\n')}
`;

  const sourcePairs = new Map([
    ['src/monolith.ts', { before: '', after: content }]
  ]);

  const analysis = analyzeArchitectureChange(diff, { taskType: 'feat', sourcePairs });
  assert.ok(analysis.findings.some(f => f.code === FINDING_CODES.GOD_MODULE));
  assert.ok(analysis.metrics.godModuleCandidates >= 1);
});

test('aqi: Greenfield/Bootstrap mode allows large initial scaffolding without churn penalty', () => {
  // Brand new project initialization: 2,500 lines across 20 files
  let scaffoldDiff = '';
  for (let i = 1; i <= 20; i++) {
    scaffoldDiff += `
diff --git a/src/scaffold${i}.ts b/src/scaffold${i}.ts
new file mode 100644
--- /dev/null
+++ b/src/scaffold${i}.ts
@@ -0,0 +1,125 @@
${Array.from({ length: 125 }, (_, j) => `+export function util${i}_${j}(x: number): number { return x + ${j}; }`).join('\n')}
`;
  }

  const analysis = analyzeArchitectureChange(scaffoldDiff, { taskType: 'bootstrap' });
  const score = scoreArchitectureAnalysis(analysis);

  assert.strictEqual(score.passed, true, 'Bootstrap mode must pass clean large scaffolding');
  assert.strictEqual(score.criteriaScores.surgicalDiff, 5.0, 'Bootstrap mode should not penalize surgical diff churn');
  assert.ok(score.aqi >= 4.0);
});
