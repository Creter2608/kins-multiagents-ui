import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EccCatalogService } from "../src/main/services/EccCatalogService.js";

test("ECC rejects same-size mutation after catalog creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-integrity-"));
  const service = new EccCatalogService(root);

  try {
    const agents = path.join(root, "agents");
    fs.mkdirSync(agents);
    const assetPath = path.join(agents, "worker.md");
    const original =
      "---\nname: Worker\ndescription: Safe worker\n---\nBody Alpha";
    const modified = original.replace("Alpha", "Bravo");

    assert.equal(Buffer.byteLength(original), Buffer.byteLength(modified));
    fs.writeFileSync(assetPath, original);

    const snapshot = await service.getSnapshot();
    const asset = snapshot.assets.find((entry) => entry.id === "agent:worker");
    assert.ok(asset);
    assert.equal(asset.status, "available");

    // Preserve size and timestamps: integrity must depend on current bytes,
    // not merely cached metadata.
    const before = fs.statSync(assetPath);
    fs.writeFileSync(assetPath, modified);
    fs.utimesSync(assetPath, before.atime, before.mtime);

    await assert.rejects(
      () => service.loadSelected(snapshot.revision, asset.id, [])
    );
  } finally {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ECC quarantines escaped symlinks and rejects post-scan symlink replacement", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-containment-"));
  const root = path.join(fixture, "catalog");
  const agents = path.join(root, "agents");
  const external = path.join(fixture, "external.md");
  const content =
    "---\nname: Worker\ndescription: Safe worker\n---\nIdentical bytes";

  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(external, content);
  try {
    fs.symlinkSync(external, path.join(agents, "escaped.md"));
  } catch {
    // Windows might require elevated privileges for symlinks, fallback if privilege not granted
    return;
  }
  fs.writeFileSync(path.join(agents, "worker.md"), content);

  const service = new EccCatalogService(root);
  try {
    const snapshot = await service.getSnapshot();

    const escaped = snapshot.assets.find(
      (entry) => entry.id === "agent:escaped"
    );
    assert.ok(escaped, "Escaped symlink must have a quarantined catalog entry");
    assert.equal(escaped.status, "quarantined");
    await assert.rejects(
      () => service.loadSelected(snapshot.revision, escaped.id, [])
    );

    const worker = snapshot.assets.find(
      (entry) => entry.id === "agent:worker"
    );
    assert.ok(worker);
    assert.equal(worker.status, "available");

    const workerPath = path.join(agents, "worker.md");
    fs.unlinkSync(workerPath);
    fs.symlinkSync(external, workerPath);

    // External bytes deliberately match the catalog hash. A digest check
    // alone cannot enforce source-root containment.
    await assert.rejects(
      () => service.loadSelected(snapshot.revision, worker.id, [])
    );
  } finally {
    service.dispose();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ECC enforces the exact size boundary and every specified text quarantine marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-boundaries-"));
  const service = new EccCatalogService(root);

  try {
    const agents = path.join(root, "agents");
    fs.mkdirSync(agents);

    const limit = 512 * 1024;
    const header = Buffer.from(
      "---\nname: Boundary\ndescription: Safe boundary\n---\n"
    );
    const exact = Buffer.alloc(limit, "A");
    header.copy(exact);
    fs.writeFileSync(path.join(agents, "exact.md"), exact);
    fs.writeFileSync(
      path.join(agents, "over.md"),
      Buffer.concat([exact, Buffer.from("A")])
    );

    const markers = [
      "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF",
      "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
      "<script>alert(1)</script>",
      "data:text/html,<h1>untrusted</h1>"
    ];

    markers.forEach((marker, index) => {
      fs.writeFileSync(
        path.join(agents, `unsafe-${index}.md`),
        "---\nname: Unsafe\ndescription: Marker fixture\n---\n" + marker
      );
    });

    const snapshot = await service.getSnapshot();
    const exactAsset = snapshot.assets.find(
      (entry) => entry.id === "agent:exact"
    );
    const oversized = snapshot.assets.find(
      (entry) => entry.id === "agent:over"
    );

    assert.ok(exactAsset);
    assert.equal(exactAsset.status, "available");
    assert.ok(oversized);
    assert.equal(oversized.status, "quarantined");

    for (let index = 0; index < markers.length; index++) {
      const asset = snapshot.assets.find(
        (entry) => entry.id === `agent:unsafe-${index}`
      );
      assert.ok(asset);
      assert.equal(asset.status, "quarantined", `Marker index ${index}`);
      await assert.rejects(
        () => service.loadSelected(snapshot.revision, asset.id, [])
      );
    }
  } finally {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
