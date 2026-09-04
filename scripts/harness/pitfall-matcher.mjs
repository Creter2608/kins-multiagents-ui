#!/usr/bin/env node
/**
 * scripts/harness/pitfall-matcher.mjs
 * Deterministic Context Pruner & Pitfall Matcher (P3).
 * Extracts only top 1-2 relevant pitfalls (~300 tokens) from wiki/pitfalls.md based on task/file keywords,
 * eliminating 80% prompt bloat and context dilution ($0 LLM token cost).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DOMAIN_KEYWORD_MAP = {
  'worktree': ['PITFALL-001', 'PITFALL-012'],
  'git': ['PITFALL-001', 'PITFALL-008', 'PITFALL-013'],
  'sha256': ['PITFALL-002', 'PITFALL-004', 'PITFALL-008'],
  'checksum': ['PITFALL-002', 'PITFALL-004', 'PITFALL-008'],
  'hash': ['PITFALL-002', 'PITFALL-008'],
  'eval': ['PITFALL-002', 'PITFALL-004', 'PITFALL-013'],
  'golden': ['PITFALL-002', 'PITFALL-004'],
  'docker': ['PITFALL-003'],
  'sandbox': ['PITFALL-003'],
  'container': ['PITFALL-003'],
  'permission': ['PITFALL-003'],
  'stream': ['PITFALL-005'],
  'buffer': ['PITFALL-005'],
  'truncate': ['PITFALL-005'],
  'exec': ['PITFALL-003', 'PITFALL-005'],
  'state': ['PITFALL-006'],
  'lock': ['PITFALL-006'],
  'persistence': ['PITFALL-006'],
  'retry': ['PITFALL-007'],
  'hypothesis': ['PITFALL-007'],
  'crlf': ['PITFALL-008'],
  'lf': ['PITFALL-008'],
  'newline': ['PITFALL-008'],
  'log': ['PITFALL-009'],
  'tail': ['PITFALL-009'],
  'prompt': ['PITFALL-010'],
  'cache': ['PITFALL-010'],
  'token': ['PITFALL-010'],
  'regex': ['PITFALL-011'],
  'inflection': ['PITFALL-011'],
  'matcher': ['PITFALL-011'],
  'react': ['PITFALL-012'],
  'terminal': ['PITFALL-005', 'PITFALL-012'],
  'unmount': ['PITFALL-012'],
  'commit': ['PITFALL-013'],
  'benchmark': ['PITFALL-013'],
  'head': ['PITFALL-013']
};

/**
 * Parses wiki/pitfalls.md into structured records.
 * @param {string} [customPath]
 * @returns {Array<{ id: string; name: string; errorClass: string; symptom: string; invariant: string; tokens: Set<string> }>}
 */
export function parsePitfallsCatalog(customPath) {
  const filePath = path.resolve(REPO_ROOT, customPath || 'wiki/pitfalls.md');
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const results = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.includes('**PITFALL-')) continue;

    const parts = trimmed.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 5) {
      const idMatch = /\*\*(PITFALL-\d{3})\*\*/.exec(parts[0] || '');
      if (idMatch && idMatch[1]) {
        const id = idMatch[1];
        const name = (parts[1] || '').replace(/`|\*\*/g, '');
        const errorClass = (parts[2] || '').replace(/`|\*\*/g, '');
        const symptom = (parts[3] || '').replace(/`|\*\*/g, '');
        const invariant = (parts[4] || '').replace(/`|\*\*/g, '');

        const textToTokenize = `${id} ${name} ${errorClass} ${symptom} ${invariant}`.toLowerCase();
        const rawTokens = textToTokenize.split(/[^a-z0-9_-]+/i).filter((t) => t.length > 2);
        const tokens = new Set(rawTokens);

        results.push({
          id,
          name,
          errorClass,
          symptom,
          invariant,
          tokens
        });
      }
    }
  }

  return results;
}

/**
 * Matches relevant pitfalls based on query text or changed files.
 * @param {string | string[]} input
 * @param {object} [options={}]
 * @param {number} [options.maxResults=2]
 * @param {number} [options.tokenBudget=400]
 * @param {string} [options.catalogPath]
 * @returns {{ matches: Array<{ id: string; score: number; name: string; invariant: string }>; markdown: string; tokenEstimate: number }}
 */
export function matchPitfalls(input, options = {}) {
  const maxResults = options.maxResults || 2;
  const tokenBudget = options.tokenBudget || 400;
  const catalog = parsePitfallsCatalog(options.catalogPath);

  if (catalog.length === 0) {
    return { matches: [], markdown: '', tokenEstimate: 0 };
  }

  const normalizedInput = (Array.isArray(input) ? input.join(' ') : String(input || '')).toLowerCase();
  const inputWords = normalizedInput.split(/[^a-z0-9_-]+/i).filter((w) => w.length > 2);

  const scores = new Map();
  for (const item of catalog) {
    scores.set(item.id, 0);
  }

  // 1. Direct word overlap scoring
  for (const word of inputWords) {
    for (const item of catalog) {
      if (item.tokens.has(word)) {
        scores.set(item.id, (scores.get(item.id) || 0) + 2);
      }
    }

    // 2. Domain keyword mapping boost
    if (DOMAIN_KEYWORD_MAP[word]) {
      for (const targetId of DOMAIN_KEYWORD_MAP[word]) {
        scores.set(targetId, (scores.get(targetId) || 0) + 5);
      }
    }
  }

  // Sort by score desc, tie-break by ID asc
  const ranked = catalog
    .map((item) => ({
      id: item.id,
      score: scores.get(item.id) || 0,
      name: item.name,
      invariant: item.invariant
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });

  const selected = ranked.slice(0, maxResults);

  if (selected.length === 0) {
    return { matches: [], markdown: '', tokenEstimate: 0 };
  }

  const lines = [
    '### ⚠️ Invariant Pitfall Guards (wiki/pitfalls.md)',
    ''
  ];

  for (const m of selected) {
    lines.push(`- **[${m.id}] ${m.name}**: ${m.invariant}`);
  }

  const markdown = lines.join('\n');
  const tokenEstimate = Math.ceil(markdown.length / 4);

  return {
    matches: selected,
    markdown,
    tokenEstimate
  };
}

async function main() {
  const args = process.argv.slice(2);
  let query = '';
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--query' || arg === '-q') {
      query = args[++i] || '';
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (!query && !arg.startsWith('-')) {
      query = arg;
    }
  }

  const result = matchPitfalls(query);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.matches.length === 0) {
      process.stdout.write('[pitfall-matcher] No specific pitfall triggers matched query.\n');
    } else {
      process.stdout.write(result.markdown + '\n');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`[pitfall-matcher ERROR] ${err.message}\n`);
    process.exit(1);
  });
}
