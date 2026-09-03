import { ipcMain, type BrowserWindow } from "electron";
import type { PtyService } from "./services/PtyService.js";
import type { LoopStateService } from "./services/LoopStateService.js";
import type { McpMonitorService } from "./services/McpMonitorService.js";
import type { CriticalLogService } from "./services/CriticalLogService.js";
import type { TelemetryService } from "./services/TelemetryService.js";
import type { RollbackService } from "./services/RollbackService.js";

export interface ServiceContainer {
  pty: PtyService;
  loop: LoopStateService;
  mcp: McpMonitorService;
  logs: CriticalLogService;
  telemetry: TelemetryService;
  rollback: RollbackService;
}

export function registerIpcHandlers(window: BrowserWindow, services: ServiceContainer): () => void {
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

  ipcMain.handle("loop:rollback", async () => {
    return await services.rollback.executeRollback();
  });

  ipcMain.handle("loop:reset", async () => {
    return await services.loop.resetLoop();
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

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
    ipcMain.removeHandler("terminal:start");
    ipcMain.removeAllListeners("terminal:write");
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeHandler("terminal:restart");
    ipcMain.removeHandler("loop:getSnapshot");
    ipcMain.removeHandler("loop:rollback");
    ipcMain.removeHandler("loop:reset");
    ipcMain.removeHandler("mcp:getSnapshot");
    ipcMain.removeHandler("logs:getSnapshot");
    ipcMain.removeHandler("telemetry:getSnapshot");
    ipcMain.removeHandler("telemetry:resetSession");
  };
}
