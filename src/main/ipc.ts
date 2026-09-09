import { ipcMain, dialog, type BrowserWindow } from "electron";
import type { PtyService } from "./services/PtyService.js";
import type { LoopStateService } from "./services/LoopStateService.js";
import type { McpMonitorService } from "./services/McpMonitorService.js";
import type { CriticalLogService } from "./services/CriticalLogService.js";
import type { TelemetryService } from "./services/TelemetryService.js";
import type { RollbackService } from "./services/RollbackService.js";
import type { ProjectService } from "./services/ProjectService.js";
import type { EvalHarnessService } from "./services/EvalHarnessService.js";
import type { SubagentService } from "./services/SubagentService.js";
import { SUBAGENT_IPC_CHANNELS, type ProjectState } from "../shared/contracts.js";

export interface ServiceContainer {
  project: ProjectService;
  pty: PtyService;
  loop: LoopStateService;
  mcp: McpMonitorService;
  logs: CriticalLogService;
  telemetry: TelemetryService;
  rollback: RollbackService;
  evalHarness: EvalHarnessService;
  subagents?: SubagentService | undefined;
}

export function registerIpcHandlers(window: BrowserWindow, services: ServiceContainer): () => void {
  const broadcastProjectSwitch = (projectState: ProjectState) => {
    if (!window.isDestroyed()) {
      window.webContents.send("project:changed", projectState);
      window.webContents.send("loop:snapshot", services.loop.getSnapshot());
      window.webContents.send("mcp:snapshot", services.mcp.getSnapshot());
      window.webContents.send("logs:entries", services.logs.getSnapshot().entries);
      window.webContents.send("telemetry:snapshot", services.telemetry.getSnapshot());
      window.webContents.send("eval:snapshot", services.evalHarness.getSnapshot());
      if (services.subagents) {
        window.webContents.send(SUBAGENT_IPC_CHANNELS.changed, services.subagents.list());
      }
      window.webContents.send("terminal:clear");
    }
  };

  services.project.setOnProjectSwitched?.((projectState) => {
    broadcastProjectSwitch(projectState);
  });

  services.project.setOnWorkspaceContextChanged?.((ctx) => {
    if (!window.isDestroyed()) {
      window.webContents.send("project:workspace-context-changed", ctx);
    }
  });

  // Project
  ipcMain.handle("project:get-state", async () => {
    return services.project.getState();
  });

  ipcMain.handle("project:get-workspace-context", async () => {
    return services.project.getWorkspaceContext?.() ?? null;
  });

  ipcMain.handle("project:sync-global-ide-rules", async (_event, options) => {
    return services.project.syncGlobalIdeRules?.(options) ?? { success: false, synced: [] };
  });

  ipcMain.handle("project:equip-stealth-rules", async (_event, options) => {
    return services.project.equipStealthRules?.(options) ?? { success: false, filesCreated: [], excluded: false };
  });

  ipcMain.handle("project:unequip-stealth-rules", async () => {
    return services.project.unequipStealthRules?.() ?? { success: false, filesRemoved: [] };
  });

  ipcMain.handle("project:get-stealth-status", async () => {
    return services.project.getStealthStatus?.() ?? { equipped: false, excluded: false, files: [] };
  });

  ipcMain.handle("project:switch", async (_event, projectPath: string) => {
    const nextState = await services.project.switchProject(projectPath);
    return nextState;
  });

  ipcMain.handle("project:open-folder", async () => {
    const res = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"]
    });
    if (res.canceled || res.filePaths.length === 0 || !res.filePaths[0]) {
      return null;
    }
    const nextState = await services.project.switchProject(res.filePaths[0]);
    return nextState;
  });
  // Terminal
  ipcMain.handle("terminal:start", async () => {
    services.pty.start();
  });

  ipcMain.on("terminal:write", (_event, data: string) => {
    if (typeof data === "string") {
      services.pty.write(data);
    }
  });

  ipcMain.on("terminal:resize", (_event, { cols, rows }: { cols: number; rows: number }) => {
    services.pty.resize(cols, rows);
  });

  ipcMain.handle("terminal:restart", async () => {
    await services.pty.restart();
  });

  const unsubs: Array<() => void> = [];

  unsubs.push(
    services.pty.onData((data) => {
      if (!window.isDestroyed()) {
        window.webContents.send("terminal:data", data);
      }
    })
  );

  unsubs.push(
    services.pty.onExit((event) => {
      if (!window.isDestroyed()) {
        window.webContents.send("terminal:exit", event);
      }
    })
  );

  // Loop
  ipcMain.handle("loop:getSnapshot", async () => {
    return services.loop.getSnapshot();
  });

  ipcMain.handle("loop:stepForward", async () => {
    return services.loop.stepForward();
  });

  ipcMain.handle("loop:stepBack", async () => {
    const res = await services.rollback.executeRollback();
    if (!res.success) {
      return services.loop.stepBack();
    }
    return res;
  });

  ipcMain.handle("loop:rollback", async () => {
    const res = await services.rollback.executeRollback();
    if (!res.success) {
      return services.loop.stepBack();
    }
    return res;
  });

  ipcMain.handle("loop:reset", async () => {
    return await services.loop.resetLoop();
  });

  ipcMain.handle("loop:decideGate", async (_event, input) => {
    return await services.loop.decideGate(input);
  });

  ipcMain.handle("loop:evaluateArchitecture", async () => {
    return await services.loop.evaluateArchitecture();
  });

  unsubs.push(
    services.loop.subscribe((snapshot) => {
      if (!window.isDestroyed()) {
        window.webContents.send("loop:snapshot", snapshot);
      }
    })
  );

  // MCP
  ipcMain.handle("mcp:getSnapshot", async () => {
    return services.mcp.getSnapshot();
  });

  unsubs.push(
    services.mcp.subscribe((snapshot) => {
      if (!window.isDestroyed()) {
        window.webContents.send("mcp:snapshot", snapshot);
      }
    })
  );

  // Logs
  ipcMain.handle("logs:getSnapshot", async () => {
    return services.logs.getSnapshot();
  });

  ipcMain.handle("logs:clear", async () => {
    services.logs.clearLogs();
    return { success: true };
  });

  unsubs.push(
    services.logs.subscribe((entries) => {
      if (!window.isDestroyed()) {
        window.webContents.send("logs:entries", entries);
      }
    })
  );

  // Telemetry
  ipcMain.handle("telemetry:getSnapshot", async () => {
    return services.telemetry.getSnapshot();
  });

  ipcMain.handle("telemetry:resetSession", async () => {
    services.telemetry.resetCurrentSession();
    return { success: true };
  });

  unsubs.push(
    services.telemetry.subscribe((snapshot) => {
      if (!window.isDestroyed()) {
        window.webContents.send("telemetry:snapshot", snapshot);
      }
    })
  );

  // Eval Harness
  ipcMain.handle("eval:getSnapshot", async () => {
    return services.evalHarness.getSnapshot();
  });

  ipcMain.handle("eval:runBenchmark", async () => {
    return await services.evalHarness.runBenchmark();
  });

  unsubs.push(
    services.evalHarness.onSnapshot((snapshot) => {
      if (!window.isDestroyed()) {
        window.webContents.send("eval:snapshot", snapshot);
      }
    })
  );

  // Subagents
  if (services.subagents) {
    ipcMain.handle(SUBAGENT_IPC_CHANNELS.list, async () => {
      return services.subagents!.list();
    });

    unsubs.push(
      services.subagents.subscribe((activities) => {
        if (!window.isDestroyed()) {
          window.webContents.send(SUBAGENT_IPC_CHANNELS.changed, activities);
        }
      })
    );
  }

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
    ipcMain.removeHandler("project:get-state");
    ipcMain.removeHandler("project:get-workspace-context");
    ipcMain.removeHandler("project:sync-global-ide-rules");
    ipcMain.removeHandler("project:equip-stealth-rules");
    ipcMain.removeHandler("project:unequip-stealth-rules");
    ipcMain.removeHandler("project:get-stealth-status");
    ipcMain.removeHandler("project:switch");
    ipcMain.removeHandler("project:open-folder");
    ipcMain.removeHandler("terminal:start");
    ipcMain.removeAllListeners("terminal:write");
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeHandler("terminal:restart");
    ipcMain.removeHandler("loop:getSnapshot");
    ipcMain.removeHandler("loop:stepForward");
    ipcMain.removeHandler("loop:stepBack");
    ipcMain.removeHandler("loop:rollback");
    ipcMain.removeHandler("loop:reset");
    ipcMain.removeHandler("loop:decideGate");
    ipcMain.removeHandler("loop:evaluateArchitecture");
    ipcMain.removeHandler("mcp:getSnapshot");
    ipcMain.removeHandler("logs:getSnapshot");
    ipcMain.removeHandler("logs:clear");
    ipcMain.removeHandler("telemetry:getSnapshot");
    ipcMain.removeHandler("telemetry:resetSession");
    ipcMain.removeHandler("eval:getSnapshot");
    ipcMain.removeHandler("eval:runBenchmark");
    ipcMain.removeHandler(SUBAGENT_IPC_CHANNELS.list);
  };
}
