import { app, BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PtyService } from "./services/PtyService.js";
import { LoopStateService } from "./services/LoopStateService.js";
import { McpMonitorService } from "./services/McpMonitorService.js";
import { CriticalLogService } from "./services/CriticalLogService.js";
import { TelemetryService } from "./services/TelemetryService.js";
import { DockerStatusService } from "./services/DockerStatusService.js";
import { RollbackService } from "./services/RollbackService.js";
import { TranscriptIngestionService } from "./services/TranscriptIngestionService.js";
import { registerIpcHandlers } from "./ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let teardownIpc: (() => void) | null = null;

// Determine absolute project repository root
const projectRoot = path.resolve(__dirname, "../../..");

// Instantiate backend services with deterministic absolute paths
const ptyService = new PtyService(projectRoot);
const loopService = new LoopStateService(path.join(projectRoot, ".ai", "state.json"));
const mcpService = new McpMonitorService(projectRoot);
const logService = new CriticalLogService();
const telemetryService = new TelemetryService();
const dockerService = new DockerStatusService();
const rollbackService = new RollbackService(projectRoot);
const transcriptService = new TranscriptIngestionService(telemetryService, mcpService, loopService);

// Connect docker status updates to telemetry service
dockerService.subscribe((status) => {
  telemetryService.updateDockerStatus(status);
});

function createWindow(): void {
  const preloadPath = path.resolve(__dirname, "../preload/index.cjs");
  if (!fs.existsSync(preloadPath)) {
    console.error(`[CRITICAL] Preload artifact missing at: ${preloadPath}`);
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#000000",
    title: "Kins Multi-Agents Cockpit",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Diagnostics for preload & renderer loading
  mainWindow.webContents.on("preload-error", (_event, pPath, error) => {
    console.error(`[Preload Error] Failed to load ${pPath}:`, error);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[Renderer Load Error] Code: ${errorCode}, Description: ${errorDescription}`);
  });

  // Start background monitoring services
  loopService.start();
  mcpService.start();
  logService.start();
  dockerService.start();
  transcriptService.start();

  teardownIpc = registerIpcHandlers(mainWindow, {
    pty: ptyService,
    loop: loopService,
    mcp: mcpService,
    logs: logService,
    telemetry: telemetryService,
    rollback: rollbackService
  });

  // Push immediate snapshots as soon as renderer is ready
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("loop:snapshot", loopService.getSnapshot());
      mainWindow.webContents.send("mcp:snapshot", mcpService.getSnapshot());
      mainWindow.webContents.send("logs:entries", logService.getSnapshot().entries);
      mainWindow.webContents.send("telemetry:snapshot", telemetryService.getSnapshot());
    }
  });

  // Check if running in dev mode or prod
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.resolve(__dirname, "../../renderer/index.html");
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error("Failed to load index.html:", err);
    });
  }

  // Allow F12 to toggle DevTools for inspection
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (teardownIpc) {
    teardownIpc();
  }
  ptyService.dispose();
  loopService.dispose();
  mcpService.dispose();
  logService.dispose();
  dockerService.dispose();
  telemetryService.dispose();
  transcriptService.dispose();
});
