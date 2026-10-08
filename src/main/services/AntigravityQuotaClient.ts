import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AntigravityEndpoint {
  readonly port: number;
  readonly csrfToken: string | null;
}

export interface AntigravityQuotaTransport {
  discover(signal?: AbortSignal): Promise<readonly AntigravityEndpoint[]>;
  getUserStatus(
    endpoint: AntigravityEndpoint,
    signal?: AbortSignal
  ): Promise<unknown>;
}

export interface AntigravityQuotaClientOptions {
  readonly userDataPath?: string | undefined;
}

const MAX_CANDIDATE_ENDPOINTS = 8;
const MAX_RESPONSE_BYTES = 262_144; // 256 KiB
const REQUEST_TIMEOUT_MS = 5_000;
const PROCESS_DISCOVERY_TIMEOUT_MS = 4_000;

export class AntigravityQuotaClient implements AntigravityQuotaTransport {
  private readonly userDataPath?: string | undefined;

  constructor(options?: AntigravityQuotaClientOptions) {
    this.userDataPath = options?.userDataPath;
  }

  /**
   * Discovers candidate Antigravity Language Server endpoints using multi-tier fallback:
   * Tier 1: Environment variables (ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN)
   * Tier 2: Configuration files (ANTIGRAVITY_LS_CONFIG_PATH or userDataPath/antigravity-endpoint.json)
   * Tier 3: Bounded process inspection & loopback listening-port correlation
   */
  async discover(signal?: AbortSignal): Promise<readonly AntigravityEndpoint[]> {
    if (signal?.aborted) {
      return Object.freeze([]);
    }

    try {
      const candidates: AntigravityEndpoint[] = [];
      const seenPairs = new Set<string>();

      const addCandidate = (ep: AntigravityEndpoint | null) => {
        if (!ep || candidates.length >= MAX_CANDIDATE_ENDPOINTS) {
          return;
        }
        if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) {
          return;
        }
        const key = `${ep.port}::${ep.csrfToken ?? ""}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          candidates.push(ep);
        }
      };

      // Tier 1: Environment Variables
      this.discoverFromEnv(addCandidate);

      // Tier 2: Configuration / Endpoint file
      this.discoverFromFile(addCandidate);

      // Tier 3: Process Inspection & Local Port Correlation
      if (candidates.length < MAX_CANDIDATE_ENDPOINTS && !signal?.aborted) {
        await this.discoverFromProcesses(addCandidate, signal);
      }

      return Object.freeze(candidates);
    } catch {
      // Process discovery failure fails closed
      return Object.freeze([]);
    }
  }

  private discoverFromEnv(addCandidate: (ep: AntigravityEndpoint | null) => void): void {
    const envAddress = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
    if (!envAddress) {
      return;
    }

    const endpoint = this.parseAddressString(
      envAddress,
      process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || null
    );
    if (endpoint) {
      addCandidate(endpoint);
    }
  }

  private discoverFromFile(addCandidate: (ep: AntigravityEndpoint | null) => void): void {
    const filePathsToTry: string[] = [];

    const envConfigPath = process.env.ANTIGRAVITY_LS_CONFIG_PATH?.trim();
    if (envConfigPath) {
      filePathsToTry.push(envConfigPath);
    }

    if (this.userDataPath) {
      filePathsToTry.push(path.join(this.userDataPath, "antigravity-endpoint.json"));
    }

    filePathsToTry.push(path.join(process.cwd(), "antigravity-endpoint.json"));
    try {
      filePathsToTry.push(path.join(os.homedir(), ".gemini", "antigravity-endpoint.json"));
    } catch {
      // Ignored if homedir unavailable
    }

    for (const filePath of filePathsToTry) {
      try {
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_RESPONSE_BYTES) {
          continue;
        }
        const rawContent = fs.readFileSync(filePath, "utf8").trim();
        if (!rawContent) {
          continue;
        }

        // 1. Try JSON parsing
        try {
          const parsed = JSON.parse(rawContent);
          if (parsed && typeof parsed === "object") {
            let portNum: number | null = null;
            let csrf: string | null = null;

            if (typeof parsed.csrfToken === "string" && !/[\r\n]/.test(parsed.csrfToken)) {
              csrf = parsed.csrfToken.trim() || null;
            }

            if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) {
              portNum = parsed.port;
            } else if (typeof parsed.address === "string") {
              const ep = this.parseAddressString(parsed.address, csrf);
              if (ep) {
                addCandidate(ep);
                continue;
              }
            }

            if (portNum !== null && portNum >= 1 && portNum <= 65535) {
              addCandidate({ port: portNum, csrfToken: csrf });
              continue;
            }
          }
        } catch {
          // Fall through to plain text decimal port
        }

        // 2. Plain text decimal port
        if (/^\d{1,5}$/.test(rawContent)) {
          const portNum = Number.parseInt(rawContent, 10);
          if (portNum >= 1 && portNum <= 65535) {
            addCandidate({ port: portNum, csrfToken: null });
          }
        }
      } catch {
        // Recoverable tier failure
      }
    }
  }

  private async discoverFromProcesses(
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const isWindows = process.platform === "win32";

    try {
      if (isWindows) {
        await this.discoverWindowsProcesses(addCandidate, signal);
      } else {
        await this.discoverUnixProcesses(addCandidate, signal);
      }
    } catch {
      // Recoverable tier failure
    }
  }

  private async discoverWindowsProcesses(
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const psScript = `
        $procs = Get-CimInstance Win32_Process | Where-Object {
          $_.CommandLine -match 'extension_server_port' -or $_.Name -match 'agy|language_server|antigravity'
        }
        foreach ($p in $procs) {
          Write-Output "PID:$($p.ProcessId)|CMD:$($p.CommandLine)"
        }
      `.trim();

      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { timeout: PROCESS_DISCOVERY_TIMEOUT_MS, signal, windowsHide: true }
      );

      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const relevantPids: number[] = [];

      for (const line of lines) {
        const match = /^PID:(\d+)\|CMD:(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number.parseInt(match[1]!, 10);
        const cmd = match[2]!;

        // 1. Try parsing explicit commandline arguments
        const ep = this.parseCandidateCommandLine(cmd);
        if (ep) {
          addCandidate(ep);
        } else if (Number.isInteger(pid) && pid > 0) {
          relevantPids.push(pid);
        }
      }

      // 2. Correlate PIDs with listening ports on 127.0.0.1
      if (relevantPids.length > 0) {
        await this.correlateWindowsListeningPorts(relevantPids, addCandidate, signal);
      }
    } catch {
      // WMI denied, timeout, or missing tools -> recoverable
    }
  }

  private async correlateWindowsListeningPorts(
    pids: readonly number[],
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        "netstat.exe",
        ["-ano", "-p", "tcp"],
        { timeout: 2000, signal, windowsHide: true }
      );

      const pidSet = new Set(pids);
      const lines = stdout.split(/\r?\n/);

      for (const line of lines) {
        // e.g. "  TCP    127.0.0.1:52792         0.0.0.0:0              LISTENING       31520"
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[0]?.toUpperCase() === "TCP") {
          const localAddr = parts[1]!;
          const state = parts[3]?.toUpperCase();
          const procId = Number.parseInt(parts[4]!, 10);

          if (state === "LISTENING" && pidSet.has(procId)) {
            const portMatch = /(?:127\.0\.0\.1|localhost):(\d+)$/i.exec(localAddr);
            if (portMatch && portMatch[1]) {
              const portNum = Number.parseInt(portMatch[1], 10);
              if (portNum >= 1 && portNum <= 65535) {
                addCandidate({ port: portNum, csrfToken: null });
              }
            }
          }
        }
      }
    } catch {
      // Netstat failure is recoverable
    }
  }

  private async discoverUnixProcesses(
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["aux"],
        { timeout: PROCESS_DISCOVERY_TIMEOUT_MS, signal }
      );

      const lines = stdout.split("\n");
      for (const line of lines) {
        if (
          line.includes("extension_server_port") ||
          line.includes("language_server") ||
          line.includes("antigravity") ||
          line.includes("agy")
        ) {
          const ep = this.parseCandidateCommandLine(line);
          if (ep) {
            addCandidate(ep);
          }
        }
      }
    } catch {
      // Recoverable
    }
  }

  private parseAddressString(address: string, csrfToken: string | null): AntigravityEndpoint | null {
    if (!address || typeof address !== "string") {
      return null;
    }

    // Must be strictly 127.0.0.1 or localhost, no remote hosts, query strings, or non-root paths
    const trimmed = address.trim();
    const match = /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(trimmed);
    if (!match || !match[1]) {
      return null;
    }

    const portNum = Number.parseInt(match[1], 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }

    if (csrfToken && /[\r\n]/.test(csrfToken)) {
      csrfToken = null;
    }

    return {
      port: portNum,
      csrfToken: csrfToken || null
    };
  }

  private parseCandidateCommandLine(cmd: string): AntigravityEndpoint | null {
    if (!cmd || typeof cmd !== "string") {
      return null;
    }

    const portMatch = /(?:--(?:extension_server_port|port)(?:=|\s+))(\d+)/i.exec(cmd);
    if (!portMatch || !portMatch[1]) {
      return null;
    }

    const portNum = Number.parseInt(portMatch[1], 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }

    let csrfToken: string | null = null;
    const tokenMatch = /(?:--(?:csrf_token|csrfToken)(?:=|\s+))([^\s"']+)/i.exec(cmd);
    if (tokenMatch && tokenMatch[1]) {
      const candidateToken = tokenMatch[1].trim();
      if (candidateToken.length > 0 && !/[\r\n]/.test(candidateToken)) {
        csrfToken = candidateToken;
      }
    }

    return {
      port: portNum,
      csrfToken
    };
  }

  /**
   * Calls local Connect RPC endpoint /exa.language_server_pb.LanguageServerService/GetUserStatus
   * Invariants:
   * - Host strictly literal 127.0.0.1 (IPv4).
   * - HTTP 200 only; redirects (3xx) strictly rejected with zero followed requests.
   * - Streamed response body bounded to max 256 KiB.
   * - 5-second total request deadline.
   * - Resources, timeouts, and abort listeners cleaned up on every exit.
   */
  async getUserStatus(
    endpoint: AntigravityEndpoint,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      throw new Error(`Invalid endpoint port: ${endpoint?.port}`);
    }

    const payload = JSON.stringify({
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        locale: "en"
      }
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload, "utf8"))
    };

    if (endpoint.csrfToken) {
      if (/[\r\n]/.test(endpoint.csrfToken)) {
        throw new Error("Malformed CSRF token containing newline characters");
      }
      headers["X-Csrf-Token"] = endpoint.csrfToken;
      headers["x-codeium-csrf-token"] = endpoint.csrfToken;
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;

      const safeReject = (err: Error) => {
        if (!isSettled) {
          isSettled = true;
          req.destroy();
          reject(err);
        }
      };

      const safeResolve = (val: unknown) => {
        if (!isSettled) {
          isSettled = true;
          resolve(val);
        }
      };

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: endpoint.port,
          path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
          method: "POST",
          headers,
          timeout: REQUEST_TIMEOUT_MS
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;

          // Golden Assertion 5: Reject redirects immediately; never follow or forward tokens
          if (statusCode >= 300 && statusCode < 400) {
            safeReject(new Error(`Redirects strictly forbidden: received HTTP ${statusCode}`));
            return;
          }

          if (statusCode !== 200) {
            safeReject(new Error(`Antigravity RPC failed with HTTP ${statusCode}`));
            return;
          }

          let receivedBytes = 0;
          const chunks: Buffer[] = [];

          res.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_RESPONSE_BYTES) {
              res.destroy();
              safeReject(new Error(`Response exceeded maximum size of ${MAX_RESPONSE_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            try {
              const bodyStr = Buffer.concat(chunks).toString("utf8");
              const parsed = JSON.parse(bodyStr);
              safeResolve(parsed);
            } catch (jsonErr) {
              safeReject(new Error(`Failed to parse response JSON: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`));
            }
          });

          res.on("error", (err) => {
            safeReject(err);
          });
        }
      );

      req.on("timeout", () => {
        safeReject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });

      req.on("error", (err) => {
        safeReject(err);
      });

      if (signal) {
        signal.addEventListener("abort", () => {
          safeReject(new Error("Request aborted by caller"));
        }, { once: true });
      }

      req.write(payload);
      req.end();
    });
  }
}
