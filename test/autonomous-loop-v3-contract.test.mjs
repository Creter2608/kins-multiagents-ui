import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readProjectFile(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

test("MCP server advertises Autonomous Loop v3.0 without changing the status tool name", () => {
  const source = readProjectFile("src/loop/mcp-server.ts");

  assert.match(
    source,
    /serverInfo\s*:\s*\{[\s\S]*?version\s*:\s*["']3\.0\.0["']/,
    "serverInfo.version must be exactly 3.0.0"
  );

  const toolOffset = source.indexOf("agent_loop_status");
  assert.notEqual(
    toolOffset,
    -1,
    "agent_loop_status must remain registered"
  );

  const toolDefinition = source.slice(toolOffset, toolOffset + 2_000);
  assert.match(
    toolDefinition,
    /description[\s\S]{0,500}(?:v3\.0|version\s*3\.0)/i,
    "agent_loop_status description must identify v3.0"
  );
});

test("PhaseTracker exposes every mandatory adversarial audit field", () => {
  const source = readProjectFile(
    "src/renderer/components/PhaseTracker.tsx"
  );

  assert.match(
    source,
    /Adversarial\s+Audit/i,
    "PhaseTracker must render the Adversarial Audit Card"
  );
  assert.match(
    source,
    /\baudit\b[\s\S]*?\bstatus\b|\bstatus\b[\s\S]*?\baudit\b/,
    "the audit card must consume the audit status"
  );
  assert.match(
    source,
    /\bremediationCount\b/,
    "the audit card must render remediationCount"
  );
  assert.match(
    source,
    /\bfindings\b/,
    "the audit card must render the findings count"
  );
  assert.match(
    source,
    /\bauditedTreeHash\b/,
    "the audit card must render auditedTreeHash"
  );
  assert.match(
    source,
    /findings\s*\?\.\s*length|findings\s*\?\?\s*\[\]|Array\.isArray\s*\([^)]*findings/,
    "an absent findings array must be handled without throwing"
  );
});

test("runner and normative documentation enforce bounded deterministic closure", () => {
  const runner = readProjectFile("scripts/ai-loop.mjs");
  const documentation = readProjectFile("docs/LOOP.md");

  assert.match(
    runner,
    /savedState[\s\S]{0,600}\baudit\b|\baudit\b[\s\S]{0,600}savedState/,
    "phase-transition persistence must explicitly preserve savedState.audit"
  );

  assert.match(
    documentation,
    /(?:two|2)[-\s]?(?:call|model call)/i,
    "LOOP.md must specify the two-call model bound"
  );
  assert.match(
    documentation,
    /REALITY_CHECK/i,
    "LOOP.md must identify REALITY_CHECK as the closure phase"
  );
  assert.match(
    documentation,
    /(?:no|without|must not|zero)[\s\S]{0,100}(?:third|3rd)[\s-]*(?:GPT|model)?\s*call/i,
    "LOOP.md must prohibit a third model call for closure"
  );
  assert.match(
    documentation,
    /2400\s*(?:s|seconds?)/i,
    "LOOP.md must specify the 2400-second timeout"
  );
  assert.match(
    documentation,
    /process[-\s]tree[\s\S]{0,100}(?:cleanup|termination|kill)/i,
    "LOOP.md must require deterministic process-tree cleanup"
  );
});
