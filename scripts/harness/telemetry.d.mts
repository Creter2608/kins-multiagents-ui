import type {
  TokenUsage,
  CostAttribution,
  DatasetVersion,
  WorkerAttempt,
  EvaluationReport,
  BenchmarkTask,
  BatchEvaluationReport
} from '../../src/shared/harness.js';

export interface PricingModelRates {
  readonly provider: string;
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  readonly cacheReadMicroUsdPerMillion?: number | undefined;
  readonly cacheWriteMicroUsdPerMillion?: number | undefined;
}

export interface PricingCatalog {
  readonly version: string;
  readonly currency: "USD";
  readonly updatedAt: string;
  readonly models: Readonly<Record<string, PricingModelRates>>;
}

export interface CalculateCostOptions {
  readonly catalog?: PricingCatalog | string | undefined;
  readonly surchargeMicroUsd?: number | undefined;
  readonly customRates?: PricingModelRates | undefined;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditVerificationResult {
  readonly valid: boolean;
  readonly error?: string | undefined;
  readonly index?: number | undefined;
}

export function canonicalJsonStringify(value: unknown): string;

export function normalizeTokenUsage(
  rawUsage: unknown,
  source?: "provider" | "gateway" | "unavailable"
): TokenUsage;

export function loadPricingCatalog(
  catalogPathOrObject?: string | PricingCatalog | Record<string, unknown>
): PricingCatalog;

export function calculateCostAttribution(
  tokenUsage: unknown,
  modelId: string,
  options?: CalculateCostOptions
): CostAttribution;

export function calculateDollarEfficiencyIndex(
  weightedPassed: number,
  totalMicroUsd: number
): number | null;

export function computeAuditEventHash(event: {
  readonly sequence: number;
  readonly timestamp: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly prevHash: string;
}): string;

export class AuditEventStream {
  constructor(options?: { logPath?: string | undefined });
  get events(): readonly AuditEvent[];
  get length(): number;
  append(eventType: string, payload?: Record<string, unknown>): AuditEvent;
  verify(): AuditVerificationResult;
  getDigest(): string;
  toJSONL(): string;
  static fromJSONL(jsonlContent: string): AuditEventStream;
}

export interface BuildBatchReportParams {
  readonly dataset?: DatasetVersion | undefined;
  readonly attempts?: readonly WorkerAttempt[] | undefined;
  readonly taskReports?: readonly EvaluationReport[] | undefined;
  readonly tasks?: readonly BenchmarkTask[] | undefined;
  readonly auditStream?: AuditEventStream | string | null | undefined;
}

export function buildBatchEvaluationReport(params: BuildBatchReportParams): BatchEvaluationReport;
