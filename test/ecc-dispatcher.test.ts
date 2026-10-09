import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EccCatalogService } from "../src/main/services/EccCatalogService.js";
import { EccDispatcherService } from "../src/main/services/EccDispatcherService.js";
import { SubagentService } from "../src/main/services/SubagentService.js";

function createFixture(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentsDir = path.join(root, "agents");
  const skillsDir = path.join(root, "skills");

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "perf-tuning"), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "test-suite"), { recursive: true });

  // 1. Valid Agent
  fs.writeFileSync(
    path.join(agentsDir, "architect.md"),
    `---
name: Architect
description: Cloud infrastructure architect
model: claude-3-opus
tools: read_file
---
# System Architecture Rules
Follow distributed system best practices.`,
    "utf8"
  );

  // 2. Quarantined Agent (contains bidi control char)
  fs.writeFileSync(
    path.join(agentsDir, "bad-agent.md"),
    `---
name: Malicious
description: Has hidden char
---
Dangerous\u200Btext`,
    "utf8"
  );

  // 3. Valid Skill 1
  fs.writeFileSync(
    path.join(skillsDir, "perf-tuning", "SKILL.md"),
    `---
name: Performance Tuning
description: CPU and memory profiling
---
# Perf Guide
Use pprof and火焰图 to optimize latency.`,
    "utf8"
  );

  // 4. Quarantined Skill (contains script tag)
  fs.writeFileSync(
    path.join(skillsDir, "test-suite", "SKILL.md"),
    `---
name: XSS Skill
description: Malicious
---
<script>alert(1)</script>`,
    "utf8"
  );

  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
}

test("ecc-dispatcher: Assertion 1 - stale catalog revision rejection", async () => {
  const fixture = createFixture("ecc-disp-stale-");
  try {
    const catalog = new EccCatalogService(fixture.root);
    const subagents = new SubagentService();
    const dispatcher = new EccDispatcherService(catalog, subagents);

    const snapshot = await catalog.getSnapshot();

    const result = await dispatcher.dispatch({
      catalogRevision: "stale-revision-hash",
      agentId: "agent:architect",
      skillIds: ["skill:perf-tuning"],
      task: "Analyze latency"
    });

    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.reason, "STALE_CATALOG");
      assert.ok(result.message?.includes("stale"));
    }
  } finally {
    fixture.cleanup();
  }
});

test("ecc-dispatcher: Assertion 2 - quarantined agent and skill rejection", async () => {
  const fixture = createFixture("ecc-disp-quar-");
  try {
    const catalog = new EccCatalogService(fixture.root);
    const subagents = new SubagentService();
    const dispatcher = new EccDispatcherService(catalog, subagents);

    const snapshot = await catalog.getSnapshot();

    // 1. Quarantined agent
    const agentRes = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:bad-agent",
      skillIds: [],
      task: "Do task"
    });
    assert.equal(agentRes.accepted, false);
    if (!agentRes.accepted) {
      assert.equal(agentRes.reason, "QUARANTINED");
    }

    // 2. Quarantined skill attached to valid agent
    const skillRes = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:architect",
      skillIds: ["skill:test-suite"],
      task: "Do task"
    });
    assert.equal(skillRes.accepted, false);
    if (!skillRes.accepted) {
      assert.equal(skillRes.reason, "QUARANTINED");
    }
  } finally {
    fixture.cleanup();
  }
});

test("ecc-dispatcher: Assertion 3 - context limit ceiling enforcement", async () => {
  const fixture = createFixture("ecc-disp-limit-");
  try {
    const catalog = new EccCatalogService(fixture.root);
    const subagents = new SubagentService();
    // Configure tight context limit of 150 bytes
    const dispatcher = new EccDispatcherService(catalog, subagents, {
      maxContextBytes: 150
    });

    const snapshot = await catalog.getSnapshot();

    const result = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:architect",
      skillIds: ["skill:perf-tuning"],
      task: "Analyze database bottleneck"
    });

    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.reason, "CONTEXT_LIMIT");
      assert.ok(result.message?.includes("exceeds context ceiling"));
    }
  } finally {
    fixture.cleanup();
  }
});

test("ecc-dispatcher: Assertion 4 - invalid selection and empty task rejection", async () => {
  const fixture = createFixture("ecc-disp-invalid-");
  try {
    const catalog = new EccCatalogService(fixture.root);
    const subagents = new SubagentService();
    const dispatcher = new EccDispatcherService(catalog, subagents);

    const snapshot = await catalog.getSnapshot();

    // 1. Empty task
    const emptyTask = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:architect",
      skillIds: [],
      task: "   "
    });
    assert.equal(emptyTask.accepted, false);
    if (!emptyTask.accepted) {
      assert.equal(emptyTask.reason, "INVALID_SELECTION");
    }

    // 2. Missing agent
    const missingAgent = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:non-existent",
      skillIds: [],
      task: "Build microservice"
    });
    assert.equal(missingAgent.accepted, false);
    if (!missingAgent.accepted) {
      assert.equal(missingAgent.reason, "INVALID_SELECTION");
    }

    // 3. Missing skill
    const missingSkill = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:architect",
      skillIds: ["skill:non-existent"],
      task: "Build microservice"
    });
    assert.equal(missingSkill.accepted, false);
    if (!missingSkill.accepted) {
      assert.equal(missingSkill.reason, "INVALID_SELECTION");
    }

    // 4. Skill passed as agent
    const skillAsAgent = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "skill:perf-tuning",
      skillIds: [],
      task: "Optimize now"
    });
    assert.equal(skillAsAgent.accepted, false);
    if (!skillAsAgent.accepted) {
      assert.equal(skillAsAgent.reason, "INVALID_SELECTION");
    }
  } finally {
    fixture.cleanup();
  }
});

test("ecc-dispatcher: Assertion 5 - successful dispatch and zero repository pollution", async () => {
  const fixture = createFixture("ecc-disp-success-");
  try {
    const catalog = new EccCatalogService(fixture.root);
    const subagents = new SubagentService();
    const dispatcher = new EccDispatcherService(catalog, subagents);

    const snapshot = await catalog.getSnapshot();

    // Measure files in fixture root before dispatch
    const filesBefore = fs.readdirSync(fixture.root);

    const result = await dispatcher.dispatch({
      catalogRevision: snapshot.revision,
      agentId: "agent:architect",
      skillIds: ["skill:perf-tuning"],
      task: "Audit distributed memory cache and propose multi-region Redis strategy"
    });

    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.ok(result.invocationId.startsWith("ecc-architect-"));

      // Subagent queue verification
      const list = subagents.list();
      assert.equal(list.length, 1);
      const activity = list[0];
      assert.ok(activity);
      assert.equal(activity.id, result.invocationId);
      assert.equal(activity.role, "ecc:Architect");
      assert.equal(activity.model, "claude-3-opus");
      assert.equal(activity.status, "running");

      // Verify synthesized prompt structure
      assert.ok(activity.fullPrompt?.includes("# ECC Agent: Architect"));
      assert.ok(activity.fullPrompt?.includes("## Injected Capability Skills:"));
      assert.ok(activity.fullPrompt?.includes("### Skill: Performance Tuning"));
      assert.ok(activity.fullPrompt?.includes("## Active Mission Task:"));
      assert.ok(activity.fullPrompt?.includes("Audit distributed memory cache"));
    }

    // Verify zero target repository pollution: no foreign directories created
    const filesAfter = fs.readdirSync(fixture.root);
    assert.deepEqual(filesAfter.sort(), filesBefore.sort());
  } finally {
    fixture.cleanup();
  }
});
