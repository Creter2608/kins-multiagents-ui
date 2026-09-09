import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseSha256Hex } from "../src/checksum.js";
import {
  DEFAULT_RESOURCE_BUDGET,
  EMPTY_RESOURCE_USAGE,
  LoopEngine,
  assertReleaseGateReady,
  type LoopState
} from "../src/engine.js";
import {
  CANONICAL_PHASES,
  JsonFileLoopStateStore,
  LoopCommandService,
  type BlueprintArtifactVerifier
} from "../src/loop/index.js";

const GOLDEN_SHA = parseSha256Hex(
  "c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c"
);

const NOOP_BLUEPRINT_VERIFIER: BlueprintArtifactVerifier = {
  async verifyReadyBlueprint(): Promise<void> {}
};

function qualityBlockedState(
  runId: string,
  revision: number = 7
): LoopState {
  return {
    schemaVersion: 2,
    revision,
    runId,
    currentPhase: "BLOCKED",
    status: "blocked",
    goldenSha256: GOLDEN_SHA,
    budget: {
      maxTransitions: 30,
      maxRetries: 2,
      maxOperations: 50
    },
    usage: {
      transitions: 8,
      retries: 0,
      operations: 0
    },
    history: [],
    audit: {
      status: "closed",
      invocationKey: "audit-1",
      remediationCount: 0,
      findings: []
    },
    architecturalCompliance: {
      passed: false,
      aqi: 3.1,
      minAqi: 4.5,
      feedback: [],
      criteriaScores: {
        surgicalDiff: 3,
        simplicity: 3,
        modularity: 3,
        maintainability: 3
      }
    },
    qualityGateBlock: {
      blockedFrom: "REALITY_CHECK",
      artifactHash: "current-artifact-hash",
      failureKinds: ["AQI"],
      observedAqi: 3.1,
      minAqi: 4.5,
      auditFindingIds: [],
      remediationRemaining: true,
      overridePermitted: true
    },
    resourceBudget: {
      ...DEFAULT_RESOURCE_BUDGET,
      maxQualityRemediations: 1
    },
    resourceUsage: {
      ...EMPTY_RESOURCE_USAGE,
      globalCycles: 1,
      qualityRemediations: 0
    }
  };
}

test("quality-blocked engine rejects autonomous exit to EXECUTE", () => {
  const initial = qualityBlockedState("run-autonomous");

  const engine = new LoopEngine(
    {
      phases: CANONICAL_PHASES,
      initialPhase: "INITIALIZE",
      terminalPhase: "COMPLETE",
      budget: initial.budget,
      goldenSha256: GOLDEN_SHA,
      runId: initial.runId
    },
    initial
  );

  assert.throws(
    () =>
      engine.transition("EXECUTE", {
        actor: "agent",
        autoAdvanced: true,
        triggeredBy: "autonomous-loop"
      }),
    /human|blocked|decision|transition/i
  );

  const after = engine.snapshot();
  assert.equal(after.currentPhase, "BLOCKED");
  assert.equal(after.status, "blocked");
  assert.equal(after.revision, initial.revision);
});

test("historical override with a different artifact hash cannot authorize release", () => {
  const state: LoopState = {
    ...qualityBlockedState("run-stale-override", 12),
    qualityGateDecisions: [
      {
        decisionId: "decision-for-old-artifact",
        runId: "run-stale-override",
        revision: 9,
        disposition: "OVERRIDE",
        principalId: "operator-1",
        reason: "Approved before the workspace changed",
        artifactHash: "old-artifact-hash",
        failureKinds: ["AQI"],
        observedAqi: 3.1,
        minAqi: 4.5,
        auditFindingIds: [],
        timestamp: 1_700_000_000_000
      }
    ]
  };

  assert.throws(
    () => assertReleaseGateReady(state),
    /artifact|hash|revision|override|architectural compliance/i
  );
});

test("quality-blocked rejection requires the active artifact hash and remains blocked on denial", async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "quality-reject-hash-")
  );

  try {
    const store = new JsonFileLoopStateStore(
      path.join(tmpDir, "state.json")
    );
    const initial = qualityBlockedState("run-reject-hash");
    store.writeSync(initial);

    const service = new LoopCommandService(
      store,
      CANONICAL_PHASES,
      NOOP_BLUEPRINT_VERIFIER
    );

    await assert.rejects(
      service.transition({
        runId: initial.runId,
        expectedPhase: "BLOCKED",
        expectedRevision: initial.revision,
        action: "reject",
        actor: "human",
        reason: "Reject the generated task changes"
        // artifactHash is deliberately omitted.
      }),
      /artifact|hash|required/i
    );

    const after = await service.status();
    assert.equal(after.currentPhase, "BLOCKED");
    assert.equal(after.status, "blocked");
    assert.equal(after.revision, initial.revision);
    assert.equal(after.qualityGateDecisions?.length ?? 0, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("historical override cannot bypass compliance when no active quality gate block exists", () => {
  const state: LoopState = {
    ...qualityBlockedState("run-no-active-block"),
    currentPhase: "REALITY_CHECK",
    status: "running",
    qualityGateBlock: undefined,
    qualityGateDecisions: [
      {
        decisionId: "historical-override",
        runId: "run-no-active-block",
        revision: 4,
        disposition: "OVERRIDE",
        principalId: "operator-1",
        reason: "Override for a previously resolved block",
        artifactHash: "historical-artifact",
        failureKinds: ["AQI"],
        observedAqi: 3.1,
        minAqi: 4.5,
        auditFindingIds: [],
        timestamp: 1_700_000_000_000
      }
    ]
  };

  assert.throws(
    () => assertReleaseGateReady(state),
    /architectural compliance|quality gate|override|active block/i
  );
});

test("a later rejection revokes an earlier override for the same artifact", () => {
  const state: LoopState = {
    ...qualityBlockedState("run-rejected-override"),
    qualityGateDecisions: [
      {
        decisionId: "override-1",
        runId: "run-rejected-override",
        revision: 8,
        disposition: "OVERRIDE",
        principalId: "operator-1",
        reason: "Initially approved",
        artifactHash: "current-artifact-hash",
        failureKinds: ["AQI"],
        observedAqi: 3.1,
        minAqi: 4.5,
        auditFindingIds: [],
        timestamp: 1_700_000_000_000
      },
      {
        decisionId: "reject-2",
        runId: "run-rejected-override",
        revision: 9,
        disposition: "REJECT_REVERT",
        principalId: "operator-2",
        reason: "Approval revoked after review",
        artifactHash: "current-artifact-hash",
        failureKinds: ["AQI"],
        observedAqi: 3.1,
        minAqi: 4.5,
        auditFindingIds: [],
        timestamp: 1_700_000_001_000
      }
    ]
  };

  assert.throws(
    () => assertReleaseGateReady(state),
    /architectural compliance|rejected|override|quality gate/i
  );
});
