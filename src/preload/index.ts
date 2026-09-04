import { contextBridge, ipcRenderer } from "electron";
import type {
  CockpitApi,
  PtyExitEvent,
  LoopStateSnapshot,
  McpSnapshot,
  CriticalLogSnapshot,
  CriticalLogEntry,
  TelemetrySnapshot,
  RollbackResult,
  EvalHarnessSnapshot
} from "../shared/contracts.js";

const cockpitApi: CockpitApi = {
  project: {
    getState: () => ipcRenderer.invoke("project:get-state"),
    switchProject: (projectPath: string) => ipcRenderer.invoke("project:switch", projectPath),
    openProjectFolder: () => ipcRenderer.invoke("project:open-folder")
  },
  terminal: {
    start: () => ipcRenderer.invoke("terminal:start"),
    write: (data: string) => ipcRenderer.send("terminal:write", data),
    resize: (cols: number, rows: number) => ipcRenderer.send("terminal:resize", { cols, rows }),
    restart: () => ipcRenderer.invoke("terminal:restart"),
    onData: (listener: (data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: string) => listener(data);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.removeListener("terminal:data", handler);
    },
    onExit: (listener: (event: PtyExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventData: PtyExitEvent) => listener(eventData);
      ipcRenderer.on("terminal:exit", handler);
      return () => ipcRenderer.removeListener("terminal:exit", handler);
    }
  },
  loop: {
    getSnapshot: () => ipcRenderer.invoke("loop:getSnapshot"),
    stepForward: () => ipcRenderer.invoke("loop:stepForward"),
    stepBack: () => ipcRenderer.invoke("loop:stepBack"),
    rollback: () => ipcRenderer.invoke("loop:rollback"),
    reset: () => ipcRenderer.invoke("loop:reset"),
    decideGate: (input) => ipcRenderer.invoke("loop:decideGate", input),
    onSnapshot: (listener: (state: LoopStateSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LoopStateSnapshot) => listener(state);
      ipcRenderer.on("loop:snapshot", handler);
      return () => ipcRenderer.removeListener("loop:snapshot", handler);
    }
  },
  mcp: {
    getSnapshot: () => ipcRenderer.invoke("mcp:getSnapshot"),
    onSnapshot: (listener: (state: McpSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: McpSnapshot) => listener(state);
      ipcRenderer.on("mcp:snapshot", handler);
      return () => ipcRenderer.removeListener("mcp:snapshot", handler);
    }
  },
  logs: {
    getSnapshot: () => ipcRenderer.invoke("logs:getSnapshot"),
    clear: () => ipcRenderer.invoke("logs:clear"),
    onEntries: (listener: (entries: readonly CriticalLogEntry[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, entries: readonly CriticalLogEntry[]) => listener(entries);
      ipcRenderer.on("logs:entries", handler);
      return () => ipcRenderer.removeListener("logs:entries", handler);
    }
  },
  telemetry: {
    getSnapshot: () => ipcRenderer.invoke("telemetry:getSnapshot"),
    resetSession: () => ipcRenderer.invoke("telemetry:resetSession"),
    onSnapshot: (listener: (state: TelemetrySnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: TelemetrySnapshot) => listener(state);
      ipcRenderer.on("telemetry:snapshot", handler);
      return () => ipcRenderer.removeListener("telemetry:snapshot", handler);
    }
  },
  eval: {
    getSnapshot: () => ipcRenderer.invoke("eval:getSnapshot"),
    runBenchmark: () => ipcRenderer.invoke("eval:runBenchmark"),
    onSnapshot: (listener: (state: EvalHarnessSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: EvalHarnessSnapshot) => listener(state);
      ipcRenderer.on("eval:snapshot", handler);
      return () => ipcRenderer.removeListener("eval:snapshot", handler);
    }
  }
};

contextBridge.exposeInMainWorld("cockpitApi", cockpitApi);
