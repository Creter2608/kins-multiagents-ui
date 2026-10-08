import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ContextOptimizationService } from "../src/main/services/ContextOptimizationService.js";
import type { ContextItem } from "../src/shared/contextOptimization.js";
import { estimateTokens } from "../src/shared/contextOptimization.js";

test("Golden Assertion 3: Required oversized AGENTS.md -> Warning; request unchanged", () => {
  const optimizer = new ContextOptimizationService({ largeThresholdTokens: 500 });

  // 12,000 characters (~3,000 tokens) of mandatory architectural instructions
  const largeAgentsMdContent = "# AGENTS.md Corporate Guidelines\n" + "Mandatory rule line.\n".repeat(500);

  const items: readonly ContextItem[] = [
    {
      id: "AGENTS.md",
      kind: "instructions",
      text: largeAgentsMdContent,
      required: true,
      removable: false,
      origin: "repository-root/AGENTS.md"
    }
  ];

  const report = optimizer.analyze(items, new Set());

  // Invariant 1: Warning emitted for large size
  const largeFinding = report.findings.find((f) => f.reason === "large");
  assert.ok(largeFinding, "Must produce a large context finding");
  assert.equal(largeFinding.severity, "warning");
  assert.equal(largeFinding.itemIds[0], "AGENTS.md");

  // Invariant 2: Because it is required & non-removable, avoidable tokens is null
  assert.equal(largeFinding.estimatedAvoidableTokens, null);
  assert.equal(report.avoidableTokens, 0);

  // Invariant 3: Request is unchanged (input item text is completely unmutated)
  assert.equal(items[0]?.text, largeAgentsMdContent);
  assert.equal(items.length, 1);
});

test("ContextOptimizationService: detects duplicate context blocks and flags avoidable tokens", () => {
  const optimizer = new ContextOptimizationService();

  const sharedGuideline = "Always run tests before pushing code to main.";

  const items: readonly ContextItem[] = [
    {
      id: "global-rules",
      kind: "instructions",
      text: sharedGuideline,
      required: true,
      removable: false
    },
    {
      id: "redundant-project-rule",
      kind: "instructions",
      text: sharedGuideline,
      required: false,
      removable: true
    }
  ];

  const report = optimizer.analyze(items, new Set());

  const duplicateFinding = report.findings.find((f) => f.reason === "duplicate");
  assert.ok(duplicateFinding);
  assert.equal(duplicateFinding.severity, "warning");
  assert.deepEqual(duplicateFinding.itemIds, ["global-rules", "redundant-project-rule"]);
  assert.ok(duplicateFinding.estimatedAvoidableTokens !== null && duplicateFinding.estimatedAvoidableTokens > 0);
  assert.equal(report.avoidableTokens, duplicateFinding.estimatedAvoidableTokens);
});

test("ContextOptimizationService: detects unused MCP tool schemas against session tool calls", () => {
  const optimizer = new ContextOptimizationService();

  const items: readonly ContextItem[] = [
    {
      id: "codegraph_explore",
      kind: "mcp-schema",
      text: JSON.stringify({ name: "codegraph_explore", description: "explore AST symbols" }),
      required: false,
      removable: true
    },
    {
      id: "unused_weather_mcp",
      kind: "mcp-schema",
      text: JSON.stringify({ name: "unused_weather_mcp", description: "get weather forecast" }),
      required: false,
      removable: true
    }
  ];

  // In this session, only 'codegraph_explore' was invoked
  const usedTools = new Set(["codegraph_explore"]);

  const report = optimizer.analyze(items, usedTools);

  const unusedFinding = report.findings.find((f) => f.reason === "unused-tool");
  assert.ok(unusedFinding, "Must flag unused weather tool schema");
  assert.equal(unusedFinding.itemIds[0], "unused_weather_mcp");
  assert.equal(unusedFinding.severity, "info");

  // Used tool should NOT be flagged
  const usedFinding = report.findings.find((f) => f.itemIds.includes("codegraph_explore"));
  assert.equal(usedFinding, undefined);
});

test("ContextOptimizationService: prevents double-counting when item triggers multiple findings", () => {
  const optimizer = new ContextOptimizationService({ largeThresholdTokens: 100 });

  const largeDuplicateText = "Extremely long instruction text. ".repeat(50);
  const expectedItemTokens = estimateTokens(largeDuplicateText);

  const items: readonly ContextItem[] = [
    {
      id: "original-large",
      kind: "instructions",
      text: largeDuplicateText,
      required: true,
      removable: false
    },
    {
      id: "copy-large-removable",
      kind: "instructions",
      text: largeDuplicateText,
      required: false,
      removable: true
    }
  ];

  const report = optimizer.analyze(items, new Set());

  // 'copy-large-removable' triggers both 'duplicate' and 'large'
  const duplicate = report.findings.find((f) => f.reason === "duplicate" && f.itemIds.includes("copy-large-removable"));
  const large = report.findings.find((f) => f.reason === "large" && f.itemIds.includes("copy-large-removable"));

  assert.ok(duplicate);
  assert.ok(large);

  // Avoidable tokens must be counted exactly ONCE, never 2x expectedItemTokens
  assert.equal(report.avoidableTokens, expectedItemTokens);
});

test("ContextOptimizationService: handles empty and clean context gracefully", () => {
  const optimizer = new ContextOptimizationService();

  const emptyReport = optimizer.analyze([]);
  assert.equal(emptyReport.totalChars, 0);
  assert.equal(emptyReport.estimatedInputTokens, 0);
  assert.equal(emptyReport.findings.length, 0);
  assert.equal(emptyReport.avoidableTokens, 0);

  const cleanReport = optimizer.analyze([
    {
      id: "clean-spec",
      kind: "instructions",
      text: "Implement feature A cleanly.",
      required: true,
      removable: false
    }
  ]);
  assert.ok(cleanReport.totalChars > 0);
  assert.equal(cleanReport.findings.length, 0);
  assert.equal(cleanReport.avoidableTokens, 0);
});
