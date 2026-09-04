/**
 * scripts/harness/telemetry.mjs
 * Granular Telemetry, Token Economics & Dollar Efficiency Index (DEI) Engine.
 * Provides normalized multi-provider token usage, immutable versioned pricing,
 * exact integer micro-USD cost arithmetic, DEI metrics, and tamper-evident
 * hash-linked audit event streams.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CATALOG_PATH = path.join(__dirname, 'pricing', 'catalog.json');

const GENESIS_PREV_HASH = '0'.repeat(64);

let cachedDefaultCatalog = null;

/**
 * Deterministically stringifies an object by sorting object keys alphabetically.
 * Preserves arrays in original order.
 */
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map(key => `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Normalizes diverse LLM token usage responses into a canonical TokenUsage contract.
 * Supports OpenAI, Anthropic, Google Gemini, and generic formats.
 *
 * @param {unknown} rawUsage
 * @param {"provider" | "gateway" | "unavailable"} [source='provider']
 * @returns {import('../../src/shared/harness.js').TokenUsage}
 */
export function normalizeTokenUsage(rawUsage, source = 'provider') {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'unavailable'
    };
  }

  const u = /** @type {Record<string, any>} */ (rawUsage);

  // OpenAI format
  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const promptTokens = Math.max(0, Math.floor(Number(u.prompt_tokens) || 0));
    const completionTokens = Math.max(0, Math.floor(Number(u.completion_tokens) || 0));
    const cachedTokens = Math.max(0, Math.floor(Number(u.prompt_tokens_details?.cached_tokens) || 0));
    return {
      promptTokens,
      completionTokens,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0,
      source: (u.source && ['provider', 'gateway', 'unavailable'].includes(u.source)) ? u.source : source
    };
  }

  // Anthropic format
  if ('input_tokens' in u || 'output_tokens' in u) {
    const promptTokens = Math.max(0, Math.floor(Number(u.input_tokens) || 0));
    const completionTokens = Math.max(0, Math.floor(Number(u.output_tokens) || 0));
    const cacheReadTokens = Math.max(0, Math.floor(Number(u.cache_read_input_tokens) || 0));
    const cacheWriteTokens = Math.max(0, Math.floor(Number(u.cache_creation_input_tokens) || 0));
    return {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      source: (u.source && ['provider', 'gateway', 'unavailable'].includes(u.source)) ? u.source : source
    };
  }

  // Google Gemini format
  if ('promptTokenCount' in u || 'candidatesTokenCount' in u) {
    const promptTokens = Math.max(0, Math.floor(Number(u.promptTokenCount) || 0));
    const completionTokens = Math.max(0, Math.floor(Number(u.candidatesTokenCount) || 0));
    const cachedTokens = Math.max(0, Math.floor(Number(u.cachedContentTokenCount) || 0));
    return {
      promptTokens,
      completionTokens,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0,
      source: (u.source && ['provider', 'gateway', 'unavailable'].includes(u.source)) ? u.source : source
    };
  }

  // Standard TokenUsage format
  const promptTokens = Math.max(0, Math.floor(Number(u.promptTokens) || 0));
  const completionTokens = Math.max(0, Math.floor(Number(u.completionTokens) || 0));
  const cacheReadTokens = Math.max(0, Math.floor(Number(u.cacheReadTokens) || 0));
  const cacheWriteTokens = Math.max(0, Math.floor(Number(u.cacheWriteTokens) || 0));
  const resolvedSource = (u.source && ['provider', 'gateway', 'unavailable'].includes(u.source))
    ? u.source
    : source;

  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    source: resolvedSource
  };
}

/**
 * Loads a versioned pricing catalog from disk or returns the provided object.
 *
 * @param {string | object} [catalogPathOrObject]
 * @returns {Record<string, any>}
 */
export function loadPricingCatalog(catalogPathOrObject) {
  if (catalogPathOrObject && typeof catalogPathOrObject === 'object') {
    if (!catalogPathOrObject.version || !catalogPathOrObject.models) {
      throw new Error("Invalid pricing catalog: missing 'version' or 'models'");
    }
    return catalogPathOrObject;
  }

  const targetPath = typeof catalogPathOrObject === 'string'
    ? path.resolve(catalogPathOrObject)
    : DEFAULT_CATALOG_PATH;

  if (targetPath === DEFAULT_CATALOG_PATH && cachedDefaultCatalog) {
    return cachedDefaultCatalog;
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Pricing catalog not found: ${targetPath}`);
  }

  const raw = fs.readFileSync(targetPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed.version || !parsed.models) {
    throw new Error(`Invalid pricing catalog in ${targetPath}: missing 'version' or 'models'`);
  }

  if (targetPath === DEFAULT_CATALOG_PATH) {
    cachedDefaultCatalog = parsed;
  }

  return parsed;
}

/**
 * Calculates deterministic integer micro-USD costs from TokenUsage and Model ID.
 *
 * @param {import('../../src/shared/harness.js').TokenUsage} tokenUsage
 * @param {string} modelId
 * @param {object} [options={}]
 * @returns {import('../../src/shared/harness.js').CostAttribution}
 */
export function calculateCostAttribution(tokenUsage, modelId, options = {}) {
  const usage = normalizeTokenUsage(tokenUsage);
  const catalog = loadPricingCatalog(options.catalog);

  const modelConfig = catalog.models?.[modelId] || options.customRates;
  if (!modelConfig) {
    throw new Error(`Model '${modelId}' not found in pricing catalog '${catalog.version}'`);
  }

  const inputRate = Math.max(0, Math.floor(Number(modelConfig.inputMicroUsdPerMillion) || 0));
  const outputRate = Math.max(0, Math.floor(Number(modelConfig.outputMicroUsdPerMillion) || 0));
  const cacheReadRate = Math.max(0, Math.floor(Number(modelConfig.cacheReadMicroUsdPerMillion) || 0));
  const cacheWriteRate = Math.max(0, Math.floor(Number(modelConfig.cacheWriteMicroUsdPerMillion) || 0));

  const inputMicroUsd = Math.round((usage.promptTokens * inputRate) / 1_000_000);
  const outputMicroUsd = Math.round((usage.completionTokens * outputRate) / 1_000_000);
  const cacheMicroUsd = Math.round((usage.cacheReadTokens * cacheReadRate) / 1_000_000) +
                        Math.round((usage.cacheWriteTokens * cacheWriteRate) / 1_000_000);
  const surchargeMicroUsd = Math.max(0, Math.floor(Number(options.surchargeMicroUsd) || 0));

  const totalMicroUsd = inputMicroUsd + outputMicroUsd + cacheMicroUsd + surchargeMicroUsd;

  return {
    pricingCatalogVersion: String(catalog.version),
    currency: 'USD',
    inputMicroUsd,
    outputMicroUsd,
    cacheMicroUsd,
    surchargeMicroUsd,
    totalMicroUsd
  };
}

/**
 * Computes the Dollar Efficiency Index (DEI).
 * Formula: DEI = (Weighted Passed Tasks) / (Total Cost in USD)
 *              = (weightedPassed * 1,000,000) / totalMicroUsd
 *
 * Invariant: Returns null if totalMicroUsd <= 0 or invalid to avoid division by zero.
 *
 * @param {number} weightedPassed
 * @param {number} totalMicroUsd
 * @returns {number | null}
 */
export function calculateDollarEfficiencyIndex(weightedPassed, totalMicroUsd) {
  if (
    typeof totalMicroUsd !== 'number' ||
    !Number.isFinite(totalMicroUsd) ||
    totalMicroUsd <= 0
  ) {
    return null;
  }

  if (
    typeof weightedPassed !== 'number' ||
    !Number.isFinite(weightedPassed) ||
    weightedPassed < 0
  ) {
    return null;
  }

  const rawDei = (weightedPassed * 1_000_000) / totalMicroUsd;
  return Math.round(rawDei * 10_000) / 10_000;
}

/**
 * Computes SHA-256 hash for an audit event.
 */
export function computeAuditEventHash({ sequence, timestamp, eventType, payload, prevHash }) {
  const serialized = `${sequence}:${timestamp}:${eventType}:${canonicalJsonStringify(payload)}:${prevHash}`;
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * AuditEventStream: An append-only, sequence-numbered, hash-linked event stream.
 * Provides cryptographic tamper-evidence for benchmark execution runs.
 */
export class AuditEventStream {
  #events = [];
  #logPath = null;

  constructor(options = {}) {
    if (options.logPath) {
      this.#logPath = path.resolve(options.logPath);
      const dir = path.dirname(this.#logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  get events() {
    return Object.freeze([...this.#events]);
  }

  get length() {
    return this.#events.length;
  }

  /**
   * Appends an event to the hash chain.
   */
  append(eventType, payload = {}) {
    if (!eventType || typeof eventType !== 'string') {
      throw new TypeError('eventType must be a non-empty string');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new TypeError('payload must be an object');
    }

    const sequence = this.#events.length;
    const prevHash = sequence === 0
      ? GENESIS_PREV_HASH
      : this.#events[sequence - 1].hash;
    const timestamp = new Date().toISOString();

    const hash = computeAuditEventHash({
      sequence,
      timestamp,
      eventType,
      payload,
      prevHash
    });

    const event = Object.freeze({
      sequence,
      timestamp,
      eventType,
      payload,
      prevHash,
      hash
    });

    this.#events.push(event);

    if (this.#logPath) {
      fs.appendFileSync(this.#logPath, JSON.stringify(event) + '\n', 'utf-8');
    }

    return event;
  }

  /**
   * Verifies the cryptographic integrity of the event chain.
   * Returns { valid: true } or { valid: false, error: string, index: number }.
   */
  verify() {
    for (let i = 0; i < this.#events.length; i++) {
      const event = this.#events[i];
      if (event.sequence !== i) {
        return { valid: false, error: `Invalid sequence at index ${i}: expected ${i}, got ${event.sequence}`, index: i };
      }

      const expectedPrev = (i === 0) ? GENESIS_PREV_HASH : this.#events[i - 1].hash;
      if (event.prevHash !== expectedPrev) {
        return { valid: false, error: `Hash chain broken at index ${i}: invalid prevHash`, index: i };
      }

      const expectedHash = computeAuditEventHash({
        sequence: event.sequence,
        timestamp: event.timestamp,
        eventType: event.eventType,
        payload: event.payload,
        prevHash: event.prevHash
      });

      if (event.hash !== expectedHash) {
        return { valid: false, error: `Tampered event payload or hash at index ${i}`, index: i };
      }
    }

    return { valid: true };
  }

  /**
   * Returns the final cumulative audit digest representing the whole stream.
   */
  getDigest() {
    if (this.#events.length === 0) {
      return GENESIS_PREV_HASH;
    }
    return this.#events[this.#events.length - 1].hash;
  }

  /**
   * Serializes the audit stream to JSON Lines.
   */
  toJSONL() {
    return this.#events.map(ev => JSON.stringify(ev)).join('\n');
  }

  /**
   * Parses and validates an audit stream from JSON Lines string.
   */
  static fromJSONL(jsonlContent) {
    const stream = new AuditEventStream();
    if (!jsonlContent || !jsonlContent.trim()) {
      return stream;
    }

    const lines = jsonlContent.trim().split('\n').filter(l => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      stream.#events.push(Object.freeze(parsed));
    }

    const check = stream.verify();
    if (!check.valid) {
      throw new Error(`Corrupted audit stream: ${check.error}`);
    }

    return stream;
  }
}

/**
 * Builds a BatchEvaluationReport adhering to the shared schema.
 * Calculates weightedPassed, totalCostMicroUsd, and DEI.
 *
 * @param {object} params
 * @returns {import('../../src/shared/harness.js').BatchEvaluationReport}
 */
export function buildBatchEvaluationReport({
  dataset,
  attempts = [],
  taskReports = [],
  tasks = [],
  auditStream = null
}) {
  const datasetVersion = dataset || {
    datasetId: 'default-dataset',
    version: '1.0.0',
    schemaVersion: 1,
    manifestSha256: '0'.repeat(64),
    createdAt: new Date().toISOString()
  };

  // Build task weight map
  const weightMap = new Map();
  for (const t of tasks) {
    if (t && t.id) {
      weightMap.set(t.id, typeof t.weight === 'number' && t.weight > 0 ? t.weight : 1);
    }
  }

  // Calculate weighted passed
  let weightedPassed = 0;
  for (const report of taskReports) {
    if (report && report.passed) {
      // Check results or report ID
      if (Array.isArray(report.results) && report.results.length > 0) {
        for (const res of report.results) {
          if (res.passed) {
            const w = weightMap.get(res.id) ?? 1;
            weightedPassed += w;
          }
        }
      } else {
        weightedPassed += 1;
      }
    }
  }

  // Calculate total cost micro-USD
  let totalCostMicroUsd = 0;
  for (const att of attempts) {
    if (att && att.cost && typeof att.cost.totalMicroUsd === 'number') {
      totalCostMicroUsd += att.cost.totalMicroUsd;
    }
  }

  const dollarEfficiencyIndex = calculateDollarEfficiencyIndex(weightedPassed, totalCostMicroUsd);
  const auditDigest = auditStream instanceof AuditEventStream
    ? auditStream.getDigest()
    : (typeof auditStream === 'string' ? auditStream : GENESIS_PREV_HASH);

  return {
    schemaVersion: 1,
    dataset: datasetVersion,
    attempts,
    taskReports,
    weightedPassed,
    totalCostMicroUsd,
    dollarEfficiencyIndex,
    auditDigest
  };
}
