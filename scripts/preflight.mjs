#!/usr/bin/env node
/**
 * scripts/preflight.mjs
 * Fast-path pre-flight syntax and AST sanity checker (<300ms warm p95).
 * Parses changed .ts / .tsx files using TypeScript compiler API without running full semantic typecheck.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Discovers modified and untracked TypeScript files in the git workspace.
 * @param {string} cwd
 * @returns {string[]}
 */
export function getChangedTsFiles(cwd = REPO_ROOT) {
  const files = new Set();
  try {
    // 1. Modified or staged files vs HEAD
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const line of diffOutput.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && (trimmed.endsWith('.ts') || trimmed.endsWith('.tsx'))) {
        files.add(trimmed);
      }
    }
  } catch {
    // Fallback: diff without HEAD (e.g. initial repo state)
    try {
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      for (const line of statusOutput.split('\n')) {
        const filePart = line.slice(3).trim();
        if (filePart && (filePart.endsWith('.ts') || filePart.endsWith('.tsx'))) {
          files.add(filePart);
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Untracked files
  try {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const line of untracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && (trimmed.endsWith('.ts') || trimmed.endsWith('.tsx'))) {
        files.add(trimmed);
      }
    }
  } catch {
    // ignore
  }

  return Array.from(files).map((f) => path.resolve(cwd, f));
}

/**
 * Checks a list of files for syntax and AST errors.
 * @param {string[]} filePaths
 * @returns {{ passed: boolean; checkedCount: number; errors: Array<{ file: string; line: number; col: number; message: string }> }}
 */
export function checkSyntaxDiagnostics(filePaths) {
  const errors = [];
  let checkedCount = 0;

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    checkedCount++;
    const content = fs.readFileSync(filePath, 'utf-8');

    // Create AST without binding or semantic type checking
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false
    );

    // Collect syntactic parse diagnostics
    const diagnostics = sourceFile.parseDiagnostics || [];
    for (const diag of diagnostics) {
      let line = 1;
      let col = 1;
      if (diag.start !== undefined && sourceFile) {
        const pos = sourceFile.getLineAndCharacterOfPosition(diag.start);
        line = pos.line + 1;
        col = pos.character + 1;
      }
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      errors.push({
        file: path.relative(REPO_ROOT, filePath),
        line,
        col,
        message
      });
    }
  }

  return {
    passed: errors.length === 0,
    checkedCount,
    errors
  };
}

/**
 * Runs a performance benchmark over N iterations.
 * @param {string[]} filePaths
 * @param {number} iterations
 * @returns {{ minMs: number; maxMs: number; avgMs: number; p95Ms: number }}
 */
export function benchmarkPreflight(filePaths, iterations = 30) {
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    checkSyntaxDiagnostics(filePaths);
    const duration = performance.now() - start;
    latencies.push(duration);
  }
  latencies.sort((a, b) => a - b);
  const minMs = latencies[0] || 0;
  const maxMs = latencies[latencies.length - 1] || 0;
  const avgMs = latencies.reduce((sum, v) => sum + v, 0) / (latencies.length || 1);
  const p95Index = Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1);
  const p95Ms = latencies[p95Index] || 0;

  return { minMs, maxMs, avgMs, p95Ms };
}

async function main() {
  const args = process.argv.slice(2);
  const specifiedFiles = [];
  let isBenchmark = false;
  let benchmarkIterations = 30;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--files' || arg === '-f') {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        specifiedFiles.push(path.resolve(REPO_ROOT, args[++i]));
      }
    } else if (arg === '--benchmark' || arg === '-b') {
      isBenchmark = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        benchmarkIterations = Number.parseInt(args[++i], 10) || 30;
      }
    }
  }

  const targetFiles = specifiedFiles.length > 0 ? specifiedFiles : getChangedTsFiles();

  if (targetFiles.length === 0) {
    process.stdout.write('[preflight] PASS (0 changed TypeScript files detected)\n');
    process.exit(0);
  }

  if (isBenchmark) {
    const bench = benchmarkPreflight(targetFiles, benchmarkIterations);
    process.stdout.write(
      `[preflight:bench] ${benchmarkIterations} runs on ${targetFiles.length} files: ` +
        `p95=${bench.p95Ms.toFixed(2)}ms, avg=${bench.avgMs.toFixed(2)}ms, ` +
        `min=${bench.minMs.toFixed(2)}ms, max=${bench.maxMs.toFixed(2)}ms\n`
    );
    if (bench.p95Ms < 300) {
      process.stdout.write(`✅ p95 < 300ms SLA verified (${bench.p95Ms.toFixed(2)}ms)\n`);
    } else {
      process.stderr.write(`⚠️ p95 exceeded 300ms SLA (${bench.p95Ms.toFixed(2)}ms)\n`);
    }
    process.exit(0);
  }

  const start = performance.now();
  const result = checkSyntaxDiagnostics(targetFiles);
  const elapsedMs = (performance.now() - start).toFixed(1);

  if (result.passed) {
    process.stdout.write(`[preflight] PASS (${result.checkedCount} files checked in ${elapsedMs}ms)\n`);
    process.exit(0);
  } else {
    process.stderr.write(`[preflight] FAILED with ${result.errors.length} syntax error(s):\n`);
    for (const err of result.errors) {
      process.stderr.write(`  - ${err.file}:${err.line}:${err.col} - ${err.message}\n`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`[preflight ERROR] ${err.message}\n`);
    process.exit(1);
  });
}
