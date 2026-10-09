import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  EccCatalogService,
  MAX_ASSET_FILE_BYTES
} from "../src/main/services/EccCatalogService.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test("ecc-catalog: Assertion 1 - indexing valid agents and skills with frontmatter and digest", async () => {
  const tmpDir = createTempDir("ecc-test-index-");
  try {
    const agentsDir = path.join(tmpDir, "agents");
    const skillsDir = path.join(tmpDir, "skills", "test-skill");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create an agent markdown
    fs.writeFileSync(
      path.join(agentsDir, "architect.md"),
      `---
name: Architect
description: System architecture reviewer
model: claude-3-opus
tools: read_file, git_status
category: Architecture
---
# Architect Prompt
Design robust distributed systems.`,
      "utf8"
    );

    // Create a skill markdown
    fs.writeFileSync(
      path.join(skillsDir, "SKILL.md"),
      `---
name: Database Tuning
description: PostgreSQL indexing and query plan optimization
---
# Skill Guide
Analyze query plans and add composite indexes.`,
      "utf8"
    );

    const service = new EccCatalogService(tmpDir);
    const snapshot = await service.getSnapshot();

    assert.equal(snapshot.assets.length, 2);
    assert.equal(snapshot.availableCount, 2);
    assert.equal(snapshot.quarantinedCount, 0);

    const agent = snapshot.assets.find((a) => a.kind === "agent");
    assert.ok(agent);
    assert.equal(agent.id, "agent:architect");
    assert.equal(agent.name, "Architect");
    assert.equal(agent.description, "System architecture reviewer");
    assert.equal(agent.model, "claude-3-opus");
    assert.deepEqual(agent.tools, ["read_file", "git_status"]);
    assert.equal(agent.category, "Architecture");
    assert.equal(agent.status, "available");
    assert.ok(agent.sha256.length === 64);

    const skill = snapshot.assets.find((a) => a.kind === "skill");
    assert.ok(skill);
    assert.equal(skill.id, "skill:test-skill");
    assert.equal(skill.name, "Database Tuning");
    assert.equal(skill.description, "PostgreSQL indexing and query plan optimization");
    assert.equal(skill.status, "available");
    assert.ok(skill.sha256.length === 64);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("ecc-catalog: Assertion 2 - deterministic revision hash and snapshot caching", async () => {
  const tmpDir = createTempDir("ecc-test-rev-");
  try {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentsDir, "agent-a.md"),
      `---\nname: Alpha\ndescription: Alpha agent\n---\nBody Alpha`,
      "utf8"
    );

    const service = new EccCatalogService(tmpDir);
    const snap1 = await service.getSnapshot();
    const snap2 = await service.getSnapshot();

    // Must return cached snapshot reference
    assert.equal(snap1, snap2);
    assert.ok(snap1.revision.length === 64);

    // Refresh returns fresh snapshot with identical revision
    const refreshed = await service.refresh();
    assert.equal(refreshed.revision, snap1.revision);
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("ecc-catalog: Assertion 3 - quarantining oversized files, invisible unicode, and script injection", async () => {
  const tmpDir = createTempDir("ecc-test-quarantine-");
  try {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    // 1. Oversized file
    const oversizedPath = path.join(agentsDir, "huge.md");
    const largeContent = Buffer.alloc(MAX_ASSET_FILE_BYTES + 1024, "A");
    fs.writeFileSync(oversizedPath, largeContent);

    // 2. Invisible Unicode character
    const unicodePath = path.join(agentsDir, "hidden-unicode.md");
    const hiddenText = `---\nname: Unicode Agent\ndescription: Safe desc\n---\nNormal text\u200Bhidden zero-width`;
    fs.writeFileSync(unicodePath, hiddenText, "utf8");

    // 3. Script injection attempt in frontmatter description
    const scriptPath = path.join(agentsDir, "xss.md");
    const scriptText = `---\nname: XSS Agent\ndescription: <script>alert(1)</script>\n---\nHarmless body`;
    fs.writeFileSync(scriptPath, scriptText, "utf8");

    const service = new EccCatalogService(tmpDir);
    const snapshot = await service.getSnapshot();

    assert.equal(snapshot.assets.length, 3);
    assert.equal(snapshot.availableCount, 0);
    assert.equal(snapshot.quarantinedCount, 3);

    const huge = snapshot.assets.find((a) => a.id === "agent:huge");
    assert.ok(huge);
    assert.equal(huge.status, "quarantined");
    assert.ok(huge.reasons.some((r) => r.includes("FILE_SIZE_LIMIT_EXCEEDED")));

    const hidden = snapshot.assets.find((a) => a.id === "agent:hidden-unicode");
    assert.ok(hidden);
    assert.equal(hidden.status, "quarantined");
    assert.ok(hidden.reasons.some((r) => r.includes("SUSPICIOUS_UNICODE_DETECTED")));

    const xss = snapshot.assets.find((a) => a.id === "agent:xss");
    assert.ok(xss);
    assert.equal(xss.status, "quarantined");
    assert.ok(xss.reasons.some((r) => r.includes("SUSPICIOUS_PAYLOAD_DETECTED")));
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("ecc-catalog: Assertion 4 - loadSelected integrity check and quarantine rejection", async () => {
  const tmpDir = createTempDir("ecc-test-load-");
  try {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    const validContent = `---\nname: Safe Worker\ndescription: Safe description\n---\n# Worker Body`;
    fs.writeFileSync(path.join(agentsDir, "safe.md"), validContent, "utf8");

    const unsafeContent = `---\nname: Bad Worker\ndescription: Bad\n---\nBad text\u200B`;
    fs.writeFileSync(path.join(agentsDir, "unsafe.md"), unsafeContent, "utf8");

    const service = new EccCatalogService(tmpDir);
    const snapshot = await service.getSnapshot();

    const safeAsset = snapshot.assets.find((a) => a.id === "agent:safe");
    assert.ok(safeAsset);

    // 1. Success load with matching revision
    const loaded = await service.loadSelected(snapshot.revision, safeAsset.id, []);
    assert.equal(loaded.length, 1);
    const firstLoaded = loaded[0];
    assert.ok(firstLoaded);
    assert.equal(firstLoaded.summary.id, safeAsset.id);
    assert.equal(firstLoaded.content, validContent);

    // 2. Reject stale revision
    await assert.rejects(
      async () => {
        await service.loadSelected("0000000000000000000000000000000000000000000000000000000000000000", safeAsset.id, []);
      },
      /STALE_CATALOG_REVISION/
    );

    // 3. Reject loading quarantined asset
    const unsafeAsset = snapshot.assets.find((a) => a.id === "agent:unsafe");
    assert.ok(unsafeAsset);
    await assert.rejects(
      async () => {
        await service.loadSelected(snapshot.revision, unsafeAsset.id, []);
      },
      /ASSET_QUARANTINED/
    );

    // 4. Reject non-existent asset
    await assert.rejects(
      async () => {
        await service.loadSelected(snapshot.revision, "agent:unknown", []);
      },
      /ASSET_NOT_FOUND/
    );
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("ecc-catalog: Assertion 5 - non-existent source root graceful handling", async () => {
  const nonExistentPath = path.join(os.tmpdir(), "ecc-non-existent-" + Date.now());
  const service = new EccCatalogService(nonExistentPath);

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.assets.length, 0);
  assert.equal(snapshot.availableCount, 0);
  assert.equal(snapshot.quarantinedCount, 0);
  assert.ok(snapshot.diagnostics.length > 0);
  const firstDiag = snapshot.diagnostics[0];
  assert.ok(firstDiag && firstDiag.includes("does not exist"));
});
