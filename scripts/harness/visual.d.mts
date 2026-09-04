export interface CanonicalizeHtmlOptions {
  readonly ignoredAttributes?: readonly string[] | undefined;
}

export interface DomDiff {
  readonly type: string;
  readonly message: string;
}

export interface DomComparisonResult {
  readonly match: boolean;
  readonly similarity: number;
  readonly diffs: readonly DomDiff[];
}

export interface PixelComparisonOptions {
  readonly threshold?: number | undefined;
  readonly maxDiffPercentage?: number | undefined;
  readonly generateDiffImage?: boolean | undefined;
  readonly channels?: number | undefined;
}

export interface PixelComparisonResult {
  readonly match: boolean;
  readonly totalPixels: number;
  readonly diffPixels: number;
  readonly diffPercentage: number;
  readonly diffBuffer?: Buffer | undefined;
}

export interface CockpitMetricsExpectation {
  readonly passAt1?: number | undefined;
  readonly ssi?: number | undefined;
  readonly dei?: number | undefined;
  readonly totalCostMicroUsd?: number | undefined;
}

export interface CockpitHudAssertionResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface TabSwitchAssertionResult {
  readonly switched: boolean;
  readonly activeTab: string | null;
  readonly errors: readonly string[];
}

export function canonicalizeHtml(html: string, options?: CanonicalizeHtmlOptions): string;

export function compareDomSnapshots(
  baselineHtml: string,
  candidateHtml: string,
  options?: CanonicalizeHtmlOptions
): DomComparisonResult;

export function createPpmImage(
  width: number,
  height: number,
  rgb?: readonly [number, number, number]
): Buffer;

export function parsePpmImage(buffer: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly maxVal: number;
  readonly data: Buffer;
};

export function comparePixelBuffers(
  imgA: Buffer | { readonly width: number; readonly height: number; readonly data: Buffer },
  imgB: Buffer | { readonly width: number; readonly height: number; readonly data: Buffer },
  options?: PixelComparisonOptions
): PixelComparisonResult;

export function assertCockpitHudSnapshot(
  htmlSnapshot: string,
  expectedMetrics: CockpitMetricsExpectation
): CockpitHudAssertionResult;

export function assertTabSwitching(
  beforeSnapshot: string,
  afterSnapshot: string,
  expectedActiveTab: string
): TabSwitchAssertionResult;
