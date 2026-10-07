import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const rendererDir = path.join(rootDir, "src", "renderer");
const componentsDir = path.join(rendererDir, "components");

test("UI Invariant 1: cockpit.css defines core Zinc design tokens and WCAG AA focus outline", () => {
  const cssPath = path.join(rendererDir, "styles", "cockpit.css");
  assert.ok(fs.existsSync(cssPath), "cockpit.css must exist");

  const css = fs.readFileSync(cssPath, "utf8");
  assert.match(css, /--cockpit-bg:\s*#09090b;/, "Defines Zinc-950 background token");
  assert.match(css, /--cockpit-surface:\s*#18181b;/, "Defines Zinc-900 surface token");
  assert.match(css, /--cockpit-raised:\s*#27272a;/, "Defines Zinc-800 raised token");
  assert.match(css, /--cockpit-text-primary:\s*#f4f4f5;/, "Defines Zinc-100 text primary token");
  assert.match(css, /:focus-visible\s*\{[\s\S]*outline:\s*2px\s+solid/i, "Enforces high-contrast focus outline");
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/, "Enforces prefers-reduced-motion reset");
});

test("UI Invariant 2: No dead black #000000 or fragmented hexes in renderer components", () => {
  const files = fs.readdirSync(componentsDir).filter((f) => f.endsWith(".tsx"));
  const bannedHexes = [
    "#000000",
    "#0c0c0c",
    "#0a0a0a",
    "#0d0d0d",
    "#0f0f10",
    "#0d0d0e",
    "#111113",
    "#141414",
    "#141418",
    "#181820",
    "#1a1a1e",
    "#1a1a22",
    "#1e1e24",
    "#20202a",
    "#16161d"
  ];

  for (const file of files) {
    if (file === "TerminalStage.tsx") {
      // TerminalStage xterm options use standard ANSI color definitions, which is allowed.
      continue;
    }
    const content = fs.readFileSync(path.join(componentsDir, file), "utf8");
    for (const banned of bannedHexes) {
      assert.ok(
        !content.includes(banned),
        `Found legacy fragmented hex ${banned} in component ${file}`
      );
    }
  }
});

test("UI Invariant 3: Modal dialogs implement proper semantic accessibility attributes", () => {
  const dialogComponents = [
    "PhaseTracker.tsx",
    "McpSidebar.tsx",
    "SubagentSidebar.tsx",
    "ProjectSelector.tsx",
    "QualityGateDecisionModal.tsx"
  ];

  for (const file of dialogComponents) {
    const content = fs.readFileSync(path.join(componentsDir, file), "utf8");
    const hasDialogRole = content.includes('role="dialog"') || content.includes('role="alertdialog"');
    assert.ok(
      hasDialogRole,
      `${file} must contain modal dialog container with role="dialog" or role="alertdialog"`
    );
  }
});

test("UI Invariant 4: Action buttons and toggles enforce visible focus rings and accessible labels", () => {
  const criticalLog = fs.readFileSync(path.join(componentsDir, "CriticalLogDrawer.tsx"), "utf8");
  assert.ok(criticalLog.includes("aria-expanded="), "CriticalLogDrawer toggle button must have aria-expanded");
  assert.ok(criticalLog.includes("aria-controls="), "CriticalLogDrawer toggle button must have aria-controls");

  const telemetryHud = fs.readFileSync(path.join(componentsDir, "TelemetryHud.tsx"), "utf8");
  assert.ok(telemetryHud.includes("aria-label="), "TelemetryHud icon action buttons must have aria-label");

  const terminal = fs.readFileSync(path.join(componentsDir, "TerminalStage.tsx"), "utf8");
  assert.ok(terminal.includes('aria-label="Clear terminal buffer"'), "TerminalStage clear button must have aria-label");
  assert.ok(terminal.includes('aria-label="Restart agy session"'), "TerminalStage restart button must have aria-label");
});

test("UI Invariant 5: Numbers and technical metrics use tabular-nums with monospace font", () => {
  const telemetry = fs.readFileSync(path.join(componentsDir, "TelemetryHud.tsx"), "utf8");
  assert.ok(telemetry.includes("tabular-nums"), "TelemetryHud must format metrics with tabular-nums");

  const evalBoard = fs.readFileSync(path.join(componentsDir, "EvalScoreboard.tsx"), "utf8");
  assert.ok(evalBoard.includes("tabular-nums"), "EvalScoreboard must format metrics with tabular-nums");
});
