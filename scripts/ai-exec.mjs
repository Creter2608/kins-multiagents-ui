#!/usr/bin/env node
/**
 * ai-exec.mjs
 * Deterministic, zero-dependency command executor for AI agents.
 * Caps stdout/stderr to prevent terminal token flooding while preserving exit codes.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_CAP_BYTES = 32 * 1024; // 32 KiB default
const HARD_MAX_BYTES = 128 * 1024;   // 128 KiB hard ceiling

const envCap = Number.parseInt(process.env.AI_EXEC_MAX_BYTES || '', 10);
const MAX_BYTES = Math.min(
  Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_CAP_BYTES,
  HARD_MAX_BYTES
);

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: node scripts/ai-exec.mjs <command> [args...]\n');
  process.exit(1);
}

const [cmd, ...cmdArgs] = args;
const child = spawn(cmd, cmdArgs, {
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe']
});

let stdoutChunks = [];
let stderrChunks = [];
let totalStdoutBytes = 0;
let totalStderrBytes = 0;

child.stdout.on('data', (chunk) => {
  stdoutChunks.push(chunk);
  totalStdoutBytes += chunk.length;
});

child.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk);
  totalStderrBytes += chunk.length;
});

function truncateBuffer(chunks, totalBytes, maxBytes, streamName) {
  const combined = Buffer.concat(chunks, totalBytes);
  if (totalBytes <= maxBytes) {
    return combined;
  }

  const headBytes = Math.floor(maxBytes * 0.65);
  const tailBytes = Math.floor(maxBytes * 0.35);
  const truncatedCount = totalBytes - (headBytes + tailBytes);

  const head = combined.subarray(0, headBytes).toString('utf-8');
  const tail = combined.subarray(totalBytes - tailBytes).toString('utf-8');

  // Find nearest newline boundaries to avoid ragged lines
  const cleanHead = head.slice(0, head.lastIndexOf('\n') + 1) || head;
  const cleanTail = tail.slice(tail.indexOf('\n') + 1) || tail;

  const marker = `\n\n[... TRUNCATED ${truncatedCount} BYTES OF ${streamName} BY AI-EXEC (TOTAL: ${totalBytes} B, CAP: ${maxBytes} B) ...]\n\n`;

  return Buffer.from(cleanHead + marker + cleanTail, 'utf-8');
}

child.on('close', (code, signal) => {
  if (totalStdoutBytes > 0) {
    const processedStdout = truncateBuffer(stdoutChunks, totalStdoutBytes, MAX_BYTES, 'STDOUT');
    process.stdout.write(processedStdout);
  }

  if (totalStderrBytes > 0) {
    const processedStderr = truncateBuffer(stderrChunks, totalStderrBytes, Math.floor(MAX_BYTES / 2), 'STDERR');
    process.stderr.write(processedStderr);
  }

  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on('error', (err) => {
  process.stderr.write(`ai-exec error: ${err.message}\n`);
  process.exit(1);
});
