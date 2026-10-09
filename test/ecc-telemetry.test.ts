import test from "node:test";
import assert from "node:assert/strict";
import { SubagentService } from "../src/main/services/SubagentService.js";
import { EccDispatcherService } from "../src/main/services/EccDispatcherService.js";
import type { EccCatalogService } from "../src/main/services/EccCatalogService.js";
import type { EccDispatchedMetadata, SubagentActivity } from "../src/shared/contracts.js";

test("ecc-telemetry: Assertion 1 - record ECC; mutate input skills/metrics -> stored metadata unchanged", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const mutableSkillIds = ["skill:audit", "skill:perf"];
  const mutableOptimization = {
    originalBytes: 1000,
    compactedBytes: 400,
    savingsRatio: 0.6,
    includedSkillCount: 2,
    truncatedSkillCount: 0
  };

  const metadata: EccDispatchedMetadata = {
    source: "ecc",
    agentId: "agent:code-reviewer",
    skillIds: mutableSkillIds,
    optimization: mutableOptimization
  };

  const activity = service.recordInvocation({
    id: "subagent-1",
    role: "ecc:Code Reviewer",
    model: "claude-3-5-sonnet",
    prompt: "Review PR #42",
    eccMetadata: metadata
  });

  assert.ok(activity.eccMetadata);
  assert.equal(activity.eccMetadata.agentId, "agent:code-reviewer");
  assert.deepEqual(activity.eccMetadata.skillIds, ["skill:audit", "skill:perf"]);
  assert.equal(activity.eccMetadata.optimization?.savingsRatio, 0.6);

  // Mutate original arrays and objects after recording
  mutableSkillIds.push("skill:malicious-injection");
  mutableOptimization.originalBytes = 999999;
  mutableOptimization.savingsRatio = 0.99;

  // Stored metadata must remain completely unchanged
  const currentList = service.list();
  assert.equal(currentList.length, 1);
  const stored = currentList[0]!;
  assert.deepEqual(stored.eccMetadata?.skillIds, ["skill:audit", "skill:perf"]);
  assert.equal(stored.eccMetadata?.optimization?.originalBytes, 1000);
  assert.equal(stored.eccMetadata?.optimization?.savingsRatio, 0.6);
});

test("ecc-telemetry: Assertion 2 - ECC running->completed and running->error -> metadata preserved in list and events", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const broadcastEvents: SubagentActivity[][] = [];
  service.subscribe((activities) => {
    broadcastEvents.push(activities);
  });

  // 1. Path A: running -> completed
  const act1 = service.recordInvocation({
    id: "subagent-success",
    role: "ecc:Architect",
    prompt: "Design DB schema",
    eccMetadata: {
      source: "ecc",
      agentId: "agent:architect",
      skillIds: ["skill:sql"],
      optimization: {
        originalBytes: 500,
        compactedBytes: 300,
        savingsRatio: 0.4,
        includedSkillCount: 1,
        truncatedSkillCount: 0
      }
    }
  });

  currentTime = 2000;
  service.updateStatus({ id: "subagent-success", status: "completed" });

  const completedActivity = service.list().find((a) => a.id === "subagent-success")!;
  assert.equal(completedActivity.status, "completed");
  assert.ok(completedActivity.eccMetadata);
  assert.equal(completedActivity.eccMetadata.agentId, "agent:architect");
  assert.deepEqual(completedActivity.eccMetadata.skillIds, ["skill:sql"]);
  assert.equal(completedActivity.eccMetadata.optimization?.savingsRatio, 0.4);

  // 2. Path B: running -> error
  const act2 = service.recordInvocation({
    id: "subagent-fail",
    role: "ecc:Tester",
    prompt: "Run stress test",
    eccMetadata: {
      source: "ecc",
      agentId: "agent:tester",
      skillIds: ["skill:load-test"],
      optimization: {
        originalBytes: 800,
        compactedBytes: 600,
        savingsRatio: 0.25,
        includedSkillCount: 1,
        truncatedSkillCount: 0
      }
    }
  });

  currentTime = 3000;
  service.updateStatus({ id: "subagent-fail", status: "error", errorMessage: "Container out of memory" });

  const errorActivity = service.list().find((a) => a.id === "subagent-fail")!;
  assert.equal(errorActivity.status, "error");
  assert.equal(errorActivity.errorMessage, "Container out of memory");
  assert.ok(errorActivity.eccMetadata);
  assert.equal(errorActivity.eccMetadata.agentId, "agent:tester");
  assert.deepEqual(errorActivity.eccMetadata.skillIds, ["skill:load-test"]);

  // Verify all listener broadcast events had intact metadata
  assert.ok(broadcastEvents.length >= 4);
  for (const snapshot of broadcastEvents) {
    for (const a of snapshot) {
      if (a.id.startsWith("subagent-")) {
        assert.ok(a.eccMetadata, `Snapshot activity ${a.id} missing eccMetadata`);
        assert.equal(a.eccMetadata.source, "ecc");
      }
    }
  }
});

test("ecc-telemetry: Assertion 3 - mutate returned metadata snapshot -> subsequent list unchanged", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const initial = service.recordInvocation({
    id: "subagent-snap",
    role: "ecc:Dev",
    eccMetadata: {
      source: "ecc",
      agentId: "agent:dev",
      skillIds: ["skill:react"],
      optimization: {
        originalBytes: 200,
        compactedBytes: 100,
        savingsRatio: 0.5,
        includedSkillCount: 1,
        truncatedSkillCount: 0
      }
    }
  });

  // Mutate returned activity's metadata
  if (initial.eccMetadata) {
    (initial.eccMetadata.skillIds as string[]).push("skill:corrupt");
    if (initial.eccMetadata.optimization) {
      (initial.eccMetadata.optimization as any).savingsRatio = 0.0;
    }
  }

  // Next service.list() must return pristine metadata
  const list = service.list();
  const retrieved = list.find((a) => a.id === "subagent-snap")!;
  assert.deepEqual(retrieved.eccMetadata?.skillIds, ["skill:react"]);
  assert.equal(retrieved.eccMetadata?.optimization?.savingsRatio, 0.5);
});

test("ecc-telemetry: Assertion 4 - ECC savingsRatio=0 and empty skills handling", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const zeroActivity = service.recordInvocation({
    id: "subagent-zero",
    role: "ecc:Minimalist",
    eccMetadata: {
      source: "ecc",
      agentId: "agent:minimalist",
      skillIds: [], // Empty skills array
      optimization: {
        originalBytes: 100,
        compactedBytes: 100,
        savingsRatio: 0, // Zero savings ratio
        includedSkillCount: 0,
        truncatedSkillCount: 0
      }
    }
  });

  assert.ok(zeroActivity.eccMetadata);
  assert.deepEqual(zeroActivity.eccMetadata.skillIds, []);
  assert.equal(zeroActivity.eccMetadata.optimization?.savingsRatio, 0);

  // Formatting helpers simulation:
  const badgeVisible = Boolean(zeroActivity.eccMetadata);
  assert.equal(badgeVisible, true);

  const savingsRatio = zeroActivity.eccMetadata.optimization?.savingsRatio;
  const savingsText = typeof savingsRatio === "number" ? `${Math.round(savingsRatio * 100)}% saved` : null;
  assert.equal(savingsText, "0% saved");

  const skillsEmpty = zeroActivity.eccMetadata.skillIds.length === 0;
  const skillsDisplay = skillsEmpty ? "No attached skills" : zeroActivity.eccMetadata.skillIds.join(", ");
  assert.equal(skillsDisplay, "No attached skills");
});

test("ecc-telemetry: Assertion 5 - non-ECC record/update -> metadata undefined and zero regression", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  // Record traditional subagent invocation without ECC metadata
  const traditional = service.recordInvocation({
    id: "standard-subagent",
    role: "Codebase Researcher",
    model: "gemini-2.5-flash",
    prompt: "Search repository for auth hooks"
  });

  assert.equal(traditional.eccMetadata, undefined);

  service.updateStatus({ id: "standard-subagent", status: "completed" });
  const retrieved = service.list().find((a) => a.id === "standard-subagent")!;
  assert.equal(retrieved.eccMetadata, undefined);
  assert.equal(retrieved.status, "completed");
  assert.equal(retrieved.role, "Codebase Researcher");
});

test("ecc-telemetry: Dispatcher forwards full eccMetadata to SubagentService", async () => {
  let recordedInput: any = null;
  const mockSubagentService = {
    recordInvocation(input: any) {
      recordedInput = input;
      return { id: input.id, role: input.role, status: "running" };
    }
  } as unknown as SubagentService;

  const mockCatalog = {
    getSnapshot() {
      return {
        revision: "rev-123",
        scannedAt: 1000,
        assets: [
          {
            id: "agent:coder",
            kind: "agent",
            name: "Coder",
            status: "active",
            reasons: [],
            sha256: "hash1"
          },
          {
            id: "skill:git",
            kind: "skill",
            name: "Git Master",
            status: "active",
            reasons: [],
            sha256: "hash2"
          }
        ]
      };
    },
    async loadSelected() {
      return [
        {
          summary: { id: "agent:coder", name: "Coder", kind: "agent", status: "active", reasons: [], sha256: "h1" },
          content: "You are an expert coder."
        },
        {
          summary: { id: "skill:git", name: "Git Master", kind: "skill", status: "active", reasons: [], sha256: "h2" },
          content: "Always rebase cleanly."
        }
      ];
    }
  } as unknown as EccCatalogService;

  const dispatcher = new EccDispatcherService(mockCatalog, mockSubagentService);

  const result = await dispatcher.dispatch({
    catalogRevision: "rev-123",
    agentId: "agent:coder",
    skillIds: ["skill:git"],
    task: "Implement feature X"
  });

  assert.equal(result.accepted, true);
  assert.ok(recordedInput);
  assert.ok(recordedInput.eccMetadata);
  assert.equal(recordedInput.eccMetadata.source, "ecc");
  assert.equal(recordedInput.eccMetadata.agentId, "agent:coder");
  assert.deepEqual(recordedInput.eccMetadata.skillIds, ["skill:git"]);
  assert.ok(recordedInput.eccMetadata.optimization);
  assert.equal(recordedInput.eccMetadata.optimization.includedSkillCount, 1);
});
