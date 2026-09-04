import * as fs from "node:fs";
import * as path from "node:path";
import type { McpSnapshot, McpServerInfo, ToolCallRecord } from "../../shared/contracts.js";

export class McpMonitorService {
  private projectRoot: string;
  private globalMcpDirs: string[];
  private servers: Map<string, McpServerInfo> = new Map();
  private recentCalls: ToolCallRecord[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: McpSnapshot) => void>();

  constructor(
    projectRoot: string = process.cwd(),
    globalMcpDirs: string[] = [
      path.join(process.env.USERPROFILE || process.env.HOME || "", ".gemini", "antigravity", "mcp"),
      path.join(process.env.USERPROFILE || process.env.HOME || "", ".gemini", "antigravity-cli", "mcp")
    ]
  ) {
    this.projectRoot = projectRoot;
    this.globalMcpDirs = globalMcpDirs;
  }

  getSnapshot(): McpSnapshot {
    return {
      servers: Array.from(this.servers.values()),
      recentCalls: [...this.recentCalls],
      lastUpdated: Date.now()
    };
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.projectRoot = path.resolve(projectPath);
    this.refresh();
  }

  refresh(): McpSnapshot {
    const discovered: McpServerInfo[] = [];

    // 1. Scan global ~/.gemini/antigravity*/mcp/ directories
    for (const dir of this.globalMcpDirs) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.endsWith(".disabled")) {
              if (discovered.some((s) => s.name === entry.name)) {
                continue;
              }
              const serverPath = path.join(dir, entry.name);
              const toolFiles = fs.readdirSync(serverPath).filter((f) => f.endsWith(".json"));
              const tools = toolFiles.map((f) => f.replace(/\.json$/, ""));
              discovered.push({
                name: entry.name,
                status: "connected",
                source: "global",
                tools,
                lastObserved: Date.now()
              });
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // 2. Scan project mcp.json
    const projectMcpFile = path.join(this.projectRoot, "mcp.json");
    if (fs.existsSync(projectMcpFile)) {
      try {
        const content = fs.readFileSync(projectMcpFile, "utf-8");
        const parsed = JSON.parse(content);
        if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
          for (const name of Object.keys(parsed.mcpServers)) {
            if (!discovered.some((s) => s.name === name)) {
              discovered.push({
                name,
                status: "configured",
                source: "project",
                tools: [],
                lastObserved: Date.now()
              });
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    this.servers.clear();
    for (const server of discovered) {
      this.servers.set(server.name, server);
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  recordToolCall(record: Omit<ToolCallRecord, "id" | "timestamp">): void {
    const call: ToolCallRecord = {
      ...record,
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now()
    };
    this.recentCalls.unshift(call);
    if (this.recentCalls.length > 50) {
      this.recentCalls = this.recentCalls.slice(0, 50);
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  start(): void {
    this.refresh();
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 4000);
  }

  subscribe(listener: (snapshot: McpSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}
