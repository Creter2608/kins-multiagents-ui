import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mainSource = readFileSync(
  resolve(process.cwd(), "src/main/index.ts"),
  "utf8"
);

test("ECC integration preserves unconditional quota startup", () => {
  assert.doesNotMatch(
    mainSource,
    /\bconst\s+ENABLE_ANTIGRAVITY_QUOTA_POLLING\s*=\s*false\s*;/,
    "ECC integration must not introduce a false quota-startup gate"
  );

  assert.match(
    mainSource,
    /^antigravityQuotaService\.start\(\);[ \t]*$/m,
    "Restore the original top-level quota startup statement"
  );
});

test("ECC integration preserves terminal-loop quota refresh", () => {
  const subscriptions = [
    ...mainSource.matchAll(
      /loopService\.subscribe\(\(state\)\s*=>\s*\{([\s\S]*?)^\}\);/gm
    )
  ];

  const quotaSubscription = subscriptions.find((match) =>
    /antigravityQuotaService\.refresh\("loop-complete"\)/.test(match[1])
  );

  assert.ok(
    quotaSubscription,
    "Restore the loop subscription that refreshes quota on terminal transitions"
  );

  const body = quotaSubscription[1];

  assert.match(body, /state\.currentPhase\s*===\s*"COMPLETE"/);
  assert.match(body, /state\.status\s*===\s*"succeeded"/);
  assert.match(body, /state\.status\s*===\s*"failed"/);
  assert.match(
    body,
    /if\s*\(\s*isTerminalPhase\s*&&\s*changed\s*\)/,
    "Preserve terminal-transition gating to avoid repeated refreshes"
  );
  assert.match(
    body,
    /antigravityQuotaService\.refresh\("loop-complete"\)\.catch\(/,
    "Preserve rejection handling for the fire-and-forget refresh"
  );
});
