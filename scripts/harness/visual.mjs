/**
 * scripts/harness/visual.mjs
 * Visual & Headless Browser E2E UI Assertions Engine.
 * Provides DOM snapshot canonicalization, structural/attribute diffing,
 * zero-dependency pixel-level visual regression comparisons, and Cockpit UI assertions.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Normalizes an HTML string by trimming whitespace, removing comments,
 * and deterministically sorting HTML element attributes alphabetically.
 *
 * @param {string} html
 * @param {object} [options={}]
 * @returns {string}
 */
export function canonicalizeHtml(html, options = {}) {
  if (typeof html !== 'string') {
    return '';
  }

  let result = html;

  // 1. Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Collapse internal multi-whitespace between tags
  result = result.replace(/>\s+</g, '><');

  // 3. Normalize whitespace within text nodes
  result = result.replace(/\s{2,}/g, ' ').trim();

  // 4. Sort attributes alphabetically inside opening tags
  result = result.replace(/<([a-zA-Z0-9:-]+)(\s+[^>]*)?>/g, (match, tagName, rawAttrs) => {
    if (!rawAttrs || !rawAttrs.trim()) {
      return `<${tagName}>`;
    }

    // Match attr="val" or attr='val' or standalone attr
    const attrRegex = /([a-zA-Z0-9:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const attrs = [];
    let attrMatch;

    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const name = attrMatch[1];
      const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

      // Skip volatile/ignored attributes if configured
      if (options.ignoredAttributes && options.ignoredAttributes.includes(name)) {
        continue;
      }
      attrs.push({ name, val });
    }

    // Sort attributes alphabetically by attribute name
    attrs.sort((a, b) => a.name.localeCompare(b.name));

    if (attrs.length === 0) {
      return `<${tagName}>`;
    }

    const attrString = attrs.map(a => `${a.name}="${a.val}"`).join(' ');
    return `<${tagName} ${attrString}>`;
  });

  return result;
}

/**
 * Compares two DOM snapshot HTML strings and outputs a structured difference report.
 *
 * @param {string} baselineHtml
 * @param {string} candidateHtml
 * @param {object} [options={}]
 * @returns {{ match: boolean, similarity: number, diffs: Array<{ type: string, message: string }> }}
 */
export function compareDomSnapshots(baselineHtml, candidateHtml, options = {}) {
  const normBase = canonicalizeHtml(baselineHtml, options);
  const normCand = canonicalizeHtml(candidateHtml, options);

  if (normBase === normCand) {
    return {
      match: true,
      similarity: 1.0,
      diffs: []
    };
  }

  const diffs = [];

  // Simple token / line analysis
  const baseTokens = normBase.split('><');
  const candTokens = normCand.split('><');

  const maxLen = Math.max(baseTokens.length, candTokens.length);
  let matchingTokens = 0;

  for (let i = 0; i < maxLen; i++) {
    const b = baseTokens[i];
    const c = candTokens[i];

    if (b === c) {
      matchingTokens++;
    } else if (b && !c) {
      diffs.push({
        type: 'deletion',
        message: `Missing element or tag in candidate at index ${i}: <${b}>`
      });
    } else if (!b && c) {
      diffs.push({
        type: 'addition',
        message: `Unexpected element or tag in candidate at index ${i}: <${c}>`
      });
    } else {
      diffs.push({
        type: 'modification',
        message: `Mismatch at token ${i}: expected <${b}>, got <${c}>`
      });
    }
  }

  const similarity = maxLen > 0
    ? Math.round((matchingTokens / maxLen) * 10000) / 10000
    : 1.0;

  return {
    match: diffs.length === 0,
    similarity,
    diffs
  };
}

/**
 * Creates a standard PPM P6 binary image buffer for testing visual diffing without dependencies.
 *
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} [rgb=[0, 0, 0]]
 * @returns {Buffer}
 */
export function createPpmImage(width, height, rgb = [0, 0, 0]) {
  const header = `P6\n${width} ${height}\n255\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const pixelCount = width * height;
  const pixelBuf = Buffer.alloc(pixelCount * 3);

  const [r, g, b] = rgb;
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 3;
    pixelBuf[offset] = r;
    pixelBuf[offset + 1] = g;
    pixelBuf[offset + 2] = b;
  }

  return Buffer.concat([headerBuf, pixelBuf]);
}

/**
 * Parses a PPM P6 binary image buffer.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, maxVal: number, data: Buffer }}
 */
export function parsePpmImage(buffer) {
  let offset = 0;

  function readNextToken() {
    // Skip whitespace and comments
    while (offset < buffer.length) {
      const ch = buffer[offset];
      if (ch === 0x23) { // '#' comment
        while (offset < buffer.length && buffer[offset] !== 0x0a) {
          offset++;
        }
      } else if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        offset++;
      } else {
        break;
      }
    }

    const start = offset;
    while (offset < buffer.length) {
      const ch = buffer[offset];
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        break;
      }
      offset++;
    }

    return buffer.toString('ascii', start, offset);
  }

  const magic = readNextToken();
  if (magic !== 'P6') {
    throw new Error(`Unsupported PPM magic: expected P6, got ${magic}`);
  }

  const width = parseInt(readNextToken(), 10);
  const height = parseInt(readNextToken(), 10);
  const maxVal = parseInt(readNextToken(), 10);

  // Next byte after maxVal is the single whitespace character before binary payload
  offset++;

  const data = buffer.subarray(offset);
  if (data.length < width * height * 3) {
    throw new Error(`Corrupt PPM: expected ${width * height * 3} bytes, got ${data.length}`);
  }

  return { width, height, maxVal, data };
}

/**
 * Compares two image pixel buffers (either PPM Buffers or raw RGB/RGBA objects).
 * Calculates pixel difference count, percentage, and returns a highlight diff buffer.
 *
 * @param {Buffer | { width: number, height: number, data: Buffer }} imgA
 * @param {Buffer | { width: number, height: number, data: Buffer, channels?: number }} imgB
 * @param {object} [options={}]
 * @returns {{ match: boolean, totalPixels: number, diffPixels: number, diffPercentage: number, diffBuffer?: Buffer }}
 */
export function comparePixelBuffers(imgA, imgB, options = {}) {
  let parsedA = imgA;
  let parsedB = imgB;

  if (Buffer.isBuffer(imgA)) {
    parsedA = parsePpmImage(imgA);
  }
  if (Buffer.isBuffer(imgB)) {
    parsedB = parsePpmImage(imgB);
  }

  if (parsedA.width !== parsedB.width || parsedA.height !== parsedB.height) {
    return {
      match: false,
      totalPixels: Math.max(parsedA.width * parsedA.height, parsedB.width * parsedB.height),
      diffPixels: Math.max(parsedA.width * parsedA.height, parsedB.width * parsedB.height),
      diffPercentage: 100
    };
  }

  const width = parsedA.width;
  const height = parsedA.height;
  const totalPixels = width * height;
  const channels = options.channels || 3; // default RGB
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.05;
  const maxDiffPercentage = typeof options.maxDiffPercentage === 'number' ? options.maxDiffPercentage : 0;

  const dataA = parsedA.data;
  const dataB = parsedB.data;

  let diffPixels = 0;
  const diffData = options.generateDiffImage ? Buffer.alloc(totalPixels * 3) : null;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * channels;
    const rDiff = Math.abs(dataA[idx] - dataB[idx]) / 255;
    const gDiff = Math.abs(dataA[idx + 1] - dataB[idx + 1]) / 255;
    const bDiff = Math.abs(dataA[idx + 2] - dataB[idx + 2]) / 255;

    const pixelDiff = (rDiff + gDiff + bDiff) / 3;

    if (pixelDiff > threshold) {
      diffPixels++;
      if (diffData) {
        // Red highlight for diff
        diffData[i * 3] = 255;
        diffData[i * 3 + 1] = 0;
        diffData[i * 3 + 2] = 0;
      }
    } else if (diffData) {
      // Retain baseline muted pixel
      diffData[i * 3] = Math.floor(dataA[idx] * 0.5);
      diffData[i * 3 + 1] = Math.floor(dataA[idx + 1] * 0.5);
      diffData[i * 3 + 2] = Math.floor(dataA[idx + 2] * 0.5);
    }
  }

  const diffPercentage = totalPixels > 0
    ? Math.round((diffPixels / totalPixels) * 10000) / 100
    : 0;

  let diffBuffer;
  if (diffData) {
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
    diffBuffer = Buffer.concat([header, diffData]);
  }

  return {
    match: diffPercentage <= maxDiffPercentage,
    totalPixels,
    diffPixels,
    diffPercentage,
    diffBuffer
  };
}

/**
 * Asserts that a Cockpit HUD / Scoreboard DOM snapshot contains required metric values.
 *
 * @param {string} htmlSnapshot
 * @param {{ passAt1?: number, ssi?: number, dei?: number, totalCostMicroUsd?: number }} expectedMetrics
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function assertCockpitHudSnapshot(htmlSnapshot, expectedMetrics) {
  const errors = [];
  if (typeof htmlSnapshot !== 'string' || !htmlSnapshot.trim()) {
    return { valid: false, errors: ['HTML snapshot is empty or invalid'] };
  }

  if (expectedMetrics.passAt1 !== undefined) {
    const expectedStr = `${Math.round(expectedMetrics.passAt1 * 100)}%`;
    if (!htmlSnapshot.includes(expectedStr) && !htmlSnapshot.includes(String(expectedMetrics.passAt1))) {
      errors.push(`Scoreboard missing expected Pass@1 rate: ${expectedStr}`);
    }
  }

  if (expectedMetrics.ssi !== undefined) {
    const expectedStr = `${expectedMetrics.ssi}%`;
    if (!htmlSnapshot.includes(expectedStr) && !htmlSnapshot.includes(String(expectedMetrics.ssi))) {
      errors.push(`Scoreboard missing expected SSI index: ${expectedStr}`);
    }
  }

  if (expectedMetrics.dei !== undefined) {
    const expectedStr = `${expectedMetrics.dei.toFixed(1)}` || `${expectedMetrics.dei}`;
    if (!htmlSnapshot.includes(expectedStr)) {
      errors.push(`Scoreboard missing expected DEI metric: ${expectedStr}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Asserts deterministic active tab switching between two UI snapshots.
 *
 * @param {string} beforeSnapshot
 * @param {string} afterSnapshot
 * @param {string} expectedActiveTab
 * @returns {{ switched: boolean, activeTab: string | null, errors: string[] }}
 */
export function assertTabSwitching(beforeSnapshot, afterSnapshot, expectedActiveTab) {
  const errors = [];

  const activeTabRegex = /<button[^>]*class="[^"]*(?:active|selected)[^"]*"[^>]*data-tab="([^"]+)"/i;
  const beforeMatch = beforeSnapshot.match(activeTabRegex);
  const afterMatch = afterSnapshot.match(activeTabRegex);

  const beforeTab = beforeMatch ? beforeMatch[1] : null;
  const afterTab = afterMatch ? afterMatch[1] : null;

  if (afterTab !== expectedActiveTab) {
    errors.push(`Expected active tab '${expectedActiveTab}', but found '${afterTab}'`);
  }

  if (beforeTab === afterTab) {
    errors.push(`Tab state did not change (was '${beforeTab}', remains '${afterTab}')`);
  }

  return {
    switched: errors.length === 0,
    activeTab: afterTab,
    errors
  };
}
