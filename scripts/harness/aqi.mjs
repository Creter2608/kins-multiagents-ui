/**
 * scripts/harness/aqi.mjs
 * Deterministic AQI v2.0 Architecture Quality Index & Compliance Engine.
 * Public orchestration façade re-exporting modular submodules:
 * - diff-parser: unified diff parsing & monotonic churn
 * - cycle-detector: Tarjan SCC dependency cycle detection
 * - contract-rules: AST public contract validation & suppression filters
 * - scoring: task profiles, finding codes, and AQI composite scoring
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { parseUnifiedDiff } from './aqi/diff-parser.mjs';
import { findDependencyCycles } from './aqi/cycle-detector.mjs';
import {
  isTestFilePath,
  isExecutableCodeComment,
  evaluateUnsafeSuppression,
  getCompanionDeclarations,
  hasTypedJsDoc
} from './aqi/contract-rules.mjs';
import {
  TASK_PROFILES,
  FINDING_CODES,
  scoreArchitectureAnalysis
} from './aqi/scoring.mjs';

// Public API Re-exports for 100% backward compatibility
export {
  parseUnifiedDiff,
  findDependencyCycles,
  isExecutableCodeComment,
  TASK_PROFILES,
  FINDING_CODES,
  scoreArchitectureAnalysis
};

/**
 * Performs AST and semantic analysis on parsed diff and source files.
 *
 * @param {string} diffText
 * @param {object} [options={}]
 * @returns {object} ArchitectureAnalysis
 */
export function analyzeArchitectureChange(diffText, options = {}) {
  const taskType = options.taskType && TASK_PROFILES[options.taskType] ? options.taskType : 'fix';
  const repoRoot = options.repoRoot || process.cwd();
  const sourcePairs = options.sourcePairs || new Map();

  const parsedFiles = parseUnifiedDiff(diffText);
  const findings = [];
  const hardFailures = [];

  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalSemanticChurn = 0;
  const touchedFilePaths = new Set();

  const afterGraph = new Map();
  const beforeGraph = new Map();

  // Metrics map
  const metrics = {
    productionFiles: 0,
    testFiles: 0,
    docFiles: 0,
    hunksCount: 0,
    addedLinesCount: 0,
    deletedLinesCount: 0,
    semanticChurn: 0,
    debugCallsCount: 0,
    debuggerCount: 0,
    commentedCodeCount: 0,
    untypedExportsCount: 0,
    newCyclesCount: 0,
    godModuleCandidates: 0
  };

  // Pre-populate all touched and known file paths
  for (const file of parsedFiles) {
    if (file.path) touchedFilePaths.add(file.path);
  }
  for (const key of sourcePairs.keys()) {
    touchedFilePaths.add(key);
  }

  // 1. Process unified diff file churn
  for (const file of parsedFiles) {
    if (!file.path) continue;

    const isTest = isTestFilePath(file.path);
    const isDoc = /\.(md|txt|rst|adoc)$/i.test(file.path);

    if (isTest) metrics.testFiles++;
    else if (isDoc) metrics.docFiles++;
    else metrics.productionFiles++;

    metrics.hunksCount += file.hunks.length;
    metrics.addedLinesCount += file.addedLinesCount;
    metrics.deletedLinesCount += file.deletedLinesCount;
    metrics.semanticChurn += file.semanticChurn;
    totalAdditions += file.addedLinesCount;
    totalDeletions += file.deletedLinesCount;
    totalSemanticChurn += file.semanticChurn;

    // Scan raw added lines for fast regex patterns (fallbacks & diff-level warnings)
    for (let idx = 0; idx < file.addedLines.length; idx++) {
      const rawLine = file.addedLines[idx];
      const trimmed = rawLine.trim();
      const lineNum = file.addedLineNumbers[idx] || null;

      // Debugging prints check - strictly scoped to production files
      if (!isTest) {
        if (/\bconsole\.(log|debug|info|warn)\(/.test(trimmed) ||
            /\bprocess\.(stdout|stderr)\.write\(/.test(trimmed) ||
            /\bconsole\[["'](log|debug|info|warn)["']\]\(/.test(trimmed)) {
          metrics.debugCallsCount++;
          findings.push({
            code: FINDING_CODES.DEBUG_OUTPUT,
            category: 'maintainability',
            severity: 'warning',
            file: file.path,
            line: lineNum,
            evidence: `Suspicious debug logging added: "${trimmed.slice(0, 60)}"`,
            penalty: 0.5
          });
        }
      }

      // Debugger check
      if (/^\s*debugger;?$/.test(trimmed)) {
        metrics.debuggerCount++;
        hardFailures.push(`Debugger statement detected in patch at ${file.path}:${lineNum}`);
        findings.push({
          code: FINDING_CODES.DEBUGGER_STATEMENT,
          category: 'maintainability',
          severity: 'error',
          file: file.path,
          line: lineNum,
          evidence: 'Debugger statement detected in patch',
          penalty: 2.0
        });
      }

      // Commented-out code check (line comments)
      if (/^\s*\/\//.test(trimmed) && isExecutableCodeComment(trimmed)) {
        metrics.commentedCodeCount++;
        findings.push({
          code: FINDING_CODES.COMMENTED_CODE,
          category: 'surgicalDiff',
          severity: 'warning',
          file: file.path,
          line: lineNum,
          evidence: `Commented-out code detected: "${trimmed.slice(0, 60)}"`,
          penalty: 0.5
        });
      }

      // Actionable type suppression directives (strictly scoped to production files)
      if (!isTest) {
        const suppression = evaluateUnsafeSuppression(trimmed);
        if (suppression.isSuppression) {
          hardFailures.push(`Unsafe type suppression detected: "${trimmed.slice(0, 60)}" at ${file.path}:${lineNum}`);
          findings.push({
            code: FINDING_CODES.UNSAFE_SUPPRESSION,
            category: 'maintainability',
            severity: 'error',
            file: file.path,
            line: lineNum,
            evidence: `Unsafe type suppression: "${trimmed.slice(0, 60)}"`,
            penalty: 1.5
          });
        }
      }
    }

    // 2. Before / After AST Analysis for JS/TS files
    const isJsTs = /\.[cm]?[jt]sx?$/i.test(file.path);
    if (!isJsTs || file.isBinary || file.isDeleted) continue;

    let afterSource = null;
    let beforeSource = null;

    if (sourcePairs.has(file.path)) {
      const pair = sourcePairs.get(file.path);
      afterSource = pair.after;
      beforeSource = pair.before;
    } else {
      const fullDiskPath = path.resolve(repoRoot, file.path);
      if (fs.existsSync(fullDiskPath)) {
        try {
          afterSource = fs.readFileSync(fullDiskPath, 'utf8');
        } catch {
          afterSource = file.addedLines.join('\n');
        }
      } else {
        afterSource = file.addedLines.join('\n');
      }
    }

    if (typeof afterSource === 'string' && afterSource.trim()) {
      const scriptKind = file.path.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : file.path.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : file.path.endsWith('.js') || file.path.endsWith('.mjs') || file.path.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

      const sourceFile = ts.createSourceFile(
        file.path,
        afterSource,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );

      // AST Walker
      const localImports = new Set();
      const declaredAliases = new Map();
      let topLevelDeclarationsCount = 0;
      let fileSemanticLines = 0;

      function resolveLocalModule(specifier) {
        const dir = path.dirname(file.path).replace(/\\/g, '/');
        const rawResolved = path.posix.normalize(dir === '.' ? specifier.replace(/^\.\//, '') : `${dir}/${specifier}`);
        const baseResolved = rawResolved.replace(/\.[cm]?[jt]sx?$/, '');

        for (const touched of touchedFilePaths) {
          const touchedBase = touched.replace(/\.[cm]?[jt]sx?$/, '');
          if (touched === rawResolved || touchedBase === baseResolved) {
            return touched;
          }
        }
        return baseResolved;
      }

      function visit(node) {
        // Track local imports
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          if (spec.startsWith('.')) {
            localImports.add(resolveLocalModule(spec));
          }
        }

        // Track debug sink aliases: const emit = console.log
        if (ts.isVariableDeclaration(node) && node.name && node.initializer) {
          if (ts.isIdentifier(node.name)) {
            const varName = node.name.text;
            if (ts.isPropertyAccessExpression(node.initializer)) {
              const exprText = node.initializer.expression.getText(sourceFile);
              const propText = node.initializer.name.getText(sourceFile);
              if (exprText === 'console') {
                declaredAliases.set(varName, `console.${propText}`);
              }
            }
          } else if (ts.isObjectBindingPattern(node.name) && node.initializer.getText(sourceFile) === 'console') {
            for (const elem of node.name.elements) {
              const propName = elem.propertyName ? elem.propertyName.getText(sourceFile) : elem.name.getText(sourceFile);
              const aliasName = elem.name.getText(sourceFile);
              declaredAliases.set(aliasName, `console.${propName}`);
            }
          }
        }

        // Detect calls through tracked aliases in production files
        if (!isTest && ts.isCallExpression(node)) {
          const callExpr = node.expression.getText(sourceFile);
          if (declaredAliases.has(callExpr)) {
            metrics.debugCallsCount++;
            findings.push({
              code: FINDING_CODES.DEBUG_OUTPUT,
              category: 'maintainability',
              severity: 'warning',
              file: file.path,
              line: null,
              evidence: `Suspicious call through debug alias '${callExpr}' -> ${declaredAliases.get(callExpr)}`,
              penalty: 0.5
            });
          }
        }

        // Export contracts: exported function or method without explicit return/param types
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.modifiers) {
          const isExported = node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
          if (isExported && node.name) {
            const funcName = node.name.text;
            const isReactComponent = /^[A-Z]/.test(funcName);
            const hasReturnType = Boolean(node.type);
            const hasParamTypes = node.parameters.every(p => Boolean(p.type));

            // Check if JavaScript export is covered by companion declaration or typed JSDoc
            const isPlainJs = /\.[cm]?jsx?$/i.test(file.path) && !/\.tsx?$/i.test(file.path);
            let isSatisfiedContract = hasReturnType && hasParamTypes;

            if (!isSatisfiedContract && isPlainJs) {
              const companion = getCompanionDeclarations(repoRoot, file.path);
              if (companion && companion.has(funcName)) {
                isSatisfiedContract = true;
              } else if (hasTypedJsDoc(node, sourceFile)) {
                isSatisfiedContract = true;
              }
            }

            if (!isReactComponent && !isSatisfiedContract) {
              metrics.untypedExportsCount++;
              findings.push({
                code: FINDING_CODES.WEAK_PUBLIC_CONTRACT,
                category: 'modularity',
                severity: 'warning',
                file: file.path,
                line: null,
                evidence: `Exported function '${funcName}' lacks explicit parameter or return type annotations`,
                penalty: 0.35
              });
            }
          }
        }

        // Top level count
        if (node.parent === sourceFile && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node))) {
          topLevelDeclarationsCount++;
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);

      // Block comments scan on AST
      const fullText = sourceFile.getFullText();
      const commentRanges = ts.getLeadingCommentRanges(fullText, 0) || [];
      for (const range of commentRanges) {
        if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
          const commentContent = fullText.slice(range.pos, range.end);
          if (isExecutableCodeComment(commentContent)) {
            metrics.commentedCodeCount++;
            findings.push({
              code: FINDING_CODES.COMMENTED_CODE,
              category: 'simplicity',
              severity: 'warning',
              file: file.path,
              line: null,
              evidence: `Commented-out block code detected: "${commentContent.replace(/\s+/g, ' ').slice(0, 60)}"`,
              penalty: 0.5
            });
          }
        }
      }

      // God Module Candidate Detection
      fileSemanticLines = afterSource.split('\n').filter(l => l.trim().length > 0).length;
      const isCandidateGodModule =
        (fileSemanticLines > 500 && (file.addedLinesCount / Math.max(1, totalAdditions)) >= 0.65 && topLevelDeclarationsCount >= 4) ||
        (fileSemanticLines > 600 && topLevelDeclarationsCount >= 20);

      if (isCandidateGodModule) {
        metrics.godModuleCandidates++;
        findings.push({
          code: FINDING_CODES.GOD_MODULE,
          category: 'modularity',
          severity: 'warning',
          file: file.path,
          line: null,
          evidence: `God-module candidate: ${file.path} contains ${fileSemanticLines} lines and concentrates excessive responsibilities.`,
          penalty: 1.5
        });
      }

      afterGraph.set(file.path, localImports);
    }
  }

  // 3. Cycle Detection via Tarjan's SCC
  const afterCycles = findDependencyCycles(afterGraph);
  const beforeCycles = findDependencyCycles(beforeGraph);
  const beforeCycleKeys = new Set(beforeCycles.map(c => c.join('->')));

  for (const cycle of afterCycles) {
    const cycleKey = cycle.join('->');
    if (!beforeCycleKeys.has(cycleKey)) {
      metrics.newCyclesCount++;
      findings.push({
        code: FINDING_CODES.DEPENDENCY_CYCLE,
        category: 'modularity',
        severity: 'error',
        file: cycle[0],
        line: null,
        evidence: `Newly introduced dependency cycle detected: ${cycle.join(' -> ')} -> ${cycle[0]}`,
        penalty: 2.0
      });
    }
  }

  return {
    taskType,
    files: parsedFiles,
    touchedFilesCount: touchedFilePaths.size,
    metrics,
    findings,
    hardFailures,
    coverage: {
      eligibleFiles: touchedFilePaths.size,
      parsedFiles: afterGraph.size
    }
  };
}
