import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EccCatalogService } from "../src/main/services/EccCatalogService.js";

test("ECC quarantines invisible directional marks in agent metadata", async () => {
  for (const control of ["\u200E", "\u200F"]) {
    const root = await mkdtemp(path.join(tmpdir(), "ecc-directional-mark-"));
    const service = new EccCatalogService(root);

    try {
      await mkdir(path.join(root, "agents"));
      await writeFile(
        path.join(root, "agents", "reviewer.md"),
        [
          "---",
          "name: Reviewer",
          `description: Review${control}code changes`,
          "tools: Read, Grep",
          "---",
          "Review the requested code changes."
        ].join("\n"),
        "utf8"
      );

      const snapshot = await service.refresh();
      const label = `U+${control.charCodeAt(0).toString(16).toUpperCase()}`;

      assert.equal(snapshot.assets.length, 1, `${label}: asset must be cataloged`);
      assert.equal(
        snapshot.quarantinedCount,
        1,
        `${label}: invisible metadata control must trigger quarantine`
      );
      assert.equal(
        snapshot.availableCount,
        0,
        `${label}: quarantined asset must not remain available`
      );
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("ECC quarantines directional isolates embedded in agent bodies", async () => {
  for (const control of ["\u2066", "\u2067", "\u2068", "\u2069"]) {
    const root = await mkdtemp(path.join(tmpdir(), "ecc-directional-isolate-"));
    const service = new EccCatalogService(root);

    try {
      await mkdir(path.join(root, "agents"));
      await writeFile(
        path.join(root, "agents", "reviewer.md"),
        [
          "---",
          "name: Reviewer",
          "description: Reviews code changes",
          "tools: Read, Grep",
          "---",
          `Review ${control}the requested code changes.`
        ].join("\n"),
        "utf8"
      );

      const snapshot = await service.refresh();
      const label = `U+${control.charCodeAt(0).toString(16).toUpperCase()}`;

      assert.equal(snapshot.assets.length, 1, `${label}: asset must be cataloged`);
      assert.equal(
        snapshot.quarantinedCount,
        1,
        `${label}: body control must trigger quarantine`
      );
      assert.equal(
        snapshot.availableCount,
        0,
        `${label}: quarantined asset must not remain available`
      );
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});
