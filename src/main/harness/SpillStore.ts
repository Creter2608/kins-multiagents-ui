/**
 * src/main/harness/SpillStore.ts
 * Manages atomic disk offloading for large tool outputs inspired by DeepSeek Harness.
 * Provides private, contained persistence and graceful inline degradation.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { SaveSpillInput, SpillRef } from '../../shared/harnessContracts.js';

export { type SaveSpillInput, type SpillRef };

export interface SpillOutputOptions {
  readonly maxInlineBytes: number;
  readonly maxInlineChars: number;
  readonly headPreviewChars: number;
}

/**
 * Truncates string respecting max code units and max UTF-8 bytes without splitting surrogate pairs.
 */
function sliceSafe(str: string, maxChars: number, maxBytes: number): string {
  if (maxChars <= 0 || maxBytes <= 0) return '';
  let accumulatedChars = 0;
  let accumulatedBytes = 0;
  let endIdx = 0;

  for (let i = 0; i < str.length; ) {
    const code = str.charCodeAt(i);
    let charLen = 1;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const nextCode = str.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        charLen = 2;
      }
    }
    const chunk = str.slice(i, i + charLen);
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');

    if (accumulatedChars + charLen > maxChars || accumulatedBytes + chunkBytes > maxBytes) {
      break;
    }

    accumulatedChars += charLen;
    accumulatedBytes += chunkBytes;
    endIdx = i + charLen;
    i += charLen;
  }

  return str.slice(0, endIdx);
}

export class LocalSpillStore {
  private readonly spillRoot: string;

  constructor(userDataPath: string) {
    if (!userDataPath || typeof userDataPath !== 'string') {
      throw new Error('Invalid userDataPath: must be a non-empty string.');
    }
    this.spillRoot = path.resolve(userDataPath, 'spill');
  }

  async saveText(input: SaveSpillInput): Promise<SpillRef> {
    const sessionId = input.owner?.sessionId;
    if (
      !sessionId ||
      typeof sessionId !== 'string' ||
      sessionId.trim() === '' ||
      sessionId.includes('..') ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      !/^[a-zA-Z0-9_-]+$/.test(sessionId)
    ) {
      throw new Error(`Invalid sessionId '${sessionId}'. Must be alphanumeric without traversal.`);
    }

    const sessionDir = path.resolve(this.spillRoot, sessionId);
    const relativeToRoot = path.relative(this.spillRoot, sessionDir);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Path escape rejected for sessionId '${sessionId}'.`);
    }

    // Reject symlinked spill root
    try {
      const rootStat = await fs.promises.lstat(this.spillRoot);
      if (rootStat.isSymbolicLink()) {
        throw new Error(`Symlinked spill root rejected: '${this.spillRoot}'.`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Reject symlinked session directory
    try {
      const existingDirStat = await fs.promises.lstat(sessionDir);
      if (existingDirStat.isSymbolicLink()) {
        throw new Error(`Symlinked spill directory rejected: '${sessionDir}'.`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    await fs.promises.mkdir(sessionDir, { recursive: true });

    const dirStat = await fs.promises.lstat(sessionDir);
    if (dirStat.isSymbolicLink()) {
      throw new Error(`Symlinked spill directory rejected: '${sessionDir}'.`);
    }

    const contentBuffer = Buffer.from(input.content, 'utf8');
    const hash = crypto.createHash('sha256').update(contentBuffer).digest('hex').slice(0, 16);

    const safeName = (input.suggestedName || 'output.txt')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^\.+/, '') || 'output.txt';

    const finalFileName = `${hash}_${safeName}`;
    const finalPath = path.resolve(sessionDir, finalFileName);

    const relativeToFile = path.relative(sessionDir, finalPath);
    if (relativeToFile.startsWith('..') || path.isAbsolute(relativeToFile)) {
      throw new Error(`Filename escape rejected: '${finalFileName}'.`);
    }

    // Reuse existing identical file if already persisted
    try {
      const existingStat = await fs.promises.stat(finalPath);
      if (existingStat.isFile() && existingStat.size === contentBuffer.length) {
        return {
          locator: finalPath,
          bytes: contentBuffer.length,
          retrievalHint: `Use read_file at: ${finalPath}`
        };
      }
    } catch {
      // File does not exist yet, proceed with atomic write
    }

    const tempFileName = `.tmp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const tempPath = path.resolve(sessionDir, tempFileName);

    try {
      await fs.promises.writeFile(tempPath, contentBuffer);
      await fs.promises.rename(tempPath, finalPath);
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore cleanup error
      }
      throw err;
    }

    return {
      locator: finalPath,
      bytes: contentBuffer.length,
      retrievalHint: `Use read_file at: ${finalPath}`
    };
  }
}

export async function formatToolOutput(
  store: LocalSpillStore,
  input: SaveSpillInput,
  options: SpillOutputOptions
): Promise<string> {
  if (
    !Number.isInteger(options.maxInlineBytes) || options.maxInlineBytes < 0 ||
    !Number.isInteger(options.maxInlineChars) || options.maxInlineChars < 0 ||
    !Number.isInteger(options.headPreviewChars) || options.headPreviewChars < 0
  ) {
    throw new Error('Invalid SpillOutputOptions: limits must be non-negative integers.');
  }

  const byteLength = Buffer.byteLength(input.content, 'utf8');
  const charLength = input.content.length;

  if (byteLength <= options.maxInlineBytes && charLength <= options.maxInlineChars) {
    return input.content;
  }

  try {
    const spillRef = await store.saveText(input);
    const headPreview = sliceSafe(input.content, options.headPreviewChars, Infinity);
    return `[Output spilled to disk (${spillRef.bytes} bytes). Use read_file at: ${spillRef.locator}]\nPreview:\n${headPreview}`;
  } catch {
    // Disk write failure: graceful degradation to bounded inline fallback without pointer
    const marker = '\n... [output truncated; spill unavailable]';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const markerChars = marker.length;

    if (markerChars <= options.maxInlineChars && markerBytes <= options.maxInlineBytes) {
      const allowedChars = options.maxInlineChars - markerChars;
      const allowedBytes = options.maxInlineBytes - markerBytes;
      const prefix = sliceSafe(input.content, allowedChars, allowedBytes);
      return `${prefix}${marker}`;
    }

    return sliceSafe(input.content, options.maxInlineChars, options.maxInlineBytes);
  }
}
