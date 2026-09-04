import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const VISUAL_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'visual.mjs')).href;
const SANDBOX_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'harness', 'sandbox.mjs')).href;

const {
  canonicalizeHtml,
  compareDomSnapshots,
  createPpmImage,
  parsePpmImage,
  comparePixelBuffers,
  assertCockpitHudSnapshot,
  assertTabSwitching
} = await import(VISUAL_URL) as typeof import('../scripts/harness/visual.d.mts');

const {
  getSandboxConfig,
  buildDockerRunArgs
} = await import(SANDBOX_URL) as typeof import('../scripts/harness/sandbox.d.mts');

test('visual: canonicalizeHtml removes comments, collapses whitespace, and sorts attributes alphabetically', () => {
  const inputHtml = `
    <!-- header comment -->
    <div   id="root"   class="container active"   data-role="main" >
      <button   type="submit"   id="submit-btn"   class="btn btn-primary" >
        Click Me
      </button>
    </div>
  `;

  const canonical = canonicalizeHtml(inputHtml);

  // Comments removed and tags collapsed
  assert.ok(!canonical.includes('header comment'));
  assert.ok(!canonical.includes('> <'));

  // Attributes sorted alphabetically: class, data-role, id
  assert.ok(canonical.includes('<div class="container active" data-role="main" id="root">'));
  // Attributes sorted alphabetically: class, id, type
  assert.ok(canonical.includes('<button class="btn btn-primary" id="submit-btn" type="submit">'));

  // Ignored volatile attributes
  const withIgnored = canonicalizeHtml('<div data-reactid="1.0" class="card"></div>', {
    ignoredAttributes: ['data-reactid']
  });
  assert.strictEqual(withIgnored, '<div class="card"></div>');
});

test('visual: compareDomSnapshots accurately detects identical, modified, added, and deleted elements', () => {
  const base = '<div class="card"><h1 class="title">Header</h1><p>Text</p></div>';
  const identical = '  <div class="card" > \n <h1 class="title" >Header</h1> <p>Text</p> </div> ';

  const resIdentical = compareDomSnapshots(base, identical);
  assert.strictEqual(resIdentical.match, true);
  assert.strictEqual(resIdentical.similarity, 1.0);
  assert.strictEqual(resIdentical.diffs.length, 0);

  // Mismatched content
  const candMod = '<div class="card"><h1 class="title">Changed Header</h1><p>Text</p></div>';
  const resMod = compareDomSnapshots(base, candMod);
  assert.strictEqual(resMod.match, false);
  assert.ok(resMod.similarity < 1.0);
  assert.ok(resMod.diffs.some(d => d.type === 'modification'));

  // Missing element (deletion)
  const candDel = '<div class="card"><h1 class="title">Header</h1></div>';
  const resDel = compareDomSnapshots(base, candDel);
  assert.strictEqual(resDel.match, false);
  assert.ok(resDel.diffs.some(d => d.type === 'deletion'));

  // Extra element (addition)
  const candAdd = '<div class="card"><h1 class="title">Header</h1><p>Text</p><span>Extra</span></div>';
  const resAdd = compareDomSnapshots(base, candAdd);
  assert.strictEqual(resAdd.match, false);
  assert.ok(resAdd.diffs.some(d => d.type === 'addition'));
});

test('visual: createPpmImage and parsePpmImage roundtrip binary image buffers', () => {
  const ppm = createPpmImage(3, 2, [100, 150, 200]);
  assert.ok(Buffer.isBuffer(ppm));

  const parsed = parsePpmImage(ppm);
  assert.strictEqual(parsed.width, 3);
  assert.strictEqual(parsed.height, 2);
  assert.strictEqual(parsed.maxVal, 255);
  assert.strictEqual(parsed.data.length, 3 * 2 * 3); // 18 bytes

  // Verify RGB bytes
  assert.strictEqual(parsed.data[0], 100);
  assert.strictEqual(parsed.data[1], 150);
  assert.strictEqual(parsed.data[2], 200);
});

test('visual: comparePixelBuffers performs exact pixel diffing with threshold and diff highlight buffer', () => {
  const imgA = createPpmImage(4, 4, [255, 0, 0]); // All red
  const imgSame = createPpmImage(4, 4, [255, 0, 0]); // All red
  const imgDiff = createPpmImage(4, 4, [0, 255, 0]); // All green

  // Identical comparison
  const resSame = comparePixelBuffers(imgA, imgSame);
  assert.strictEqual(resSame.match, true);
  assert.strictEqual(resSame.totalPixels, 16);
  assert.strictEqual(resSame.diffPixels, 0);
  assert.strictEqual(resSame.diffPercentage, 0);

  // Totally different comparison
  const resDiff = comparePixelBuffers(imgA, imgDiff, { generateDiffImage: true });
  assert.strictEqual(resDiff.match, false);
  assert.strictEqual(resDiff.totalPixels, 16);
  assert.strictEqual(resDiff.diffPixels, 16);
  assert.strictEqual(resDiff.diffPercentage, 100);
  assert.ok(Buffer.isBuffer(resDiff.diffBuffer));

  // Mismatched dimensions
  const imgSmall = createPpmImage(2, 2, [255, 0, 0]);
  const resDim = comparePixelBuffers(imgA, imgSmall);
  assert.strictEqual(resDim.match, false);
  assert.strictEqual(resDim.diffPercentage, 100);
});

test('visual: assertCockpitHudSnapshot validates telemetry scoreboard rendering', () => {
  const hudHtml = `
    <div class="eval-hud">
      <div class="metric-card" data-metric="passAt1">Pass@1: 75%</div>
      <div class="metric-card" data-metric="ssi">SSI: 88%</div>
      <div class="metric-card" data-metric="dei">DEI: 2.0</div>
    </div>
  `;

  // All expected KPIs present
  const validCheck = assertCockpitHudSnapshot(hudHtml, {
    passAt1: 0.75,
    ssi: 88,
    dei: 2.0
  });
  assert.strictEqual(validCheck.valid, true);
  assert.strictEqual(validCheck.errors.length, 0);

  // Missing metric
  const missingCheck = assertCockpitHudSnapshot(hudHtml, {
    passAt1: 0.95 // expects 95%
  });
  assert.strictEqual(missingCheck.valid, false);
  assert.ok(missingCheck.errors[0]?.includes('Pass@1'));
});

test('visual: assertTabSwitching detects deterministic active tab changes', () => {
  const tabBefore = `
    <nav class="cockpit-tabs">
      <button class="tab active" data-tab="hud">HUD</button>
      <button class="tab" data-tab="terminal">Terminal</button>
    </nav>
  `;

  const tabAfter = `
    <nav class="cockpit-tabs">
      <button class="tab" data-tab="hud">HUD</button>
      <button class="tab active" data-tab="terminal">Terminal</button>
    </nav>
  `;

  // Switched successfully
  const switchRes = assertTabSwitching(tabBefore, tabAfter, 'terminal');
  assert.strictEqual(switchRes.switched, true);
  assert.strictEqual(switchRes.activeTab, 'terminal');

  // Failed to switch (expected wrong tab)
  const wrongTabRes = assertTabSwitching(tabBefore, tabAfter, 'settings');
  assert.strictEqual(wrongTabRes.switched, false);

  // No change between before and after
  const noChangeRes = assertTabSwitching(tabBefore, tabBefore, 'hud');
  assert.strictEqual(noChangeRes.switched, false);
  assert.ok(noChangeRes.errors[0]?.includes('did not change'));
});

test('visual: sandbox configuration with enableBrowser sets flags and headless browser environment', () => {
  const config = getSandboxConfig('browser-run-1', {
    enableBrowser: true
  });

  assert.strictEqual(config.enableBrowser, true);
  assert.strictEqual(config.env.DISPLAY, ':99');
  assert.strictEqual(config.env.PLAYWRIGHT_BROWSERS_PATH, '0');
  assert.strictEqual(config.env.CHROME_BIN, '/usr/bin/chromium');

  const args = buildDockerRunArgs(config);
  assert.ok(args.includes('--init'), 'Should include --init for browser zombie reaping');
  assert.ok(args.includes('--ipc=host'), 'Should include --ipc=host for shared memory browser rendering');
});
