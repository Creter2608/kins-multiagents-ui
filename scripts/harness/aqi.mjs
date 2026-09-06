/**
 * scripts/harness/aqi.mjs
 * Deterministic AQI v2.0 Architecture Quality Index & Compliance Engine.
 * Implements context-aware diff analysis, TypeScript AST inspection,
 * Tarjan SCC cycle detection, public contract verification, and anti-gaming rules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

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
 * Parses a unified git diff text into structured file records.
 *
 * @param {string} diffText
 * @returns {Array<object>}
 */
export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || !diffText.trim()) {
    return [];
  }

  const files = [];
  const rawSections = diffText.split(/^diff --git /m);

  for (const section of rawSections) {
    if (!section.trim()) continue;

    const lines = section.split('\n');
    const headerLine = lines[0] || '';
    const headerParts = headerLine.split(' ');
    const oldPathRaw = headerParts[0]?.replace(/^a\//, '') || '';
    const newPathRaw = headerParts[1]?.replace(/^b\//, '') || '';

    let oldPath = oldPathRaw;
    let newPath = newPathRaw;
    let isNew = false;
    let isDeleted = false;
    let isRename = false;
    let isBinary = false;

    let addedLinesCount = 0;
    let deletedLinesCount = 0;
    const addedLines = [];
    const addedLineNumbers = [];
    const hunks = [];
    let currentHunk = null;
    let currentNewLineNumber = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('new file mode')) {
        isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        isDeleted = true;
      } else if (line.startsWith('similarity index') || line.startsWith('rename from')) {
        isRename = true;
      } else if (line.startsWith('Binary files')) {
        isBinary = true;
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') isNew = true;
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') isDeleted = true;
        else newPath = p.replace(/^b\//, '');
      } else if (line.startsWith('@@ ')) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldLines = parseInt(hunkMatch[2] || '1', 10);
          const newStart = parseInt(hunkMatch[3], 10);
          const newLines = parseInt(hunkMatch[4] || '1', 10);

          currentHunk = { oldStart, oldLines, newStart, newLines };
          hunks.push(currentHunk);
          currentNewLineNumber = newStart;
        }
      } else if (currentHunk) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLinesCount++;
          addedLines.push(line.slice(1));
          addedLineNumbers.push(currentNewLineNumber);
          currentNewLineNumber++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletedLinesCount++;
        } else if (line.startsWith(' ')) {
          currentNewLineNumber++;
        }
      }
    }

    files.push({
      oldPath: isNew ? null : oldPath,
      newPath: isDeleted ? null : newPath,
      path: isDeleted ? oldPath : newPath,
      isNew,
      isDeleted,
      isRename,
      isBinary,
      addedLinesCount,
      deletedLinesCount,
      semanticChurn: addedLinesCount + deletedLinesCount,
      addedLines,
      addedLineNumbers,
      hunks
    });
  }

  return files;
}

/**
 * Deterministic Tarjan's Strongly Connected Components (SCC) algorithm.
 * Identifies dependency cycles in a directed graph.
 *
 * @param {Map<string, Set<string>>} graph
 * @returns {Array<string[]>} List of SCCs with size > 1
 */
export function findDependencyCycles(graph) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Map();
  const stack = [];
  const cycles = [];

  const nodes = Array.from(graph.keys()).sort();

  function strongConnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    const neighbors = Array.from(graph.get(v) || []).sort();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.get(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.set(w, false);
        component.push(w);
      } while (w !== v);

      if (component.length > 1) {
        cycles.push(component.sort());
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Checks if a comment string represents executable code rather than plain prose.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isExecutableCodeComment(text) {
  const clean = text.replace(/^\/\*+/, '').replace(/\*+\/$/, '').replace(/^\/\/+/, '').trim();
  if (!clean || clean.length < 3) return false;

  // Ignore typical documentation / URLs / TODOs
  if (/^(https?:\/\/|TODO|FIXME|NOTE|TIP|IMPORTANT|WARN|@param|@returns|@type)\b/i.test(clean)) {
    return false;
  }

  // Keywords that signal dead or commented-out code
  if (/^\s*(const|let|var|function|class|import|export|return|interface|type)\b/.test(clean)) {
    return true;
  }

  // Statements like: `a = b;` or `doSomething();` or `if (x) { ... }`
  if (/^\s*(if|for|while|switch|try|catch)\s*\(/.test(clean)) {
    return true;
  }
  if (/^[a-zA-Z0-9_$]+\s*=\s*[^;]+;?$/.test(clean)) {
    return true;
  }
  if (/^[a-zA-Z0-9_$.]+\s*\([^)]*\)\s*;?$/.test(clean)) {
    return true;
  }

  return false;
}

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

    const isTest = /(^|\/)(test|__tests__|tests)\/|\.test\.[a-z]+$/i.test(file.path);
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

      // Debugging prints check
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

      // Hard suppression markers: @ts-ignore, @ts-nocheck, 'as any'
      if (/@ts-(ignore|nocheck)\b/.test(trimmed) || /\bas\s+any\b/.test(trimmed)) {
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
      // Reconstruct after source from added lines if disk file is absent
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
      const declaredAliases = new Map(); // aliasName -> original
      let topLevelDeclarationsCount = 0;
      let fileSemanticLines = 0;

      function resolveLocalModule(specifier) {
        const dir = path.dirname(file.path).replace(/\\/g, '/');
        const rawResolved = path.posix.normalize(dir === '.' ? specifier.replace(/^\.\//, '') : `${dir}/${specifier}`);
        const baseResolved = rawResolved.replace(/\.[cm]?[jt]sx?$/, '');

        // Match against touched files
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

        // Track debug sink aliases: const emit = console.log, const { log } = console
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

        // Detect calls through tracked aliases: emit("x")
        if (ts.isCallExpression(node)) {
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

            if (!isReactComponent && (!hasReturnType || !hasParamTypes)) {
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
