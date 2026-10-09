import * as http from "node:http";
import * as https from "node:https";
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

export interface VerifiedLanguageServer {
  readonly pid: number;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly processIdentity: string;
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

type AntigravityProtocol = "http" | "https";

export class AntigravityQuotaClient implements AntigravityQuotaTransport {
  private readonly userDataPath?: string | undefined;
  private readonly protocolByPort = new Map<number, AntigravityProtocol>();
  private readonly explicitProtocols = new Set<number>();

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

      // Identify first usable configuration-file CSRF token as fallback for process discovery
      let fallbackToken: string | null = null;
      for (const cand of candidates) {
        if (cand.csrfToken && cand.csrfToken.trim()) {
          fallbackToken = cand.csrfToken.trim();
          break;
        }
      }

      // Tier 3: Process Inspection & Local Port Correlation
      if (candidates.length < MAX_CANDIDATE_ENDPOINTS && !signal?.aborted) {
        await this.discoverFromProcesses(addCandidate, signal, fallbackToken);
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

    const uniquePaths = Array.from(new Set(filePathsToTry));

    for (const filePath of uniquePaths) {
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
            let proto: AntigravityProtocol | undefined = undefined;

            if (typeof parsed.csrfToken === "string" && !/[\r\n]/.test(parsed.csrfToken)) {
              csrf = parsed.csrfToken.trim() || null;
            }

            if (parsed.protocol === "https" || parsed.protocol === "http") {
              proto = parsed.protocol;
            } else if (parsed.https === true) {
              proto = "https";
            } else if (parsed.https === false) {
              proto = "http";
            }

            if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) {
              portNum = parsed.port;
            } else if (typeof parsed.address === "string") {
              const ep = this.parseAddressString(parsed.address, csrf);
              if (ep) {
                if (proto) {
                  this.protocolByPort.set(ep.port, proto);
                }
                addCandidate({
                  port: ep.port,
                  csrfToken: ep.csrfToken
                });
                continue;
              }
            }

            if (portNum !== null && portNum >= 1 && portNum <= 65535) {
              if (proto) {
                this.protocolByPort.set(portNum, proto);
                this.explicitProtocols.add(portNum);
              }
              addCandidate({
                port: portNum,
                csrfToken: csrf
              });
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
    signal?: AbortSignal,
    fallbackToken?: string | null
  ): Promise<void> {
    const isWindows = process.platform === "win32";

    try {
      if (isWindows) {
        await this.discoverWindowsProcesses(addCandidate, signal, fallbackToken);
      } else {
        await this.discoverUnixProcesses(addCandidate, signal, fallbackToken);
      }
    } catch {
      // Recoverable tier failure
    }
  }

  /**
   * Discovers a verified Language Server process and its current loopback listening endpoint.
   * If a verified process changes its listening port, rediscovery reflects the new port.
   */
  async discoverLanguageServer(signal?: AbortSignal): Promise<VerifiedLanguageServer | null> {
    if (signal?.aborted) return null;

    try {
      if (process.platform === "win32") {
        const psScript = `
$processes = @()
try {
  $processes = @(
    Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.Name -match '^(language_server_windows(?:_x64|_arm64)?|language_server)\\.exe$'
      } |
      Select-Object ProcessId, ExecutablePath, CommandLine
  )
} catch {
  try {
    $processes = @(
      Get-Process -ErrorAction Stop |
        Where-Object {
          $_.ProcessName -match '^(language_server_windows(?:_x64|_arm64)?|language_server)$'
        } |
        Select-Object @{N='ProcessId';E={$_.Id}}, @{N='ExecutablePath';E={$_.Path}}, @{N='CommandLine';E={$null}}
    )
  } catch {
    $processes = @()
  }
}
ConvertTo-Json -InputObject $processes -Depth 4 -Compress
`.trim();

        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", psScript],
          { timeout: PROCESS_DISCOVERY_TIMEOUT_MS, signal, windowsHide: true }
        );

        let procs: Array<{ ProcessId?: number; Id?: number; ExecutablePath?: string; CommandLine?: string }> = [];
        try {
          const parsed = JSON.parse(stdout);
          procs = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
        } catch {
          procs = [];
        }

        for (const proc of procs) {
          const pid = typeof proc.ProcessId === "number" ? proc.ProcessId : (typeof proc.Id === "number" ? proc.Id : null);
          if (!pid || pid <= 0) continue;
          const cmd = proc.CommandLine ?? proc.ExecutablePath ?? "language_server.exe";

          // Correlate confirmed loopback listening ports for verified PID
          const ports = await this.queryWindowsListeningPortsForPid(pid, signal);
          const correlated = this.correlateProcessEndpoint(proc, ports);
          if (correlated) {
            return correlated;
          }
        }
      }
    } catch {
      // Discover failure fails closed
    }

    return null;
  }

  /**
   * Correlates a discovered process with its confirmed active loopback listeners.
   * Command-line port is treated strictly as an optional hint; only confirmed listeners are returned.
   */
  correlateProcessEndpoint(
    proc: { ProcessId?: number; ExecutablePath?: string; CommandLine?: string },
    listeners: readonly number[]
  ): VerifiedLanguageServer | null {
    const pid = typeof proc.ProcessId === "number" ? proc.ProcessId : null;
    if (!pid || pid <= 0) return null;
    if (!listeners || listeners.length === 0) return null;

    const cmd = proc.CommandLine ?? proc.ExecutablePath ?? "language_server.exe";
    const explicitEp = this.parseCandidateCommandLine(cmd);

    let targetPort = listeners[0]!;
    if (explicitEp && listeners.includes(explicitEp.port)) {
      targetPort = explicitEp.port;
    }

    return {
      pid,
      host: "127.0.0.1",
      port: targetPort,
      processIdentity: cmd
    };
  }

  private async discoverWindowsProcesses(
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal,
    fallbackToken?: string | null
  ): Promise<void> {
    try {
      const psScript = `
$processes = @()
try {
  $processes = @(
    Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.Name -match '^(language_server_windows(?:_x64|_arm64)?|language_server)\\.exe$' -or $_.CommandLine -match 'extension_server_port' -or $_.Name -match 'agy|antigravity'
      } |
      Select-Object ProcessId, ExecutablePath, CommandLine
  )
} catch {
  try {
    $processes = @(
      Get-Process -ErrorAction Stop |
        Where-Object {
          $_.ProcessName -match '^(language_server_windows(?:_x64|_arm64)?|language_server|agy|antigravity)$'
        } |
        Select-Object @{N='ProcessId';E={$_.Id}}, @{N='ExecutablePath';E={$_.Path}}, @{N='CommandLine';E={$null}}
    )
  } catch {
    $processes = @()
  }
}
ConvertTo-Json -InputObject $processes -Depth 4 -Compress
`.trim();

      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { timeout: PROCESS_DISCOVERY_TIMEOUT_MS, signal, windowsHide: true }
      );

      let procs: Array<{ ProcessId?: number; Id?: number; ExecutablePath?: string; CommandLine?: string }> = [];
      try {
        const parsed = JSON.parse(stdout);
        procs = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
      } catch {
        procs = [];
      }

      const relevantPids: number[] = [];
      const tokensByPid = new Map<number, string | null>();

      for (const proc of procs) {
        const pid = typeof proc.ProcessId === "number" ? proc.ProcessId : (typeof proc.Id === "number" ? proc.Id : null);
        if (!pid || pid <= 0) continue;
        const cmd = proc.CommandLine ?? "";

        // 1. Try parsing explicit commandline arguments
        const ep = this.parseCandidateCommandLine(cmd);
        if (ep) {
          addCandidate(ep);
          if (ep.csrfToken) {
            tokensByPid.set(pid, ep.csrfToken);
          }
        }

        // Always scan listening ports for every matched PID
        if (!relevantPids.includes(pid)) {
          relevantPids.push(pid);
        }
      }

      // 2. Correlate PIDs with listening ports
      if (relevantPids.length > 0 && !signal?.aborted) {
        await this.correlateWindowsListeningPorts(relevantPids, tokensByPid, addCandidate, signal, fallbackToken);
      }
    } catch {
      // WMI denied, timeout, or missing tools -> recoverable
    }
  }

  private async queryWindowsListeningPortsForPid(
    pid: number,
    signal?: AbortSignal
  ): Promise<readonly number[]> {
    const ports: number[] = [];
    try {
      const { stdout } = await execFileAsync(
        "netstat.exe",
        ["-ano", "-p", "tcp"],
        { timeout: 2000, signal, windowsHide: true }
      );
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[0]?.toUpperCase() === "TCP") {
          const localAddr = parts[1]!;
          const state = parts[3]?.toUpperCase();
          const procId = Number.parseInt(parts[4]!, 10);
          if (state === "LISTENING" && procId === pid) {
            const portMatch = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)$/i.exec(localAddr);
            if (portMatch && portMatch[1]) {
              const portNum = Number.parseInt(portMatch[1], 10);
              if (portNum >= 1 && portNum <= 65535 && !ports.includes(portNum)) {
                ports.push(portNum);
              }
            }
          }
        }
      }
    } catch {
      // Recoverable
    }
    return Object.freeze(ports);
  }

  private async correlateWindowsListeningPorts(
    pids: readonly number[],
    tokensByPid: ReadonlyMap<number, string | null>,
    addCandidate: (ep: AntigravityEndpoint | null) => void,
    signal?: AbortSignal,
    fallbackToken?: string | null
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
            const portMatch = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)$/i.exec(localAddr);
            if (portMatch && portMatch[1]) {
              const portNum = Number.parseInt(portMatch[1], 10);
              if (portNum >= 1 && portNum <= 65535) {
                const token = tokensByPid.get(procId) ?? fallbackToken ?? null;
                addCandidate({ port: portNum, csrfToken: token });
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
    signal?: AbortSignal,
    fallbackToken?: string | null
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
            addCandidate({
              port: ep.port,
              csrfToken: ep.csrfToken ?? fallbackToken ?? null
            });
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
    const match = /^(?:(https?):\/\/)?(?:127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(trimmed);
    if (!match || !match[2]) {
      return null;
    }

    const portNum = Number.parseInt(match[2], 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }

    if (csrfToken && /[\r\n]/.test(csrfToken)) {
      csrfToken = null;
    }

    const scheme = match[1]?.toLowerCase();
    const protocol: AntigravityProtocol | undefined =
      scheme === "https" ? "https" : scheme === "http" ? "http" : undefined;

    if (protocol) {
      this.protocolByPort.set(portNum, protocol);
      this.explicitProtocols.add(portNum);
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
   * - 5-second total request deadline covering both attempts.
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

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    const onCallerAbort = () => {
      abortController.abort(new Error("Request aborted by caller"));
    };

    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const opSignal = abortController.signal;

      // 1. Cached winning transport for this port
      const cachedProto = this.protocolByPort.get(endpoint.port);
      if (cachedProto) {
        try {
          return await this.requestUserStatus(endpoint, cachedProto, opSignal);
        } catch (cachedErr) {
          if (opSignal.aborted || signal?.aborted) {
            throw cachedErr;
          }

          // If the transport was explicitly configured (e.g. https://... or config file protocol),
          // strict enforcement: do not fall back or downgrade
          if (this.explicitProtocols.has(endpoint.port)) {
            throw cachedErr;
          }

          // Invalidate stale cached protocol
          this.protocolByPort.delete(endpoint.port);

          // If the cached transport failed with a protocol incompatibility, attempt recovery using alternative protocol once
          const altProto: AntigravityProtocol = cachedProto === "https" ? "http" : "https";
          if (this.isCachedProtocolIncompatible(cachedErr, cachedProto)) {
            const altResult = await this.requestUserStatus(endpoint, altProto, opSignal);
            this.protocolByPort.set(endpoint.port, altProto);
            return altResult;
          }
          throw cachedErr;
        }
      }

      // 3. Unspecified, uncached: try HTTPS first (real Language Server uses loopback TLS)
      try {
        const result = await this.requestUserStatus(endpoint, "https", opSignal);
        this.protocolByPort.set(endpoint.port, "https");
        return result;
      } catch (httpsErr) {
        if (opSignal.aborted || signal?.aborted) {
          throw httpsErr;
        }

        // Only fall back to HTTP on qualifying TLS/protocol mismatch
        if (this.isProtocolMismatch(httpsErr)) {
          const result = await this.requestUserStatus(endpoint, "http", opSignal);
          this.protocolByPort.set(endpoint.port, "http");
          return result;
        }

        throw httpsErr;
      }
    } finally {
      clearTimeout(timeoutHandle);
      if (signal) {
        signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  private isCachedProtocolIncompatible(error: unknown, cachedProto: AntigravityProtocol): boolean {
    if (!error) return false;
    if (cachedProto === "https") {
      return this.isProtocolMismatch(error);
    }
    // Cached HTTP failed against what might be an HTTPS server
    const err = error as { code?: string; message?: string };
    const msg = err.message ?? "";
    const code = err.code ?? "";
    if (
      msg.includes("HTTP 400") ||
      msg.includes("wrong version number") ||
      msg.includes("plain HTTP") ||
      msg.includes("HTTPS port") ||
      msg.includes("socket hang up") ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "EPROTO"
    ) {
      return true;
    }
    return false;
  }

  private isProtocolMismatch(error: unknown): boolean {
    if (!error) return false;
    const err = error as { code?: string; message?: string; isHandshakeError?: boolean };
    const code = err.code ?? "";
    const msg = err.message ?? "";

    // Golden Finding A-01: Exclude TLS access-denied alert, certificate, or authorization failures
    if (
      code === "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED" ||
      msg.includes("ERR_SSL_TLSV1_ALERT_ACCESS_DENIED") ||
      msg.includes("ALERT_ACCESS_DENIED") ||
      msg.includes("alert access denied") ||
      msg.includes("CERT_") ||
      msg.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
      msg.includes("DEPTH_ZERO_SELF_SIGNED_CERT")
    ) {
      return false;
    }

    // Exclude errors that explicitly occur after an established TLS connection
    if (msg.includes("after an established TLS connection") || err.isHandshakeError === false) {
      return false;
    }

    if (
      msg.includes("wrong version number") ||
      msg.includes("unknown protocol") ||
      msg.includes("packet length too long") ||
      code === "ERR_SSL_WRONG_VERSION_NUMBER" ||
      code === "ERR_SSL_PROTOCOL_ERROR"
    ) {
      return true;
    }

    // Pre-handshake socket drops or native connection drops (ECONNRESET, EPIPE, socket hang up)
    if (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      msg.includes("socket hang up") ||
      msg.includes("Client network socket disconnected")
    ) {
      return true;
    }

    return false;
  }

  private async requestUserStatus(
    endpoint: AntigravityEndpoint,
    protocol: AntigravityProtocol,
    signal: AbortSignal
  ): Promise<unknown> {
    const payload = JSON.stringify({
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        locale: "en"
      }
    });

    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "Content-Length": String(Buffer.byteLength(payload, "utf8"))
    };

    if (endpoint.csrfToken) {
      if (/[\r\n]/.test(endpoint.csrfToken)) {
        throw new Error("Malformed CSRF token containing newline characters");
      }
      headers["X-Csrf-Token"] = endpoint.csrfToken;
      headers["X-Codeium-Csrf-Token"] = endpoint.csrfToken;
      headers["x-codeium-csrf-token"] = endpoint.csrfToken;
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;
      let tlsEstablished = false;
      let headersReceived = false;

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

      const isHttps = protocol === "https";
      const transportModule = isHttps ? https : http;

      const requestOptions: https.RequestOptions = {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        method: "POST",
        headers,
        ...(isHttps ? { rejectUnauthorized: false } : {})
      };

      const req = transportModule.request(
        requestOptions,
        (res) => {
          headersReceived = true;
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

      if (isHttps) {
        req.on("secureConnect", () => {
          tlsEstablished = true;
        });
      }

      req.on("error", (err: Error & { isHandshakeError?: boolean }) => {
        err.isHandshakeError = !tlsEstablished && !headersReceived;
        safeReject(err);
      });

      if (signal.aborted) {
        const reason = signal.reason;
        safeReject(reason instanceof Error ? reason : new Error("Request aborted by caller"));
        return;
      }

      const onAbort = () => {
        const reason = signal.reason;
        safeReject(reason instanceof Error ? reason : new Error("Request aborted by caller"));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => {
        signal.removeEventListener("abort", onAbort);
      });

      req.write(payload);
      req.end();
    });
  }
}
