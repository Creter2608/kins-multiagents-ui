import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PtyService } from "./services/PtyService.js";
import { LoopStateService } from "./services/LoopStateService.js";
import { McpMonitorService } from "./services/McpMonitorService.js";
import { CriticalLogService } from "./services/CriticalLogService.js";
import { TelemetryService } from "./services/TelemetryService.js";
import { DockerStatusService } from "./services/DockerStatusService.js";
import { RollbackService } from "./services/RollbackService.js";
import { registerIpcHandlers } from "./ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let teardownIpc: (() => void) | null = null;

// Instantiate backend services
const projectRoot = process.cwd();
const ptyService = new PtyService(projectRoot);
const loopService = new LoopStateService();
const mcpService = new McpMonitorService(projectRoot);
const logService = new CriticalLogService();
const telemetryService = new TelemetryService();
const dockerService = new DockerStatusService();
const rollbackService = new RollbackService(projectRoot);

// Connect docker status updates to telemetry service
dockerService.subscribe((status) => {
  telemetryService.updateDockerStatus(status);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#090d16",
    title: "Kins Multi-Agents Cockpit",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Start background monitoring services
  loopService.start();
  mcpService.start();
  logService.start();
  dockerService.start();

  teardownIpc = registerIpcHandlers(mainWindow, {
    pty: ptyService,
    loop: loopService,
    mcp: mcpService,
    logs: logService,
    telemetry: telemetryService,
    rollback: rollbackService
  });

  // Check if running in dev mode or prod
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../renderer/index.html");
    void mainWindow.loadFile(indexPath);
  }

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
});
