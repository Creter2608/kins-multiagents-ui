#!/usr/bin/env node
/**
 * scripts/harness/corpus-cli.mjs
 * Command-line interface for Corpus Management & Task Ingestion.
 *
 * Exit codes:
 *   0: success
 *   2: invalid CLI input
 *   3: corpus validation failure
 *   4: provenance or digest mismatch
 *   5: environment / infrastructure failure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { ingestTask, validateCandidateTask, verifyCorpus } from './corpus.mjs';

function printUsage() {
  console.log(`
Usage:
  node scripts/harness/corpus-cli.mjs <command> [options]

Commands:
  ingest      Ingest a candidate benchmark task from Git commits
  validate    Validate an existing task manifest JSON file
  verify      Scan and verify all manifests in a corpus directory

Ingest Options:
  --id <taskId>           Required task ID (e.g. 001-fix-login)
  --title <title>         Required task title
  --type <f2p|p2p>        Required task type (f2p or p2p)
  --base <commit>         Required base commit SHA
  --target <commit>       Required target commit SHA
  --cmd <arg...>          Command to execute (e.g. node -v)
  --timeout <ms>          Timeout in ms (default 60000)
  --repo <dir>            Repository root (default cwd)
  --staging <dir>         Staging output directory (default .harness/corpus-staging)
  --no-validate           Skip base/target semantic execution check
  --license <name>        License string (default MIT)
  --dataset-id <id>       Dataset ID (default kins-benchmark)
  --dataset-ver <ver>     Dataset version (default 1.0.0)

Validate Options:
  <manifest-path>         Path to task.json or manifest file
  --verify-digest         Verify manifestSha256 matches computed digest

Verify Options:
  <corpus-dir>            Path to corpus directory to scan
`);
}

function parseArgs(args) {
  const parsed = {
    command: args[0],
    positional: [],
    flags: {}
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'no-validate' || key === 'verify-digest') {
        parsed.flags[key] = true;
      } else if (key === 'cmd') {
        // Collect all following non-flag arguments as cmd.argv
        const argv = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          argv.push(args[++i]);
        }
        parsed.flags.cmd = argv;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        parsed.flags[key] = args[++i];
      } else {
        parsed.flags[key] = true;
      }
    } else {
      parsed.positional.push(arg);
    }
  }

  return parsed;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const { command, positional, flags } = parseArgs(rawArgs);

  if (command === 'ingest') {
    const taskId = flags.id;
    const title = flags.title;
    const taskType = flags.type;
    const baseCommit = flags.base;
    const targetCommit = flags.target;
    const cmdArgv = flags.cmd;
    const timeoutMs = flags.timeout ? Number(flags.timeout) : 60000;
    const repoRoot = flags.repo || process.cwd();
    const stagingDir = flags.staging;
    const validateSemantics = !flags['no-validate'];
    const license = flags.license || 'MIT';
    const datasetId = flags['dataset-id'] || 'kins-benchmark';
    const datasetVersion = flags['dataset-ver'] || '1.0.0';

    if (!taskId || !title || !taskType || !baseCommit || !targetCommit || !cmdArgv || cmdArgv.length === 0) {
      console.error('ERROR: Missing required options for ingest. Required: --id, --title, --type, --base, --target, --cmd');
      process.exit(2);
    }

    try {
      const result = await ingestTask({
        repoRoot,
        taskId,
        title,
        taskType,
        baseCommit,
        targetCommit,
        commands: [{ argv: cmdArgv, timeoutMs }],
        stagingDir,
        validateSemantics,
        license,
        datasetId,
        datasetVersion
      });

      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      if (err.message.includes('STAGING_VIOLATION') || err.message.includes('Invalid taskId')) {
        console.error(`VALIDATION_ERROR: ${err.message}`);
        process.exit(2);
      } else if (err.message.includes('SEMANTIC_VALIDATION_FAILED')) {
        console.error(`SEMANTIC_ERROR: ${err.message}`);
        process.exit(3);
      } else if (err.message.includes('Failed to resolve')) {
        console.error(`PROVENANCE_ERROR: ${err.message}`);
        process.exit(4);
      } else {
        console.error(`INFRASTRUCTURE_ERROR: ${err.message}`);
        process.exit(5);
      }
    }
  } else if (command === 'validate') {
    const manifestPath = positional[0] || flags.file;
    if (!manifestPath) {
      console.error('ERROR: Missing manifest path to validate.');
      process.exit(2);
    }

    if (!fs.existsSync(manifestPath)) {
      console.error(`ERROR: File not found: ${manifestPath}`);
      process.exit(2);
    }

    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(content);
      const verifyDigest = Boolean(flags['verify-digest']);
      const result = validateCandidateTask(parsed, { verifyDigest });

      if (!result.valid) {
        console.error(`Validation failed with ${result.errors.length} errors:`);
        for (const err of result.errors) {
          console.error(` - ${err}`);
        }
        if (result.errors.some(e => e.includes('mismatch'))) {
          process.exit(4);
        }
        process.exit(3);
      }

      console.log(`OK: Manifest ${manifestPath} is valid.`);
      process.exit(0);
    } catch (err) {
      console.error(`ERROR: Failed to read/parse manifest: ${err.message}`);
      process.exit(2);
    }
  } else if (command === 'verify') {
    const corpusDir = positional[0] || flags.dir || '.';
    try {
      const res = await verifyCorpus(corpusDir);
      if (!res.valid) {
        console.error(`Corpus verification failed with ${res.issues.length} issues (scanned ${res.count} manifests):`);
        for (const issue of res.issues) {
          console.error(` - ${issue}`);
        }
        process.exit(3);
      }
      console.log(`OK: Verified ${res.count} manifests in ${corpusDir}. Zero integrity issues.`);
      process.exit(0);
    } catch (err) {
      console.error(`INFRASTRUCTURE_ERROR: ${err.message}`);
      process.exit(5);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(2);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(5);
});
