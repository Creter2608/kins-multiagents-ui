import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();

const MAX_THIN_ADAPTER_BYTES = 1024;

test("adapters: .windsurfrules is within size ceiling and points to AGENTS.md", () => {
  const filePath = path.join(REPO_ROOT, ".windsurfrules");
  assert.ok(fs.existsSync(filePath), ".windsurfrules must exist");
  const stats = fs.statSync(filePath);
  assert.ok(
    stats.size <= MAX_THIN_ADAPTER_BYTES,
    `.windsurfrules size ${stats.size}B exceeds ${MAX_THIN_ADAPTER_BYTES}B ceiling`
  );
  const content = fs.readFileSync(filePath, "utf-8");
  assert.ok(content.includes("AGENTS.md"), ".windsurfrules must reference canonical AGENTS.md");
  assert.ok(content.includes("kins_autonomous_sandbox"), ".windsurfrules must reference Docker sandbox");
});

test("adapters: .clinerules is within size ceiling and points to AGENTS.md", () => {
  const filePath = path.join(REPO_ROOT, ".clinerules");
  assert.ok(fs.existsSync(filePath), ".clinerules must exist");
  const stats = fs.statSync(filePath);
  assert.ok(
    stats.size <= MAX_THIN_ADAPTER_BYTES,
    `.clinerules size ${stats.size}B exceeds ${MAX_THIN_ADAPTER_BYTES}B ceiling`
  );
  const content = fs.readFileSync(filePath, "utf-8");
  assert.ok(content.includes("AGENTS.md"), ".clinerules must reference canonical AGENTS.md");
  assert.ok(content.includes("kins_autonomous_sandbox"), ".clinerules must reference Docker sandbox");
});

test("adapters: .roomodes is valid JSON schema with expected custom modes", () => {
  const filePath = path.join(REPO_ROOT, ".roomodes");
  assert.ok(fs.existsSync(filePath), ".roomodes must exist");
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content);
  assert.ok(Array.isArray(parsed.customModes), ".roomodes must define customModes array");
  const slugs = parsed.customModes.map((m: { slug: string }) => m.slug);
  assert.ok(slugs.includes("architect"), "Must define 'architect' mode");
  assert.ok(slugs.includes("code"), "Must define 'code' mode");
});

test("adapters: mcp.json is valid JSON with sandbox server definition", () => {
  const filePath = path.join(REPO_ROOT, "mcp.json");
  assert.ok(fs.existsSync(filePath), "mcp.json must exist");
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content);
  assert.ok(parsed.mcpServers, "mcp.json must contain mcpServers map");
  assert.ok(parsed.mcpServers.sandbox, "mcp.json must configure sandbox server");
});
