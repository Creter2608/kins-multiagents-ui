/**
 * scripts/harness/aqi/contract-rules.mjs
 * AST contract verification, companion declaration mapping,
 * directive suppression recognition, and test file classification.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const companionExportsCache = new Map();

/**
 * Classifies whether a relative or absolute path represents a test file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTestFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  return /(^|\/)(test|__tests__|tests)\/|\.(test|spec)\.[a-z0-9]+$/i.test(normalized);
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
 * Determines whether a line contains an actionable unsafe type suppression directive.
 * Differentiates genuine directive comments (// @ts-ignore) from descriptive prose comments
 * (// Hard suppression markers: @ts-ignore) or string literals.
 *
 * @param {string} trimmedLine
 * @returns {{ isSuppression: boolean, reason?: string }}
 */
export function evaluateUnsafeSuppression(trimmedLine) {
  // Strip any leading diff marker '+' or '-' if present (e.g. in test fixture strings)
  const line = trimmedLine.replace(/^[+-]\s*/, '').trim();

  // 1. Directive comments: must begin with // followed optionally by whitespace and @ts-(ignore|nocheck)
  const isDirectiveComment = /^\/\/\s*@ts-(?:ignore|nocheck)\b/.test(line);
  if (isDirectiveComment) {
    return { isSuppression: true, reason: 'directive_comment' };
  }

  // 2. Unsafe 'as any' cast in non-comment, non-quoted code
  const isLineComment = /^\/\//.test(line);
  const isInsideQuotes = /(['"`])[^'"`]*\bas\s+any\b[^'"`]*\1/.test(line);
  if (!isLineComment && !isInsideQuotes && /\bas\s+any\b/.test(line)) {
    return { isSuppression: true, reason: 'as_any_cast' };
  }

  return { isSuppression: false };
}

/**
 * Resolves companion declaration exports for JavaScript / ESM files (.mjs -> .d.mts, .js -> .d.ts).
 *
 * @param {string} repoRoot
 * @param {string} filePath
 * @returns {Set<string>|null} Set of typed exported names, or null if no companion declaration exists.
 */
export function getCompanionDeclarations(repoRoot, filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');

  let dtsRelative = null;
  if (normalized.endsWith('.mjs')) {
    dtsRelative = normalized.replace(/\.mjs$/, '.d.mts');
  } else if (normalized.endsWith('.js')) {
    dtsRelative = normalized.replace(/\.js$/, '.d.ts');
  } else if (normalized.endsWith('.cjs')) {
    dtsRelative = normalized.replace(/\.cjs$/, '.d.cts');
  }

  if (!dtsRelative) return null;

  const cacheKey = `${repoRoot}:${dtsRelative}`;
  if (companionExportsCache.has(cacheKey)) {
    return companionExportsCache.get(cacheKey);
  }

  const fullDtsPath = path.resolve(repoRoot, dtsRelative);
  if (!fs.existsSync(fullDtsPath)) {
    companionExportsCache.set(cacheKey, null);
    return null;
  }

  try {
    const dtsContent = fs.readFileSync(fullDtsPath, 'utf8');
    const dtsSource = ts.createSourceFile(
      dtsRelative,
      dtsContent,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const typedExports = new Set();

    function visitDts(node) {
      const isExported = node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

      if (isExported) {
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
          typedExports.add(node.name.text);
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (decl.name && ts.isIdentifier(decl.name)) {
              typedExports.add(decl.name.text);
            }
          }
        } else if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
          typedExports.add(node.name.text);
        }
      }

      ts.forEachChild(node, visitDts);
    }

    visitDts(dtsSource);
    companionExportsCache.set(cacheKey, typedExports);
    return typedExports;
  } catch {
    companionExportsCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Checks whether an exported function has complete typed JSDoc comments.
 *
 * @param {import('typescript').Node} node
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {boolean}
 */
export function hasTypedJsDoc(node, sourceFile) {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || [];
  for (const range of ranges) {
    if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const comment = fullText.slice(range.pos, range.end);
      if (/@param\s*\{[^}]+\}/.test(comment) || /@returns?\s*\{[^}]+\}/.test(comment)) {
        return true;
      }
    }
  }
  return false;
}
