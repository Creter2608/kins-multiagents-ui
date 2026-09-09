import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  JsonFileLoopStateStore,
  LoopCommandService,
  CANONICAL_PHASES,
  type BlueprintArtifactVerifier
} from "../src/loop/index.js";
import { parseSha256Hex } from "../src/checksum.js";
import {
  assertReleaseGateReady,
  DEFAULT_RESOURCE_BUDGET,
  EMPTY_RESOURCE_USAGE,
  type LoopState,
  type AuditRecord
} from "../src/engine.js";
import { LoopError } from "../src/errors.js";
import {
  inferArchitectureTaskType,
  type ArchitectureChange
} from "../src/main/services/LoopStateService.js";

const NOOP_BLUEPRINT_VERIFIER: BlueprintArtifactVerifier = {
  async verifyReadyBlueprint() {}
};

const DUMMY_SHA = parseSha256Hex("c9e3edcf9d3c16427221490a55e17de7414cb77b3c6653ffa63073cacf81889c");

function createTestState(runId: string = "run-triage-1"): LoopState {
  return {
    schemaVersion: 1,
    revision: 1,
    runId,
    currentPhase: "INITIALIZE",
    status: "ready",
    goldenSha256: DUMMY_SHA,
    budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
    usage: { transitions: 0, retries: 0, operations: 0 },
    resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
    resourceUsage: { ...EMPTY_RESOURCE_USAGE },
    history: []
  };
}

// ---------------------------------------------------------------------------
// 1. inferArchitectureTaskType Tests
// ---------------------------------------------------------------------------
test("inferArchitectureTaskType: explicit blueprint taskType takes precedence", () => {
  const changes: ArchitectureChange[] = [
    { status: "M", path: "src/engine.ts" }
  ];
  const res = inferArchitectureTaskType("feat", changes, true);
  assert.equal(res, "feat");

  const res2 = inferArchitectureTaskType("refactor", changes, true);
  assert.equal(res2, "refactor");
});

test("inferArchitectureTaskType: infers 'feat' when new production code files are added without blueprint taskType", () => {
  const changes: ArchitectureChange[] = [
    { status: "A", path: "src/renderer/components/QualityGateDecisionModal.tsx" },
    { status: "M", path: "src/engine.ts" }
  ];
  const res = inferArchitectureTaskType(undefined, changes, true);
  assert.equal(res, "feat");
});

test("inferArchitectureTaskType: ignores docs, tests, and eval additions when detecting production files", () => {
  const changes: ArchitectureChange[] = [
    { status: "A", path: "docs/DECISIONS.md" },
    { status: "A", path: "test/quality-gate-triage.test.ts" },
    { status: "M", path: "src/engine.ts" }
  ];
  const res = inferArchitectureTaskType(undefined, changes, true);
  assert.equal(res, "fix");
});

test("inferArchitectureTaskType: returns 'bootstrap' when repo has no tracked production baseline and files are added", () => {
  const changes: ArchitectureChange[] = [
    { status: "A", path: "src/main/index.ts" }
  ];
  const res = inferArchitectureTaskType(undefined, changes, false);
  assert.equal(res, "bootstrap");
});

// ---------------------------------------------------------------------------
// 2. assertReleaseGateReady Tests
// ---------------------------------------------------------------------------
test("assertReleaseGateReady: throws when audit is missing or not closed", () => {
  const base = createTestState();
  const stateNoAudit: LoopState = {
    ...base,
    currentPhase: "REALITY_CHECK",
    architecturalCompliance: {
      passed: true,
      aqi: 4.5,
      minAqi: 3.8,
      feedback: [],
      criteriaScores: { surgicalDiff: 5, simplicity: 5, modularity: 5, maintainability: 5 }
    }
  };

  assert.throws(
    () => assertReleaseGateReady(stateNoAudit),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match(err.message, /must be 'closed'/);
      return true;
    }
  );

  const stateAuditRunning: LoopState = {
    ...stateNoAudit,
    audit: {
      status: "running",
      invocationKey: "inv-1",
      remediationCount: 0,
      findings: []
    }
  };

  assert.throws(
    () => assertReleaseGateReady(stateAuditRunning),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match(err.message, /must be 'closed'/);
      return true;
    }
  );
});

test("assertReleaseGateReady: throws when architectural compliance failed", () => {
  const base = createTestState();
  const closedAudit: AuditRecord = {
    status: "closed",
    invocationKey: "inv-1",
    remediationCount: 0,
    findings: []
  };

  const stateFailedComp: LoopState = {
    ...base,
    currentPhase: "REALITY_CHECK",
    audit: closedAudit,
    architecturalCompliance: {
      passed: false,
      aqi: 3.2,
      minAqi: 3.8,
      feedback: [],
      criteriaScores: { surgicalDiff: 2, simplicity: 3, modularity: 4, maintainability: 4 }
    }
  };

  assert.throws(
    () => assertReleaseGateReady(stateFailedComp),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match(err.message, /architectural compliance failed \(passed=false, AQI=3\.2\)/);
      return true;
    }
  );
});

test("assertReleaseGateReady: throws when AQI is below minAqi", () => {
  const base = createTestState();
  const stateLowAqi: LoopState = {
    ...base,
    currentPhase: "REALITY_CHECK",
    audit: {
      status: "closed",
      invocationKey: "inv-1",
      remediationCount: 0,
      findings: []
    },
    architecturalCompliance: {
      passed: true,
      aqi: 3.0,
      minAqi: 3.8,
      feedback: [],
      criteriaScores: { surgicalDiff: 2, simplicity: 3, modularity: 4, maintainability: 4 }
    }
  };

  assert.throws(
    () => assertReleaseGateReady(stateLowAqi),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match(err.message, /AQI score 3 is below required threshold 3\.8/);
      return true;
    }
  );
});

test("assertReleaseGateReady: passes when audit closed and AQI meets threshold", () => {
  const base = createTestState();
  const stateValid: LoopState = {
    ...base,
    currentPhase: "REALITY_CHECK",
    audit: {
      status: "closed",
      invocationKey: "inv-1",
      remediationCount: 0,
      findings: []
    },
    architecturalCompliance: {
      passed: true,
      aqi: 4.2,
      minAqi: 3.8,
      feedback: [],
      criteriaScores: { surgicalDiff: 4, simplicity: 4, modularity: 5, maintainability: 4 }
    }
  };

  assert.doesNotThrow(() => assertReleaseGateReady(stateValid));
});

test("assertReleaseGateReady: passes sub-threshold AQI when active valid OVERRIDE decision exists", () => {
  const base = createTestState("run-override-99");
  const stateWithOverride: LoopState = {
    ...base,
    currentPhase: "BLOCKED",
    audit: {
      status: "closed",
      invocationKey: "inv-1",
      remediationCount: 0,
      findings: []
    },
    architecturalCompliance: {
      passed: false,
      aqi: 3.1,
      minAqi: 3.8,
      feedback: [],
      criteriaScores: { surgicalDiff: 2, simplicity: 3, modularity: 4, maintainability: 4 }
    },
    qualityGateBlock: {
      blockedFrom: "REALITY_CHECK",
      artifactHash: "hash-abc",
      failureKinds: ["AQI"],
      observedAqi: 3.1,
      minAqi: 3.8,
      auditFindingIds: [],
      remediationRemaining: true,
      overridePermitted: true
    },
    qualityGateDecisions: [
      {
        decisionId: "dec-1",
        runId: "run-override-99",
        revision: 2,
        disposition: "OVERRIDE",
        principalId: "human-operator",
        reason: "Waiving AQI penalty for emergency hotfix",
        artifactHash: "hash-abc",
        failureKinds: ["AQI"],
        observedAqi: 3.1,
        minAqi: 3.8,
        auditFindingIds: [],
        timestamp: Date.now()
      }
    ]
  };

  assert.doesNotThrow(() => assertReleaseGateReady(stateWithOverride));
});

// ---------------------------------------------------------------------------
// 3. LoopCommandService 3-Way Triage Integration Tests
// ---------------------------------------------------------------------------
test("LoopCommandService: 3-way triage from BLOCKED state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-test-"));
  const stateFilePath = path.join(tmpDir, "state.json");

  try {
    const store = new JsonFileLoopStateStore(stateFilePath);
    const service = new LoopCommandService(
      store,
      CANONICAL_PHASES,
      NOOP_BLUEPRINT_VERIFIER
    );

    // 1. Initialize state in BLOCKED phase
    const initialState: LoopState = {
      ...createTestState("run-blocked-1"),
      currentPhase: "BLOCKED",
      status: "blocked",
      revision: 5,
      resourceBudget: {
        ...DEFAULT_RESOURCE_BUDGET,
        maxQualityRemediations: 1
      },
      resourceUsage: {
        ...EMPTY_RESOURCE_USAGE,
        qualityRemediations: 0
      },
      qualityGateBlock: {
        blockedFrom: "REALITY_CHECK",
        artifactHash: "art-hash-1",
        failureKinds: ["AQI"],
        observedAqi: 3.0,
        minAqi: 3.8,
        auditFindingIds: ["finding-1"],
        remediationRemaining: true,
        overridePermitted: true
      }
    };
    store.writeSync(initialState);

    // Test Remediate: BLOCKED -> EXECUTE
    const remRes = await service.transition({
      runId: "run-blocked-1",
      expectedPhase: "BLOCKED",
      expectedRevision: 5,
      action: "remediate",
      actor: "human",
      reason: "Applying targeted fix for surgical diff",
      feedback: "Break down the single large component into smaller modules",
      artifactHash: "art-hash-1"
    });

    assert.equal(remRes.state.currentPhase, "EXECUTE");
    assert.equal(remRes.state.status, "running");
    assert.equal(remRes.state.resourceUsage.qualityRemediations, 1);
    assert.equal(remRes.state.qualityGateDecisions?.length, 1);
    assert.equal(remRes.state.qualityGateDecisions?.[0]?.disposition, "REMEDIATE");

    // Re-block state to test remediation quota exhaustion
    const blockedAgain: LoopState = {
      ...remRes.state,
      currentPhase: "BLOCKED",
      status: "blocked",
      revision: remRes.state.revision
    };
    store.writeSync(blockedAgain);

    // Attempt second remediation when maxQualityRemediations = 1
    await assert.rejects(
      async () => {
        await service.transition({
          runId: "run-blocked-1",
          expectedPhase: "BLOCKED",
          expectedRevision: remRes.state.revision,
          action: "remediate",
          actor: "human",
          reason: "Second remediation attempt",
          feedback: "Fix remaining lint issue",
          artifactHash: "art-hash-1"
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof LoopError);
        assert.match(err.message, /quality remediation budget exhausted/i);
        return true;
      }
    );

    // Test Override: BLOCKED -> RELEASE_GATE
    const overrideRes = await service.transition({
      runId: "run-blocked-1",
      expectedPhase: "BLOCKED",
      expectedRevision: remRes.state.revision,
      action: "override_quality_gate",
      actor: "human",
      reason: "Emergency release authorized by lead architect",
      artifactHash: "art-hash-1"
    });

    assert.equal(overrideRes.state.currentPhase, "RELEASE_GATE");
    assert.equal(overrideRes.state.status, "running");
    assert.equal(overrideRes.state.qualityGateDecisions?.length, 2);
    assert.equal(overrideRes.state.qualityGateDecisions?.[1]?.disposition, "OVERRIDE");

    // Test Reject: BLOCKED -> FAILED
    const blockedThird: LoopState = {
      ...overrideRes.state,
      currentPhase: "BLOCKED",
      status: "blocked",
      revision: overrideRes.state.revision
    };
    store.writeSync(blockedThird);

    const rejectRes = await service.transition({
      runId: "run-blocked-1",
      expectedPhase: "BLOCKED",
      expectedRevision: overrideRes.state.revision,
      action: "reject",
      actor: "human",
      reason: "Quality gate permanently rejected by human operator",
      artifactHash: "art-hash-1"
    });

    assert.equal(rejectRes.state.currentPhase, "FAILED");
    assert.equal(rejectRes.state.status, "failed");
    assert.equal(rejectRes.state.qualityGateDecisions?.length, 3);
    assert.equal(rejectRes.state.qualityGateDecisions?.[2]?.disposition, "REJECT_REVERT");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
