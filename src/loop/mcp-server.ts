import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonFileLoopStateStore } from "./LoopStateStore.js";
import { LoopCommandService } from "./LoopCommandService.js";
import {
  handleAgentLoopStatus,
  handleAgentLoopTransition,
  type AgentLoopStatusInput,
  type AgentLoopTransitionInput
} from "./mcp-tools.js";

export const MCP_TOOLS_LIST = [
  {
    name: "agent_loop_status",
    description: "Query current state snapshot of the Canonical Autonomous Loop v2.0",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Optional expected run ID to validate against active run"
        }
      }
    }
  },
  {
    name: "agent_loop_transition",
    description: "Transition canonical loop phase with optimistic concurrency control and gate invariants",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Deterministic run identifier of the active loop"
        },
        expectedPhase: {
          type: "string",
          description: "Expected current phase before transition (anti-race condition)"
        },
        action: {
          type: "string",
          enum: ["advance", "approve", "reject"],
          description: "Transition action: 'advance' for canonical flow, 'approve'/'reject' for gates"
        },
        targetPhase: {
          type: "string",
          description: "Optional explicit target phase (must be legal transition)"
        },
        reason: {
          type: "string",
          description: "Required reason when action is 'reject'"
        }
      },
      required: ["runId", "expectedPhase", "action"]
    }
  }
];

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export function handleJsonRpcMessage(
  request: JsonRpcRequest,
  commandService: LoopCommandService
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = request;

  if (method === "notifications/initialized") {
    return Promise.resolve(null);
  }

  if (method === "initialize") {
    return Promise.resolve({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "kins-agent-loop",
          version: "2.5.1"
        }
      }
    });
  }

  if (method === "tools/list") {
    return Promise.resolve({
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS_LIST
      }
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

    if (toolName === "agent_loop_status") {
      return handleAgentLoopStatus(commandService, toolArgs as AgentLoopStatusInput).then((res) => ({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2)
            }
          ],
          isError: !res.ok
        }
      }));
    }

    if (toolName === "agent_loop_transition") {
      return handleAgentLoopTransition(
        commandService,
        toolArgs as unknown as AgentLoopTransitionInput
      ).then((res) => ({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2)
            }
          ],
          isError: !res.ok
        }
      }));
    }

    return Promise.resolve({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Unknown tool: '${toolName}'`
      }
    });
  }

  return Promise.resolve({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: '${method}'`
    }
  });
}

export function startMcpStdioServer(
  stateFilePath: string = path.resolve(".ai/state.json")
): void {
  const store = new JsonFileLoopStateStore(stateFilePath);
  const commandService = new LoopCommandService(store);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest;
      const response = await handleJsonRpcMessage(request, commandService);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err: unknown) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : String(err)}`
          }
        }) + "\n"
      );
    }
  });
}

export function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentPath = fileURLToPath(metaUrl);
    const scriptPath = path.resolve(process.argv[1]);
    return currentPath === scriptPath;
  } catch {
    return false;
  }
}
