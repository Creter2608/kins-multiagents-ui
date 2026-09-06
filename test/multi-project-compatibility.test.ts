import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RollbackService } from "../src/main/services/RollbackService.js";
import { EvalHarnessService } from "../src/main/services/EvalHarnessService.js";
import { McpMonitorService, PROJECT_MCP_CONFIG_PATHS } from "../src/main/services/McpMonitorService.js";
import { ProjectService, type ProjectScopedServices } from "../src/main/services/ProjectService.js";
import type { LoopStateSnapshot } from "../src/shared/contracts.js";
import type { ArchitecturalCompliance, EvaluationReport } from "../src/shared/harness.js";

test("PROJECT_MCP_CONFIG_PATHS includes standard multi-IDE configuration locations", () => {
  assert.ok(PROJECT_MCP_CONFIG_PATHS.includes("mcp.json"));
  assert.ok(PROJECT_MCP_CONFIG_PATHS.includes(".cursor/mcp.json"));
  assert.ok(PROJECT_MCP_CONFIG_PATHS.includes(".vscode/mcp.json"));
  assert.ok(PROJECT_MCP_CONFIG_PATHS.includes(".mcp.json"));
});

test("RollbackService: resolves local script if present in project root", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-local-"));
  try {
    const projectScriptsDir = path.join(tempDir, "scripts");
    fs.mkdirSync(projectScriptsDir, { recursive: true });
    const localScript = path.join(projectScriptsDir, "ai-loop.mjs");
    fs.writeFileSync(localScript, "// local ai-loop", "utf-8");

    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-app-"));
    const appScriptsDir = path.join(appDir, "scripts");
    fs.mkdirSync(appScriptsDir, { recursive: true });
    fs.writeFileSync(path.join(appScriptsDir, "ai-loop.mjs"), "// app ai-loop", "utf-8");

    const service = new RollbackService(tempDir, appDir);
    const res = service.resolveRollbackScript();

    assert.ok(res !== null);
    assert.equal(path.resolve(res.scriptPath), path.resolve(localScript));
    assert.deepEqual(res.additionalArgs, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("RollbackService: falls back to app root script with --state-file if project lacks scripts/ai-loop.mjs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-ext-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-app-"));
  try {
    const appScriptsDir = path.join(appDir, "scripts");
    fs.mkdirSync(appScriptsDir, { recursive: true });
    const appScript = path.join(appScriptsDir, "ai-loop.mjs");
    fs.writeFileSync(appScript, "// app ai-loop", "utf-8");

    const service = new RollbackService(tempDir, appDir);
    const res = service.resolveRollbackScript();

    assert.ok(res !== null);
    assert.equal(path.resolve(res.scriptPath), path.resolve(appScript));
    const expectedStateFile = path.join(path.resolve(tempDir), ".ai", "state.json");
    assert.deepEqual(res.additionalArgs, ["--state-file", expectedStateFile]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("RollbackService: returns null resolution and graceful failure if neither project nor app root has script", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-none-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-empty-app-"));
  try {
    const service = new RollbackService(tempDir, appDir);
    const res = service.resolveRollbackScript();
    assert.equal(res, null);

    const rollbackResult = await service.executeRollback();
    assert.equal(rollbackResult.success, false);
    assert.ok(rollbackResult.message.includes("not found in project or application root"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("EvalHarnessService: resolves local runner if present in project scripts/harness/runner.mjs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-local-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-app-"));
  try {
    const projectHarnessDir = path.join(tempDir, "scripts", "harness");
    fs.mkdirSync(projectHarnessDir, { recursive: true });
    const localRunner = path.join(projectHarnessDir, "runner.mjs");
    fs.writeFileSync(localRunner, "// local runner", "utf-8");

    const appHarnessDir = path.join(appDir, "scripts", "harness");
    fs.mkdirSync(appHarnessDir, { recursive: true });
    fs.writeFileSync(path.join(appHarnessDir, "runner.mjs"), "// app runner", "utf-8");

    const service = new EvalHarnessService(tempDir);
    service.setAppRootForTesting(appDir);

    const resolved = service.resolveRunnerPath();
    assert.ok(resolved !== null);
    assert.equal(path.resolve(resolved), path.resolve(localRunner));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("EvalHarnessService: falls back to app root runner if external project lacks runner.mjs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ext-"));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-app-"));
  try {
    const appHarnessDir = path.join(appDir, "scripts", "harness");
    fs.mkdirSync(appHarnessDir, { recursive: true });
    const appRunner = path.join(appHarnessDir, "runner.mjs");
    fs.writeFileSync(appRunner, "// app runner", "utf-8");

    const service = new EvalHarnessService(tempDir);
    service.setAppRootForTesting(appDir);

    const resolved = service.resolveRunnerPath();
    assert.ok(resolved !== null);
    assert.equal(path.resolve(resolved), path.resolve(appRunner));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("McpMonitorService: discovers MCP servers across .cursor/mcp.json, .vscode/mcp.json with deduplication", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-multi-"));
  try {
    const cursorDir = path.join(tempDir, ".cursor");
    const vscodeDir = path.join(tempDir, ".vscode");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(vscodeDir, { recursive: true });

    fs.writeFileSync(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "cursor-specific": { command: "node", args: ["cursor.js"] },
          "shared-server": { command: "node", args: ["cursor-shared.js"] }
        }
      }),
      "utf-8"
    );

    fs.writeFileSync(
      path.join(vscodeDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "shared-server": { command: "node", args: ["vscode-shared.js"] },
          "vscode-specific": { command: "node", args: ["vscode.js"] }
        }
      }),
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "root-server": { command: "node", args: ["root.js"] }
        }
      }),
      "utf-8"
    );

    const service = new McpMonitorService(tempDir);
    const snapshot = await service.refresh();

    const serverNames = snapshot.servers.map((s) => s.name);
    assert.ok(serverNames.includes("root-server"));
    assert.ok(serverNames.includes("cursor-specific"));
    assert.ok(serverNames.includes("vscode-specific"));
    assert.ok(serverNames.includes("shared-server"));

    const sharedOccurrences = serverNames.filter((name) => name === "shared-server");
    assert.equal(sharedOccurrences.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ProjectService: resets telemetry session on successful project switch to prevent token bleed", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-telemetry-"));
  const defaultDir = path.join(tempDir, "project-1");
  const targetDir = path.join(tempDir, "project-2");
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const configFile = path.join(tempDir, "recent-projects.json");

  let resetCallCount = 0;
  const mockServices: ProjectScopedServices = {
    ptyService: { setProjectRoot: async () => {} },
    loopStateService: { setProjectRoot: async () => {} },
    mcpMonitorService: { setProjectRoot: async () => {} },
    rollbackService: { setProjectRoot: async () => {} },
    telemetryService: {
      resetCurrentSession: () => {
        resetCallCount++;
      }
    }
  };

  try {
    const service = new ProjectService(configFile, defaultDir, mockServices);
    await service.initialize();
    assert.equal(resetCallCount, 0, "Initialize should not reset telemetry session");

    await service.switchProject(targetDir);
    assert.equal(resetCallCount, 1, "switchProject should trigger telemetry resetCurrentSession");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AQI Display Contract: nullish fallback selects loopState compliance when report is absent or lacking", () => {
  const mockLoopCompliance: ArchitecturalCompliance = {
    aqi: 4.85,
    passed: true,
    taskType: "feature",
    criteriaScores: {
      surgicalDiff: 5.0,
      simplicity: 4.8,
      modularity: 4.7,
      maintainability: 4.9
    },
    feedback: ["High compliance"]
  };

  const mockReportCompliance: ArchitecturalCompliance = {
    aqi: 3.2,
    passed: false,
    taskType: "bugfix",
    criteriaScores: {
      surgicalDiff: 3.0,
      simplicity: 3.2,
      modularity: 3.5,
      maintainability: 3.1
    },
    feedback: ["Diff too large"]
  };

  const resolvedNone = (undefined as EvaluationReport | undefined)?.architecturalCompliance ??
    (undefined as LoopStateSnapshot | undefined)?.architecturalCompliance;
  assert.equal(resolvedNone, undefined);

  const loopStateOnly = { architecturalCompliance: mockLoopCompliance } as LoopStateSnapshot;
  const reportNone = undefined as EvaluationReport | undefined;
  const resolvedLoop = reportNone?.architecturalCompliance ?? loopStateOnly?.architecturalCompliance;
  assert.deepEqual(resolvedLoop, mockLoopCompliance);
  assert.equal(resolvedLoop?.aqi, 4.85);

  const reportWithCompliance = { architecturalCompliance: mockReportCompliance } as EvaluationReport;
  const resolvedReport = reportWithCompliance?.architecturalCompliance ?? loopStateOnly?.architecturalCompliance;
  assert.deepEqual(resolvedReport, mockReportCompliance);
  assert.equal(resolvedReport?.aqi, 3.2);
});
