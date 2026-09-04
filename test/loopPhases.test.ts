import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOOP_PHASES,
  nextLoopPhase,
  previousLoopPhase,
  isLoopPhase,
  computePhaseStatuses,
  type LoopPhase
} from "../src/shared/loopPhases.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";

// Assertion 1: {"in":"LOOP_PHASES","out":"10 unique phases, INITIALIZE first, COMPLETE last"}
test("canonical loop phases: exactly 10 unique phases in specified order", () => {
  assert.equal(LOOP_PHASES.length, 10);
  assert.equal(LOOP_PHASES[0], "INITIALIZE");
  assert.equal(LOOP_PHASES[LOOP_PHASES.length - 1], "COMPLETE");

  const uniquePhases = new Set(LOOP_PHASES);
  assert.equal(uniquePhases.size, 10);

  const expectedOrder: readonly LoopPhase[] = [
    "INITIALIZE",
    "SPEC_GATE",
    "ISOLATE",
    "DETECT_STACKS",
    "PLAN",
    "EXECUTE",
    "VERIFY",
    "REALITY_CHECK",
    "RELEASE_GATE",
    "COMPLETE"
  ];
  assert.deepEqual(Array.from(LOOP_PHASES), expectedOrder);
});

// Assertion 2: {"in":"next(VERIFY)","out":"REALITY_CHECK"}
test("canonical loop transitions: nextLoopPhase('VERIFY') === 'REALITY_CHECK'", () => {
  assert.equal(nextLoopPhase("VERIFY"), "REALITY_CHECK");
});

// Assertion 3: {"in":"next(COMPLETE)","out":"COMPLETE"}
test("canonical loop transitions: nextLoopPhase clamps at 'COMPLETE'", () => {
  assert.equal(nextLoopPhase("COMPLETE"), "COMPLETE");
});

// Assertion 4: {"in":"previous(INITIALIZE)","out":"INITIALIZE"}
test("canonical loop transitions: previousLoopPhase clamps at 'INITIALIZE'", () => {
  assert.equal(previousLoopPhase("INITIALIZE"), "INITIALIZE");
});

// Assertion 5: {"in":"previous(COMPLETE)","out":"RELEASE_GATE"}
test("canonical loop transitions: previousLoopPhase('COMPLETE') === 'RELEASE_GATE'", () => {
  assert.equal(previousLoopPhase("COMPLETE"), "RELEASE_GATE");
  assert.equal(previousLoopPhase("SPEC_GATE"), "INITIALIZE");
});

test("canonical loop transitions: full sequential bidirectional walk", () => {
  let curr: LoopPhase = "INITIALIZE";
  for (let i = 0; i < LOOP_PHASES.length - 1; i++) {
    curr = nextLoopPhase(curr);
    assert.equal(curr, LOOP_PHASES[i + 1]);
  }
  assert.equal(curr, "COMPLETE");
  assert.equal(nextLoopPhase(curr), "COMPLETE");

  for (let i = LOOP_PHASES.length - 1; i > 0; i--) {
    curr = previousLoopPhase(curr);
    assert.equal(curr, LOOP_PHASES[i - 1]);
  }
  assert.equal(curr, "INITIALIZE");
  assert.equal(previousLoopPhase(curr), "INITIALIZE");
});

test("LoopStateService: stepForward and stepBack respect canonical phase contract and boundary clamping", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-phase-test-"));
  const stateFile = path.join(tempDir, "state.json");

  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-phase-boundary",
        currentPhase: "INITIALIZE",
        status: "ready",
        usage: { transitions: 0, retries: 0, operations: 0 },
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        history: []
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);

    // Initial stepBack is rejected
    const initialStepBack = service.stepBack();
    assert.equal(initialStepBack.success, false);
    assert.equal(service.getSnapshot().currentPhase, "INITIALIZE");

    // Step forward 8 times to RELEASE_GATE
    for (let i = 0; i < 8; i++) {
      const res = service.stepForward();
      assert.equal(res.success, true);
    }
    assert.equal(service.getSnapshot().currentPhase, "RELEASE_GATE");

    // Stepping back from RELEASE_GATE goes to REALITY_CHECK
    const stepBackFromReleaseGate = service.stepBack();
    assert.equal(stepBackFromReleaseGate.success, true);
    assert.equal(service.getSnapshot().currentPhase, "REALITY_CHECK");

    // Step forward back to RELEASE_GATE and then COMPLETE
    assert.equal(service.stepForward().success, true); // to RELEASE_GATE
    assert.equal(service.stepForward().success, true); // to COMPLETE
    assert.equal(service.getSnapshot().currentPhase, "COMPLETE");
    assert.equal(service.getSnapshot().status, "succeeded");

    // Stepping forward at COMPLETE is rejected
    const clampedStepForward = service.stepForward();
    assert.equal(clampedStepForward.success, false);
    assert.equal(service.getSnapshot().currentPhase, "COMPLETE");

    // Stepping back from terminal state COMPLETE is safely rejected without mutation
    const stepBackFromComplete = service.stepBack();
    assert.equal(stepBackFromComplete.success, false);
    assert.equal(service.getSnapshot().currentPhase, "COMPLETE");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
