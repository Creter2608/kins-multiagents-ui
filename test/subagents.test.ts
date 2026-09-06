import test from "node:test";
import assert from "node:assert/strict";
import { SubagentService } from "../src/main/services/SubagentService.js";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";
import type { SubagentActivity } from "../src/shared/contracts.js";

test("subagents: Assertion 1 - invoke record with prompt normalization and initial running status", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const activity = service.recordInvocation({
    id: "sub-a",
    role: "planner",
    model: "gemini-3.8-flash",
    prompt: "   plan   the   feature   task   carefully   ",
    startedAt: 1000
  });

  assert.equal(activity.id, "sub-a");
  assert.equal(activity.role, "planner");
  assert.equal(activity.model, "gemini-3.8-flash");
  assert.equal(activity.promptSummary, "plan the feature task carefully");
  assert.equal(activity.status, "running");
  assert.equal(activity.startedAt, 1000);
  assert.equal(activity.elapsedMs, 0);

  const list = service.list();
  assert.equal(list.length, 1);
  const first = list[0];
  assert.ok(first);
  assert.equal(first.id, "sub-a");
});

test("subagents: Assertion 2 - idle, completion, and non-regression of terminal states", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  service.recordInvocation({ id: "sub-a", role: "coder", startedAt: 1000 });

  // Transition to idle @ 2000
  currentTime = 2000;
  service.updateStatus({ id: "sub-a", status: "idle", timestamp: 2000 });
  let current = service.list()[0];
  assert.ok(current);
  assert.equal(current.status, "idle");
  assert.equal(current.elapsedMs, 1000);

  // Transition to completed @ 5000
  currentTime = 5000;
  service.updateStatus({ id: "sub-a", status: "completed", timestamp: 5000 });
  current = service.list()[0];
  assert.ok(current);
  assert.equal(current.status, "completed");
  assert.equal(current.completedAt, 5000);
  assert.equal(current.elapsedMs, 4000);

  // Attempt to regress back to running @ 6000 -> must remain completed
  currentTime = 6000;
  service.updateStatus({ id: "sub-a", status: "running", timestamp: 6000 });
  current = service.list()[0];
  assert.ok(current);
  assert.equal(current.status, "completed", "Terminal completed state must not regress to running");
  assert.equal(current.completedAt, 5000);
  assert.equal(current.elapsedMs, 4000, "Elapsed duration must stay frozen at completion time");
});

test("subagents: Assertion 3 - replay invoke id=a twice retains original startedAt and is idempotent", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  service.recordInvocation({ id: "sub-a", role: "auditor", startedAt: 1000 });

  currentTime = 2500;
  service.recordInvocation({ id: "sub-a", role: "auditor", startedAt: 2500 });

  const list = service.list();
  assert.equal(list.length, 1, "Must not create duplicate entry on replay");
  const first = list[0];
  assert.ok(first);
  assert.equal(first.startedAt, 1000, "Must retain original startedAt");
  assert.equal(first.elapsedMs, 1500);
});

test("subagents: Assertion 4 - failed result transitions to error and freezes elapsed time", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  service.recordInvocation({ id: "sub-b", role: "tester", startedAt: 1000 });

  currentTime = 4000;
  service.updateStatus({
    id: "sub-b",
    status: "error",
    errorMessage: "Process exited with timeout",
    timestamp: 4000
  });

  const current = service.list()[0];
  assert.ok(current);
  assert.equal(current.status, "error");
  assert.equal(current.errorMessage, "Process exited with timeout");
  assert.equal(current.completedAt, 4000);
  assert.equal(current.elapsedMs, 3000);

  currentTime = 9000;
  const later = service.list()[0];
  assert.ok(later);
  assert.equal(later.elapsedMs, 3000, "Elapsed time on error record must remain frozen");
});

test("subagents: Assertion 5 - prompt truncation at 120 characters and missing metadata defaults", () => {
  const service = new SubagentService(() => 1000);

  const longPrompt = "a".repeat(200);
  const act = service.recordInvocation({
    id: "sub-c",
    prompt: longPrompt
  });

  assert.equal(act.role, "unknown");
  assert.equal(act.model, "unknown");
  assert.equal(act.promptSummary.length, 120);
  assert.equal(act.promptSummary, "a".repeat(120));
  assert.equal(act.fullPrompt, longPrompt);

  const actWithoutPrompt = service.recordInvocation({
    id: "sub-d"
  });
  assert.equal(actWithoutPrompt.promptSummary, "");
  assert.equal(actWithoutPrompt.fullPrompt, undefined);
});

test("subagents: subscription broadcasts immutable snapshots and unsubscribe works cleanly", () => {
  let currentTime = 1000;
  const service = new SubagentService(() => currentTime);

  const captured: SubagentActivity[][] = [];
  const unsub = service.subscribe((activities) => {
    captured.push(activities);
  });

  service.recordInvocation({ id: "sub-1", role: "worker", startedAt: 1000 });
  assert.equal(captured.length, 1);
  const batch0 = captured[0];
  assert.ok(batch0);
  const item0 = batch0[0];
  assert.ok(item0);
  assert.equal(item0.id, "sub-1");

  // Verify snapshot immutability
  const originalRole = service.list()[0]?.role;
  assert.equal(originalRole, "worker");

  // Unsubscribe stops notifications
  unsub();
  service.updateStatus({ id: "sub-1", status: "completed", timestamp: 2000 });
  assert.equal(captured.length, 1, "Should not receive notifications after unsubscribe");

  // Reset clears state and notifies
  const afterResetCapture: SubagentActivity[][] = [];
  service.subscribe((activities) => afterResetCapture.push(activities));
  service.reset();
  assert.equal(service.list().length, 0);
  assert.equal(afterResetCapture.length, 1);
  const resetList = afterResetCapture[0];
  assert.ok(resetList);
  assert.equal(resetList.length, 0);
});

test("subagents: transcript ingestion parses invoke_subagent and updates lifecycle idempotently", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const subagentService = new SubagentService(() => 5000);
  const ingestion = new TranscriptIngestionService(telemetry, mcp, null, null, subagentService);

  // 1. Ingest line with invoke_subagent and array of subagents
  const invokeLine = JSON.stringify({
    step_index: 42,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              id: "sub-worker-1",
              Role: "Unit Tester",
              Model: "gemini-3.8-flash",
              Prompt: "Write unit tests for authentication module"
            },
            {
              id: "sub-worker-2",
              Role: "Security Auditor",
              Model: "inherit",
              Prompt: "Audit code for injection vulnerabilities"
            }
          ]
        }
      }
    ]
  });

  ingestion.processLine(invokeLine);

  let list = subagentService.list();
  assert.equal(list.length, 2);
  const w1 = list.find((s) => s.id === "sub-worker-1");
  const w2 = list.find((s) => s.id === "sub-worker-2");
  assert.ok(w1);
  assert.ok(w2);
  assert.equal(w1.role, "Unit Tester");
  assert.equal(w1.status, "running");
  assert.equal(w2.role, "Security Auditor");
  assert.equal(w2.status, "running");

  // 2. Replaying the same line is idempotent and does not create duplicates
  ingestion.processLine(invokeLine);
  assert.equal(subagentService.list().length, 2);

  // 3. Subagent completion message
  const completionLine = JSON.stringify({
    step_index: 43,
    source: "SUBAGENT",
    type: "SUBAGENT_COMPLETED",
    sender: "sub-worker-1",
    status: "DONE",
    content: "All tests written and passing"
  });
  ingestion.processLine(completionLine);

  list = subagentService.list();
  const updatedW1 = list.find((s) => s.id === "sub-worker-1");
  assert.ok(updatedW1);
  assert.equal(updatedW1.status, "completed");

  // 4. Subagent error result
  const errorResultLine = JSON.stringify({
    step_index: 44,
    source: "TOOL_RESULT",
    type: "TOOL_RESULT",
    tool_call_id: "sub-worker-2",
    status: "ERROR",
    content: "Security scan failed with exit code 1"
  });
  ingestion.processLine(errorResultLine);

  list = subagentService.list();
  const updatedW2 = list.find((s) => s.id === "sub-worker-2");
  assert.ok(updatedW2);
  assert.equal(updatedW2.status, "error");
  assert.equal(updatedW2.errorMessage, "Security scan failed with exit code 1");
});

test("subagents: Assertion 6 - JSON-stringified Subagents args, conversationId binding, and sender completion", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const subagentService = new SubagentService(() => 5000);
  const ingestion = new TranscriptIngestionService(telemetry, mcp, null, null, subagentService);

  // 1. Tool call with stringified Subagents array (exact Antigravity shape)
  const stringifiedInvokeLine = JSON.stringify({
    step_index: 100,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "invoke_subagent",
        args: {
          Subagents: JSON.stringify([
            {
              Role: "Readiness Checker",
              Model: "flash",
              Prompt: "Check package.json"
            },
            {
              Role: "Documentation Inspector",
              Model: "flash",
              Prompt: "Check README.md"
            }
          ])
        }
      }
    ]
  });

  ingestion.processLine(stringifiedInvokeLine);

  let list = subagentService.list();
  assert.equal(list.length, 2, "Must create 2 distinct subagents, not an unknown aggregate");
  const s0 = list.find((s) => s.role === "Readiness Checker");
  const s1 = list.find((s) => s.role === "Documentation Inspector");
  assert.ok(s0);
  assert.ok(s1);
  assert.equal(s0.model, "flash");
  assert.equal(s1.model, "flash");
  assert.equal(s0.status, "running");
  assert.equal(s1.status, "running");

  // 2. Tool output with created subagents conversationId
  const toolResultLine = JSON.stringify({
    step_index: 101,
    source: "MODEL",
    type: "GENERIC",
    content: `Created the following subagents:
{
  "conversationId":  "conv-1111",
  "logAbsoluteUri":  "file:///logs/1.jsonl"
}
{
  "conversationId":  "conv-2222",
  "logAbsoluteUri":  "file:///logs/2.jsonl"
}`
  });

  ingestion.processLine(toolResultLine);

  // 3. SYSTEM_MESSAGE from sender conv-1111 completes only conv-1111
  const messageLine = JSON.stringify({
    step_index: 102,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: "The following is a <SYSTEM_MESSAGE> ... sender=conv-1111 priority=MESSAGE_PRIORITY_HIGH content=Done checking package.json"
  });

  ingestion.processLine(messageLine);

  list = subagentService.list();
  const updatedS0 = list.find((s) => s.role === "Readiness Checker");
  const updatedS1 = list.find((s) => s.role === "Documentation Inspector");
  assert.ok(updatedS0);
  assert.ok(updatedS1);
  assert.equal(updatedS0.status, "completed", "Subagent 0 must be completed by sender=conv-1111");
  assert.equal(updatedS1.status, "running", "Subagent 1 must still be running");

  // 4. manage_subagents kill targeted conv-2222
  const killOneLine = JSON.stringify({
    step_index: 103,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "manage_subagents",
        args: {
          Action: "kill",
          ConversationIds: ["conv-2222"]
        }
      }
    ]
  });
  ingestion.processLine(killOneLine);

  list = subagentService.list();
  const killedS1 = list.find((s) => s.role === "Documentation Inspector");
  assert.ok(killedS1);
  assert.equal(killedS1.status, "completed");

  // 5. manage_subagents kill_all and non-regression of terminal states
  subagentService.recordInvocation({ id: "sub-fresh", role: "Fresh Worker", startedAt: 5000 });
  assert.equal(subagentService.list().find((s) => s.id === "sub-fresh")?.status, "running");

  const killAllLine = JSON.stringify({
    step_index: 104,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "manage_subagents",
        args: {
          Action: "kill_all"
        }
      }
    ]
  });
  ingestion.processLine(killAllLine);

  const fresh = subagentService.list().find((s) => s.id === "sub-fresh");
  assert.ok(fresh);
  assert.equal(fresh.status, "completed", "Fresh worker must be completed by kill_all");
});

