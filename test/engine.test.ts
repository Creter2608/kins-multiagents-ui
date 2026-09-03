import test from "node:test";
import * as assert from "node:assert/strict";
import { LoopEngine, type PhaseDefinition } from "../src/engine.js";
import { LoopError } from "../src/errors.js";
import { parseSha256Hex } from "../src/checksum.js";

const DUMMY_SHA = parseSha256Hex("c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c");

const CANONICAL_PHASES: readonly PhaseDefinition[] = [
  { id: "INITIALIZE", allowedNext: ["SPEC_GATE", "FAILED"] },
  { id: "SPEC_GATE", allowedNext: ["ISOLATE", "BLOCKED"] },
  { id: "ISOLATE", allowedNext: ["DETECT_STACKS", "BLOCKED", "FAILED"] },
  { id: "DETECT_STACKS", allowedNext: ["PLAN", "FAILED"] },
  { id: "PLAN", allowedNext: ["EXECUTE", "BLOCKED", "FAILED"] },
  { id: "EXECUTE", allowedNext: ["VERIFY", "BLOCKED", "FAILED"] },
  { id: "VERIFY", allowedNext: ["REALITY_CHECK", "EXECUTE", "BLOCKED", "FAILED"] },
  { id: "REALITY_CHECK", allowedNext: ["RELEASE_GATE", "EXECUTE", "BLOCKED", "FAILED"] },
  { id: "RELEASE_GATE", allowedNext: ["COMPLETE", "BLOCKED"] },
  { id: "COMPLETE", allowedNext: [], terminal: true },
  { id: "BLOCKED", allowedNext: [], terminal: true },
  { id: "FAILED", allowedNext: [], terminal: true }
];

test("engine: full canonical path reaches COMPLETE status", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 15, maxRetries: 2, maxOperations: 10 },
    goldenSha256: DUMMY_SHA,
    runId: "run-001"
  });

  engine.transition("SPEC_GATE");
  engine.transition("ISOLATE");
  engine.transition("DETECT_STACKS");
  engine.transition("PLAN");
  engine.transition("EXECUTE");
  engine.transition("VERIFY");
  engine.transition("REALITY_CHECK");
  engine.transition("RELEASE_GATE");
  const finalState = engine.transition("COMPLETE");

  assert.equal(finalState.currentPhase, "COMPLETE");
  assert.equal(finalState.status, "succeeded");
  assert.equal(finalState.usage.transitions, 9);
});

test("engine: rejects illegal backwards/skipping transitions", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 1, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-002"
  });

  assert.throws(
    () => engine.transition("EXECUTE"),
    (err: unknown) => err instanceof LoopError && err.code === "TRANSITION_INVALID"
  );
  assert.equal(engine.snapshot().usage.transitions, 0);
});

test("engine: enforces retry budget boundaries", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 1, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-003"
  });

  engine.consumeRetry(1);
  assert.equal(engine.snapshot().usage.retries, 1);

  assert.throws(
    () => engine.consumeRetry(1),
    (err: unknown) => err instanceof LoopError && err.code === "BUDGET_EXHAUSTED"
  );
});

test("engine: rollback reverts to source phase and trims history", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-rollback-1"
  });

  engine.transition("SPEC_GATE");
  assert.equal(engine.snapshot().currentPhase, "SPEC_GATE");
  assert.equal(engine.snapshot().history.length, 1);

  const rolledBack = engine.rollback();
  assert.equal(rolledBack.currentPhase, "INITIALIZE");
  assert.equal(rolledBack.status, "ready");
  assert.equal(rolledBack.history.length, 0);
});

test("engine: multiple transitions walk backward one step per rollback call", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-rollback-2"
  });

  engine.transition("SPEC_GATE");
  engine.transition("ISOLATE");
  engine.transition("DETECT_STACKS");
  assert.equal(engine.snapshot().currentPhase, "DETECT_STACKS");
  assert.equal(engine.snapshot().history.length, 3);

  engine.rollback();
  assert.equal(engine.snapshot().currentPhase, "ISOLATE");
  assert.equal(engine.snapshot().status, "running");
  assert.equal(engine.snapshot().history.length, 2);

  engine.rollback();
  assert.equal(engine.snapshot().currentPhase, "SPEC_GATE");
  assert.equal(engine.snapshot().history.length, 1);

  engine.rollback();
  assert.equal(engine.snapshot().currentPhase, "INITIALIZE");
  assert.equal(engine.snapshot().status, "ready");
  assert.equal(engine.snapshot().history.length, 0);
});

test("engine: rollback with empty history throws without mutating state", () => {
  const engine = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-rollback-empty"
  });

  assert.throws(
    () => engine.rollback(),
    (err: unknown) => err instanceof LoopError && err.code === "STATE_INVALID"
  );
  assert.equal(engine.snapshot().currentPhase, "INITIALIZE");
  assert.equal(engine.snapshot().status, "ready");
});

test("engine: rollback from terminal states is rejected without mutation", () => {
  const engineSucceeded = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-rollback-term-1"
  });
  engineSucceeded.transition("SPEC_GATE");
  engineSucceeded.transition("ISOLATE");
  engineSucceeded.transition("DETECT_STACKS");
  engineSucceeded.transition("PLAN");
  engineSucceeded.transition("EXECUTE");
  engineSucceeded.transition("VERIFY");
  engineSucceeded.transition("REALITY_CHECK");
  engineSucceeded.transition("RELEASE_GATE");
  engineSucceeded.transition("COMPLETE");
  assert.equal(engineSucceeded.snapshot().status, "succeeded");

  assert.throws(
    () => engineSucceeded.rollback(),
    (err: unknown) => err instanceof LoopError && err.code === "TRANSITION_INVALID"
  );
  assert.equal(engineSucceeded.snapshot().currentPhase, "COMPLETE");

  const engineFailed = new LoopEngine({
    phases: CANONICAL_PHASES,
    initialPhase: "INITIALIZE",
    terminalPhase: "COMPLETE",
    budget: { maxTransitions: 10, maxRetries: 2, maxOperations: 5 },
    goldenSha256: DUMMY_SHA,
    runId: "run-rollback-term-2"
  });
  engineFailed.transition("SPEC_GATE");
  engineFailed.fail("EXECUTION_FAILED", "Test fatal error");
  assert.equal(engineFailed.snapshot().status, "failed");

  assert.throws(
    () => engineFailed.rollback(),
    (err: unknown) => err instanceof LoopError && err.code === "TRANSITION_INVALID"
  );
  assert.equal(engineFailed.snapshot().currentPhase, "FAILED");
});
