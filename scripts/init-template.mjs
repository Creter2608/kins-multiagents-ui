#!/usr/bin/env node
/**
 * scripts/init-template.mjs
 * Deterministic Project Scaffolder for stamping out new AI-ready projects from this template.
 * Staged atomic creation, fresh golden assertions, and cryptographic SHA-256 recalculation.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const EXCLUDED_PATTERNS = [
  '.git',
  '.codegraph',
  'node_modules',
  'dist',
  '.ai',
  '.worktrees',
  '.DS_Store',
  'Thumbs.db'
];

const EXCLUDED_PATH_PREFIXES = [
  path.join('docs', 'archive'),
  path.join('docs', 'plans')
];

function printHelp() {
  const help = `
Usage: node scripts/init-template.mjs <target-directory> [options]

Arguments:
  target-directory         Target folder for the new AI-ready project

Options:
  --name <project-name>    Name of the new project (alphanumeric, -, _)
  --dry-run                Simulate the initialization without writing files
  --force                  Allow writing into an existing empty directory
  --help, -h               Show this help message
`;
  process.stdout.write(help.trim() + '\n');
}

function validateProjectName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Project name is required (--name <project-name>)');
  }
  const clean = name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
    throw new Error(`Invalid project name '${name}'. Must contain only letters, numbers, hyphens, and underscores.`);
  }
  return clean;
}

function validateTargetDirectory(targetDir) {
  const resolved = path.resolve(process.cwd(), targetDir);

  // Security: Prevent initializing into template root or inside template subdirectories
  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`Security violation: Target directory cannot be inside the template source (${REPO_ROOT})`);
  }

  // Security: Check parent directory exists
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`Parent directory does not exist: ${parent}`);
  }

  return resolved;
}

function shouldExclude(relPath) {
  const normalizedRel = path.normalize(relPath);
  const segments = normalizedRel.split(path.sep);
  if (EXCLUDED_PATTERNS.some((pattern) => segments.includes(pattern))) {
    return true;
  }
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => normalizedRel === prefix || normalizedRel.startsWith(prefix + path.sep))) {
    return true;
  }
  return normalizedRel.endsWith('.tmp') || normalizedRel.endsWith('.log');
}

function copyDirectoryRecursive(src, dest, exclusions = []) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relPath = path.relative(REPO_ROOT, srcPath);

    if (shouldExclude(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, exclusions);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let targetDirArg = null;
  let projectNameArg = null;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--name') {
      projectNameArg = rawArgs[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-') && targetDirArg === null) {
      targetDirArg = arg;
    }
  }

  if (!targetDirArg) {
    process.stderr.write('[init-template ERROR] Target directory must be specified.\n');
    printHelp();
    process.exit(1);
  }

  let projectName;
  let targetDir;
  try {
    targetDir = validateTargetDirectory(targetDirArg);
    projectName = validateProjectName(projectNameArg || path.basename(targetDir));
  } catch (err) {
    process.stderr.write(`[init-template CONFIG_INVALID] ${err.message}\n`);
    process.exit(1);
  }

  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir);
    if (files.length > 0 && !force) {
      process.stderr.write(`[init-template ERROR] Target directory is not empty: ${targetDir}. Use an empty directory or pass --force.\n`);
      process.exit(1);
    }
  }

  if (dryRun) {
    process.stdout.write(`[init-template DRY RUN] Project: ${projectName}\n`);
    process.stdout.write(`[init-template DRY RUN] Destination: ${targetDir}\n`);
    process.stdout.write(`[init-template DRY RUN] Would copy files from ${REPO_ROOT} (excluding .git, node_modules, dist, etc.)\n`);
    process.stdout.write(`[init-template DRY RUN] Would generate fresh .eval/golden_assertions.json and recalculate SHA-256.\n`);
    process.exit(0);
  }

  const stagingDir = `${targetDir}.staging-${Date.now()}`;
  try {
    process.stdout.write(`[init-template] Staging project in: ${stagingDir}\n`);
    copyDirectoryRecursive(REPO_ROOT, stagingDir);

    // Update package.json name
    const pkgPath = path.join(stagingDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      pkg.name = projectName;
      pkg.version = '0.1.0';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    }

    // Generate clean-slate wiki/log.md
    const wikiDir = path.join(stagingDir, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'log.md'), '# Project Log\n', 'utf-8');

    // Generate fresh .eval/golden_assertions.json
    const evalDir = path.join(stagingDir, '.eval');
    fs.mkdirSync(evalDir, { recursive: true });

    const initialGoldenDoc = {
      title: `${projectName} Golden Assertions`,
      description: `Baseline golden verification assertions for ${projectName}`,
      assertions: [
        {
          id: 'smoke-test-1',
          in: 'initialization',
          out: 'healthy'
        },
        {
          id: 'baseline-check',
          in: 'environment',
          out: 'docker-isolated'
        }
      ]
    };

    const goldenJsonString = JSON.stringify(initialGoldenDoc, null, 2) + '\n';
    const goldenJsonPath = path.join(evalDir, 'golden_assertions.json');
    fs.writeFileSync(goldenJsonPath, goldenJsonString, 'utf-8');

    // Compute fresh SHA-256 digest
    const newDigest = crypto.createHash('sha256').update(goldenJsonString).digest('hex') + '\n';
    const shaPath = path.join(evalDir, 'golden_assertions.sha256');
    fs.writeFileSync(shaPath, newDigest, 'utf-8');

    // Atomic move from staging to target
    if (fs.existsSync(targetDir)) {
      // If target exists and is empty
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, targetDir);

    process.stdout.write(`\n✅ Successfully initialized AI-ready project: ${projectName}\n`);
    process.stdout.write(`   Location:       ${targetDir}\n`);
    process.stdout.write(`   Golden SHA-256: ${newDigest.trim()}\n`);
    process.stdout.write(`   Run 'cd ${targetDir} && npm install && npm test' to verify.\n\n`);
  } catch (err) {
    process.stderr.write(`[init-template FAILED] ${err.message}\n`);
    if (fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    process.exit(1);
  }
}

main();
