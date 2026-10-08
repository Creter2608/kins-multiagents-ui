import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessService } from "../src/main/services/HarnessService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { SessionJournal } from "../src/main/harness/SessionJournal.js";
import { SandboxPolicy } from "../src/main/harness/SandboxPolicy.js";
import {
  ToolPlanExecutor,
  type RegisteredTool
} from "../src/main/harness/ToolPlanExecutor.js";
import type { ToolPlan } from "../src/shared/harnessContracts.js";

test("A: project switching must not expose the previous project's journal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-project-isolation-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);

  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService(projectA);
  const harness = new HarnessService(path.join(root, "sidecar"), "run-a");
  const ingestion = new TranscriptIngestionService(telemetry, mcp);
  ingestion.setHarnessService(harness);

  try {
    await ingestion.setProjectRoot(projectA);
    await harness.recordEvent({
      source: "tool",
      kind: "tool_dispatch",
      stepId: "project-a-operation",
      data: { tool: "read_file", projectMarker: "PROJECT_A_ONLY" }
    });
    await harness.flush();

    // This lifecycle seam must either complete isolation or explicitly reject
    // switching until the authoritative transaction can do so.
    await ingestion.setProjectRoot(projectB);

    const events = await harness.getEvents();
    assert.equal(
      events.some((event) => event.stepId === "project-a-operation"),
      false,
      "The newly active project must not expose project A's activity"
    );
  } finally {
    ingestion.dispose();
    await harness.dispose();
    mcp.dispose();
    telemetry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B: transcript ingestion must not persist or publish raw credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-credential-boundary-"));
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService(root);
  const harness = new HarnessService(path.join(root, "sidecar"), "credential-run");
  const ingestion = new TranscriptIngestionService(telemetry, mcp);
  ingestion.setHarnessService(harness);

  const published: unknown[] = [];
  const unsubscribe = harness.subscribe((event) => published.push(event));
  const secret = "AUDIT_SECRET_63ad19f2";

  try {
    ingestion.processLine(JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [{
        id: "credential-call",
        name: "run_command",
        args: {
          apiKey: secret,
          headers: { Authorization: `Bearer ${secret}` },
          CommandLine: `client --password=${secret}`
        }
      }]
    }));

    await harness.flush();

    assert.equal(
      JSON.stringify(await harness.getEvents()).includes(secret),
      false,
      "Journal reads must not expose raw credentials"
    );
    assert.equal(
      JSON.stringify(published).includes(secret),
      false,
      "Live IPC-bound observations must not expose raw credentials"
    );

    // Check durable bytes too: filtering only the read API is insufficient.
    await harness.dispose();

    const contents: string[] = [];
    function readFiles(directory: string): void {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          readFiles(filename);
        } else if (entry.isFile()) {
          contents.push(fs.readFileSync(filename, "utf8"));
        }
      }
    }
    readFiles(path.join(root, "sidecar"));

    assert.equal(
      contents.some((content) => content.includes(secret)),
      false,
      "Raw credentials must not be written to durable sidecar storage"
    );
  } finally {
    unsubscribe();
    ingestion.dispose();
    await harness.dispose();
    mcp.dispose();
    telemetry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C: an unknown later tool must reject the whole plan before dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-plan-prevalidation-"));
  const journal = new SessionJournal(root, "prevalidation-run");
  const policy = new SandboxPolicy({
    mode: "read-only",
    targetRoot: root,
    readableRoots: [root],
    writableRoots: [],
    protectedRoots: []
  });

  let dispatches = 0;
  const tool: RegisteredTool = {
    name: "known_read",
    effect: "read",
    async execute() {
      dispatches++;
      return { output: "observed" };
    }
  };
  const executor = new ToolPlanExecutor([tool], journal, policy);
  const plan: ToolPlan = {
    version: 1,
    steps: [
      { id: "first", tool: "known_read", args: {} },
      { id: "second", tool: "unregistered_tool", args: {} }
    ]
  };

  try {
    // Either a rejected promise or an explicit rejection result is acceptable;
    // no operation may precede discovery of the invalid second step.
    await executor.execute(plan, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => {
        assert.ok(error instanceof Error);
      }
    );

    assert.equal(dispatches, 0, "Complete-plan validation must precede dispatch");
    const events = await journal.readAfter(0);
    assert.equal(
      events.some((event) => event.kind === "tool_dispatch"),
      false,
      "An invalid plan must not record execution intent for its valid prefix"
    );
  } finally {
    await journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
