export interface PitfallCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly errorClass: string;
  readonly symptom: string;
  readonly invariant: string;
  readonly tokens: ReadonlySet<string>;
}

export interface PitfallMatchItem {
  readonly id: string;
  readonly score: number;
  readonly name: string;
  readonly invariant: string;
}

export interface PitfallMatchResult {
  readonly matches: readonly PitfallMatchItem[];
  readonly markdown: string;
  readonly tokenEstimate: number;
}

export interface MatchPitfallOptions {
  readonly maxResults?: number;
  readonly tokenBudget?: number;
  readonly catalogPath?: string;
}

export function parsePitfallsCatalog(customPath?: string): PitfallCatalogEntry[];
export function matchPitfalls(
  input: string | readonly string[],
  options?: MatchPitfallOptions
): PitfallMatchResult;
