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

export interface PitfallPathOptions {
  readonly explicitPath?: string;
  readonly targetProjectRoot?: string;
  readonly appRoot?: string;
}

export interface MatchPitfallOptions {
  readonly maxResults?: number;
  readonly tokenBudget?: number;
  readonly catalogPath?: string | PitfallPathOptions;
  readonly targetProjectRoot?: string;
  readonly appRoot?: string;
}

export function resolvePitfallsPath(options?: PitfallPathOptions): string | null;
export function parsePitfallsCatalog(customPathOrOptions?: string | PitfallPathOptions): PitfallCatalogEntry[];
export function matchPitfalls(
  input: string | readonly string[],
  options?: MatchPitfallOptions
): PitfallMatchResult;

