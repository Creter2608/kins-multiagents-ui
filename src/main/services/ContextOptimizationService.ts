import type {
  ContextItem,
  ContextFinding,
  ContextOptimizationReport
} from "../../shared/contextOptimization.js";
import { estimateTokens } from "../../shared/contextOptimization.js";

export interface ContextOptimizationOptions {
  readonly largeThresholdTokens?: number;
}

export class ContextOptimizationService {
  private readonly largeThresholdTokens: number;

  constructor(options: ContextOptimizationOptions = {}) {
    this.largeThresholdTokens = options.largeThresholdTokens ?? 2_500;
  }

  /**
   * Analyzes an assembled context inventory before model dispatch.
   * Pure inspection: NEVER mutates instructions, safety prompts, or request payloads.
   */
  analyze(
    items: readonly ContextItem[],
    usedToolIds: ReadonlySet<string> = new Set()
  ): ContextOptimizationReport {
    if (!items || items.length === 0) {
      return {
        totalChars: 0,
        estimatedInputTokens: 0,
        estimation: "heuristic",
        findings: [],
        avoidableTokens: 0
      };
    }

    const itemMap = new Map<string, ContextItem>();
    let totalChars = 0;
    for (const item of items) {
      itemMap.set(item.id, item);
      totalChars += item.text.length;
    }

    const estimatedInputTokens = estimateTokens(items.map((i) => i.text).join("\n"));
    const findings: ContextFinding[] = [];
    const avoidableItemIds = new Set<string>();

    // 1. Duplicate detection across context items
    const seenContentMap = new Map<string, string>(); // normalizedContent -> firstItemId
    for (const item of items) {
      const normalized = item.text.trim().toLowerCase();
      if (normalized.length === 0) continue;

      const firstId = seenContentMap.get(normalized);
      if (firstId && firstId !== item.id) {
        const itemTokens = estimateTokens(item.text);
        const avoidable = item.removable ? itemTokens : null;
        if (avoidable !== null) {
          avoidableItemIds.add(item.id);
        }

        findings.push({
          itemIds: [firstId, item.id],
          reason: "duplicate",
          severity: "warning",
          estimatedAvoidableTokens: avoidable,
          message: `Duplicate context detected: '${item.id}' duplicates content from '${firstId}'.`
        });
      } else {
        seenContentMap.set(normalized, item.id);
      }
    }

    // 2. Large context item detection (Oversized rules / instructions)
    for (const item of items) {
      const tokens = estimateTokens(item.text);
      if (tokens >= this.largeThresholdTokens) {
        // If required and not removable (e.g. mandatory AGENTS.md / host policy), avoidable is null
        const avoidable = item.removable ? tokens : null;
        if (avoidable !== null) {
          avoidableItemIds.add(item.id);
        }

        findings.push({
          itemIds: [item.id],
          reason: "large",
          severity: "warning",
          estimatedAvoidableTokens: avoidable,
          message: `Context item '${item.id}' is large (~${tokens} tokens, ${item.text.length} chars). Consider modularizing or referencing on-demand.`
        });
      }
    }

    // 3. Unused MCP tool schemas
    for (const item of items) {
      if (item.kind === "mcp-schema") {
        if (!usedToolIds.has(item.id)) {
          const tokens = estimateTokens(item.text);
          const avoidable = item.removable ? tokens : null;
          if (avoidable !== null) {
            avoidableItemIds.add(item.id);
          }

          findings.push({
            itemIds: [item.id],
            reason: "unused-tool",
            severity: "info",
            estimatedAvoidableTokens: avoidable,
            message: `MCP tool schema '${item.id}' was never invoked in this session (~${tokens} tokens). Consider lazy-loading schema.`
          });
        }
      }
    }

    // Calculate total avoidable tokens without double counting items flagged in multiple findings
    let avoidableTokens = 0;
    for (const id of avoidableItemIds) {
      const item = itemMap.get(id);
      if (item && item.removable) {
        avoidableTokens += estimateTokens(item.text);
      }
    }

    return {
      totalChars,
      estimatedInputTokens,
      estimation: "heuristic",
      findings: Object.freeze(findings),
      avoidableTokens
    };
  }
}
