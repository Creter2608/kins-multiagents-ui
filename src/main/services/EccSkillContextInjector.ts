import type { EccSkillOptimizationMetrics } from "../../shared/eccContracts.js";

export const DEFAULT_MAX_TOTAL_SKILL_BYTES = 16 * 1024; // 16 KiB (~4,000 tokens)
export const DEFAULT_MAX_PER_SKILL_BYTES = 4 * 1024;   // 4 KiB (~1,000 tokens)

export interface EccSkillInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly content: string;
}

export interface EccSkillInjectorOptions {
  readonly maxTotalSkillBytes?: number;
  readonly maxPerSkillBytes?: number;
}

export interface InjectedSkillResult {
  readonly synthesizedMarkdown: string;
  readonly metrics: EccSkillOptimizationMetrics;
}

const TRUNCATION_NOTICE = "\n\n[TRUNCATED: SKILL_BUDGET_REACHED]";
const TRUNCATION_NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");

/**
 * Safely slices a UTF-8 buffer up to maxBytes without cutting through multibyte character sequences.
 * Prevents replacement character (U+FFFD) corruption when truncating UTF-8 content.
 */
function sliceUtf8Safe(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (buf.length <= maxBytes) return buf.toString("utf8");

  let end = maxBytes;
  let i = end - 1;
  while (i >= 0 && ((buf[i] ?? 0) & 0xc0) === 0x80) {
    i--;
  }
  if (i >= 0) {
    const lead = buf[i];
    if (lead !== undefined) {
      let expectedLen = 1;
      if ((lead & 0x80) === 0) expectedLen = 1;
      else if ((lead & 0xe0) === 0xc0) expectedLen = 2;
      else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
      else if ((lead & 0xf8) === 0xf0) expectedLen = 4;

      if (i + expectedLen > end) {
        end = i;
      }
    }
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Service that optimizes, trims, and packs attached capability skills into subagent execution context.
 * Strictly bounds emitted context within configured byte limits to prevent token drain.
 */
export class EccSkillContextInjector {
  private readonly maxTotalSkillBytes: number;
  private readonly maxPerSkillBytes: number;

  constructor(options?: EccSkillInjectorOptions) {
    this.maxTotalSkillBytes = options?.maxTotalSkillBytes ?? DEFAULT_MAX_TOTAL_SKILL_BYTES;
    this.maxPerSkillBytes = options?.maxPerSkillBytes ?? DEFAULT_MAX_PER_SKILL_BYTES;
  }

  /**
   * Compacts a single skill's markdown content, stripping boilerplate and truncating if over budget.
   * If perSkillLimitOverride is provided, it supersedes the constructor default.
   */
  compactSkill(
    skill: EccSkillInput,
    budgetBytes: number,
    perSkillLimitOverride?: number
  ): { readonly text: string; readonly originalBytes: number; readonly compactedBytes: number; readonly truncated: boolean } {
    const raw = skill.content;
    const originalBytes = Buffer.byteLength(raw, "utf8");

    // 1. Strip YAML frontmatter
    let text = this.stripFrontmatter(raw);

    // 2. Strip HTML comments, badges (inline + reference), and images (inline + reference)
    text = this.stripCommentsAndBadges(text);

    // 3. Compact whitespace
    text = this.compactWhitespace(text);

    let truncated = false;
    const perSkillCap = perSkillLimitOverride ?? this.maxPerSkillBytes;
    const effectiveLimit = Math.min(budgetBytes, perSkillCap);

    // 4. Truncate gracefully if over allocated budget
    if (Buffer.byteLength(text, "utf8") > effectiveLimit) {
      text = this.truncateToBudget(text, effectiveLimit);
      truncated = true;
    }

    const compactedBytes = Buffer.byteLength(text, "utf8");

    return {
      text,
      originalBytes,
      compactedBytes,
      truncated
    };
  }

  /**
   * Injects, compacts, and budget-packs multiple skills into a cohesive markdown document section.
   * Strictly bounds total output size to totalLimit.
   */
  injectAndOptimizeSkills(
    skills: readonly EccSkillInput[],
    overrides?: EccSkillInjectorOptions
  ): InjectedSkillResult {
    if (skills.length === 0) {
      return {
        synthesizedMarkdown: "",
        metrics: {
          originalBytes: 0,
          compactedBytes: 0,
          savingsRatio: 0,
          includedSkillCount: 0,
          truncatedSkillCount: 0
        }
      };
    }

    const totalLimit = overrides?.maxTotalSkillBytes ?? this.maxTotalSkillBytes;
    const perSkillLimit = overrides?.maxPerSkillBytes ?? this.maxPerSkillBytes;

    const envelopeHeader = "## Injected Capability Skills:\n\n";
    const envelopeHeaderBytes = Buffer.byteLength(envelopeHeader, "utf8");

    // When totalLimit is large (>= 500), reserve envelope and metadata overhead so total emitted markdown stays <= totalLimit
    const isStrictEnvelopeBudget = totalLimit >= 500;
    const METADATA_TAG_RESERVE = isStrictEnvelopeBudget ? 120 : 0;
    const headerReserve = isStrictEnvelopeBudget ? envelopeHeaderBytes : 0;

    let remainingBudget = Math.max(0, totalLimit - headerReserve - METADATA_TAG_RESERVE);

    let totalOriginalBytes = 0;
    let totalCompactedSkillBytes = 0;
    let truncatedCount = 0;
    const skillSections: string[] = [];

    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i]!;
      const origBytes = Buffer.byteLength(skill.content, "utf8");
      totalOriginalBytes += origBytes;

      const sepBytes = skillSections.length > 0 ? 2 : 0;
      const headerText = `### Skill: ${skill.name}${skill.description ? `\n> ${skill.description}` : ""}\n\n`;
      const headerBytes = isStrictEnvelopeBudget ? Buffer.byteLength(headerText, "utf8") : 0;

      // Reserve headroom for at least one summary card for subsequent skills if any remain
      const hasSubsequent = i < skills.length - 1;
      const subsequentReserve = (isStrictEnvelopeBudget && hasSubsequent) ? 90 : 0;

      const minRequiredForFull = sepBytes + headerBytes + 50 + subsequentReserve;

      if (remainingBudget > minRequiredForFull) {
        const bodyBudget = Math.min(perSkillLimit, remainingBudget - sepBytes - headerBytes - subsequentReserve);
        const compacted = this.compactSkill(skill, bodyBudget, perSkillLimit);

        const section = `${headerText.trimEnd()}\n\n${compacted.text}`;
        const sectionBytes = isStrictEnvelopeBudget ? Buffer.byteLength(section, "utf8") : compacted.compactedBytes;

        skillSections.push(section);
        totalCompactedSkillBytes += compacted.compactedBytes;
        remainingBudget = Math.max(0, remainingBudget - (sepBytes + sectionBytes));

        if (compacted.truncated) {
          truncatedCount++;
        }
        continue;
      }

      // Context budget cannot fit detailed instructions. Try fallback reference card.
      truncatedCount++;
      const fullFallback = `### Skill: ${skill.name}\n\n*[SUMMARY ONLY: Context budget exhausted for detailed instructions. Description: ${skill.description || skill.name}]*`;
      const fullFallbackBytes = Buffer.byteLength(fullFallback, "utf8");

      const compactFallback = `### Skill: ${skill.name}\n\n*[SUMMARY ONLY: ${skill.description || skill.name}]*`;
      const compactFallbackBytes = Buffer.byteLength(compactFallback, "utf8");

      const minFallback = `### Skill: ${skill.name}\n\n*[SUMMARY ONLY]*`;
      const minFallbackBytes = Buffer.byteLength(minFallback, "utf8");

      if (!isStrictEnvelopeBudget || remainingBudget >= sepBytes + fullFallbackBytes) {
        skillSections.push(fullFallback);
        totalCompactedSkillBytes += fullFallbackBytes;
        if (isStrictEnvelopeBudget) remainingBudget -= (sepBytes + fullFallbackBytes);
      } else if (remainingBudget >= sepBytes + compactFallbackBytes) {
        skillSections.push(compactFallback);
        totalCompactedSkillBytes += compactFallbackBytes;
        remainingBudget -= (sepBytes + compactFallbackBytes);
      } else if (remainingBudget >= sepBytes + minFallbackBytes) {
        skillSections.push(minFallback);
        totalCompactedSkillBytes += minFallbackBytes;
        remainingBudget -= (sepBytes + minFallbackBytes);
      }
    }

    const savingsRatio = totalOriginalBytes > 0
      ? Math.max(0, Math.round(((totalOriginalBytes - totalCompactedSkillBytes) / totalOriginalBytes) * 100) / 100)
      : 0;

    const savingsPct = (savingsRatio * 100).toFixed(1);
    const metadataTag = `<!-- ECC_SKILL_OPTIMIZATION: included=${skills.length}, truncated=${truncatedCount}, orig_bytes=${totalOriginalBytes}, comp_bytes=${totalCompactedSkillBytes}, savings=${savingsPct}% -->`;

    let synthesizedMarkdown = [
      "## Injected Capability Skills:",
      metadataTag,
      ...skillSections
    ].join("\n\n");

    if (isStrictEnvelopeBudget && Buffer.byteLength(synthesizedMarkdown, "utf8") > totalLimit) {
      synthesizedMarkdown = sliceUtf8Safe(Buffer.from(synthesizedMarkdown, "utf8"), totalLimit);
    }

    return {
      synthesizedMarkdown,
      metrics: {
        originalBytes: totalOriginalBytes,
        compactedBytes: totalCompactedSkillBytes,
        savingsRatio,
        includedSkillCount: skills.length,
        truncatedSkillCount: truncatedCount
      }
    };
  }

  private stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) {
      return content;
    }
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) {
      return content;
    }
    return content.slice(endIdx + 4).trim();
  }

  private stripCommentsAndBadges(content: string): string {
    return content
      // Strip HTML comments <!-- ... -->
      .replace(/<!--[\s\S]*?-->/g, "")
      // Strip linked badges: [![...](...)](...) or [![...][...]](...) or [![...][...]][...]
      .replace(/\[!\[[\s\S]*?\](?:\([^)]*\)|\[[^\]]*\])?\](?:\([^)]*\)|\[[^\]]*\])?/g, "")
      // Strip images: inline ![alt](url), ref full ![alt][ref], ref collapsed ![alt][], shortcut ![alt]
      .replace(/!\[[\s\S]*?\](?:\([^)]*\)|\[[^\]]*\])?/g, "");
  }

  private compactWhitespace(content: string): string {
    return content
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private truncateToBudget(content: string, limitBytes: number): string {
    if (limitBytes <= 0) return "";

    const buf = Buffer.from(content, "utf8");
    if (buf.length <= limitBytes) {
      return content;
    }

    if (limitBytes < TRUNCATION_NOTICE_BYTES) {
      // Small limit where full notice cannot fit: provide minimal notice or slice safely
      const miniNotice = "[TRUNCATED]";
      if (limitBytes >= Buffer.byteLength(miniNotice, "utf8")) {
        return miniNotice;
      }
      return sliceUtf8Safe(buf, limitBytes);
    }

    const targetBodyBytes = limitBytes - TRUNCATION_NOTICE_BYTES;
    if (targetBodyBytes <= 0) {
      return TRUNCATION_NOTICE.trim();
    }

    let sliced = sliceUtf8Safe(buf, targetBodyBytes);
    const lastParagraph = sliced.lastIndexOf("\n\n");
    if (lastParagraph > 20) {
      sliced = sliced.slice(0, lastParagraph);
    } else {
      const lastLine = sliced.lastIndexOf("\n");
      if (lastLine > 20) {
        sliced = sliced.slice(0, lastLine);
      }
    }

    const trimmedBody = sliced.trim();
    return trimmedBody ? `${trimmedBody}${TRUNCATION_NOTICE}` : TRUNCATION_NOTICE.trim();
  }
}
