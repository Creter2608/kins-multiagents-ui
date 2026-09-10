import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { computePhaseStatuses, LOOP_PHASES, nextLoopPhase, previousLoopPhase, type LoopPhase } from "../../shared/phases.js";
import type {
  LoopStateSnapshot,
  LoopResetResult,
  LoopHistoryEntry,
  RollbackResult,
  StepForwardResult,
  GateDecisionInput,
  GateDecisionResult,
  LoopTestSummary,
  LoopTestStatus,
  ArchitecturalCompliance,
  AuditRecord,
  ResourceBudget,
  ResourceUsage,
  AuthenticatedBlueprintApproval
} from "../../shared/contracts.js";
import { DEFAULT_RESOURCE_BUDGET, EMPTY_RESOURCE_USAGE, type ArchitectureTaskType } from "../../engine.js";
import { JsonFileLoopStateStore, LoopCommandService } from "../../loop/index.js";
import { PreToolUseHookService } from "./preToolUseHookService.js";

export function parseLoopStateJson(content: string): Partial<LoopStateSnapshot> {
  const parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("State root must be an object");
  }
  return parsed as Partial<LoopStateSnapshot>;
}

export type PhaseTransitionReason =
  | "forward"
  | "verify-test-failure"
  | "reality-check-remediation";

function isDocumentationPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const normalized = filePath.trim().toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".txt");
}

export interface ArchitectureChange {
  readonly status: string;
  readonly path: string;
}

export function inferArchitectureTaskType(
  blueprintTaskType: ArchitectureTaskType | undefined,
  changes: readonly ArchitectureChange[],
  hasTrackedProductionBaseline: boolean = true
): ArchitectureTaskType {
  // 1. Explicit active blueprint taskType takes precedence
  if (blueprintTaskType) {
    return blueprintTaskType;
  }

  // 2. Inspect changed file topology
  const hasAddedProductionFiles = changes.some((c) => {
    const isAdded = c.status.startsWith("A") || c.status.startsWith("?") || c.status.includes("A");
    const p = c.path.trim().toLowerCase();
    if (!isAdded) return false;
    // Exclude documentation, tests, eval, configs
    if (isDocumentationPath(p)) return false;
    if (p.includes("test") || p.includes("spec") || p.endsWith(".test.ts") || p.endsWith(".test.js")) return false;
    if (p.startsWith(".eval") || p.startsWith(".ai") || p.startsWith("wiki/")) return false;
    // Must be code files
    return p.startsWith("src/") || p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".py");
  });

  if (hasAddedProductionFiles) {
    if (!hasTrackedProductionBaseline) {
      return "bootstrap";
    }
    return "feat";
  }

  return "fix";
}

function parseTaskType(subject: string): string {
  const s = subject.trim().toLowerCase();
  if (s.startsWith("refactor")) return "refactor";
  if (s.startsWith("feat")) return "feat";
  if (s.startsWith("bootstrap") || s.startsWith("init")) return "bootstrap";
  return "fix";
}

export function resolveLoopStatePath(workspaceRoot: string, sidecarDirectory?: string): string {
  const resolvedPath = path.resolve(workspaceRoot);
  const repoAiDir = path.join(resolvedPath, ".ai");
  let hasRepoAi = false;
  try {
    hasRepoAi = fs.existsSync(repoAiDir) && fs.statSync(repoAiDir).isDirectory();
  } catch {}

  if (hasRepoAi) {
    return path.join(repoAiDir, "state.json");
  }
  if (sidecarDirectory) {
    return path.join(path.resolve(sidecarDirectory), "state", "state.json");
  }
  // DEC-002: Foreign repository with no .ai/ and no explicit sidecarDirectory:
  // Derive safe deterministic user sidecar path based on workspace root hash to avoid polluting external repo!
  const safeId = crypto.createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16);
  const baseUserData = process.env.APPDATA || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : path.join(os.homedir(), ".config"));
  return path.join(baseUserData, "kins-multiagents-ui", "workspaces", safeId, "sidecar", "state", "state.json");
}

export interface RunResetTransitionInput {
  previousRunId: string;
  nextRunId: string;
  previousPhase: LoopPhase | string | undefined;
  nextPhase: LoopPhase | string;
  lastNotifiedRunId: string | null;
}

export interface RunResetTransitionResult {
  notify: boolean;
  lastNotifiedRunId: string | null;
}

export function evaluateRunResetTransition(
  input: RunResetTransitionInput
): RunResetTransitionResult {
  const runChanged =
    input.nextRunId !== "init" &&
    input.nextRunId !== input.previousRunId;

  const enteredInitialize =
    input.nextRunId !== "init" &&
    input.nextPhase === "INITIALIZE" &&
    input.previousPhase !== undefined &&
    input.previousPhase !== "INITIALIZE";

  const candidate = runChanged || enteredInitialize;
  const alreadyNotified =
    input.lastNotifiedRunId === input.nextRunId;

  if (!candidate || alreadyNotified) {
    return {
      notify: false,
      lastNotifiedRunId: input.lastNotifiedRunId
    };
  }

  return {
    notify: true,
    lastNotifiedRunId: input.nextRunId
  };
}

export class LoopStateService {
  private projectRoot: string;
  private userDataPath: string | undefined;
  private stateFilePath: string;
  private appRoot: string;
  private store: JsonFileLoopStateStore;
  private lastValidSnapshot: LoopStateSnapshot;
  private lastResetNotifiedRunId: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: LoopStateSnapshot) => void>();
  private onRunResetCallbacks = new Set<() => void>();

  constructor(
    stateFilePath: string = path.resolve(".ai/state.json"),
    appRoot?: string,
    projectRoot?: string
  ) {
    this.stateFilePath = stateFilePath;
    this.projectRoot = projectRoot ? path.resolve(projectRoot) : path.resolve(path.dirname(this.stateFilePath), "..");
    this.appRoot = appRoot || this.resolveDefaultAppRoot();
    this.store = new JsonFileLoopStateStore(this.stateFilePath);
    const initialPhase = LOOP_PHASES[0];
    this.lastValidSnapshot = {
      runId: "init",
      schemaVersion: 1,
      revision: 1,
      currentPhase: initialPhase,
      status: "ready",
      usage: { transitions: 0, retries: 0, operations: 0 },
      budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
      resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
      resourceUsage: { ...EMPTY_RESOURCE_USAGE },
      phases: computePhaseStatuses(initialPhase),
      history: [],
      testSummary: {
        status: "idle",
        passCount: 0,
        failCount: 0,
        lastRunAt: null
      },
      lastUpdated: Date.now()
    };

    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as { runId?: string };
        if (raw && typeof raw.runId === "string" && raw.runId !== "init") {
          this.lastResetNotifiedRunId = raw.runId;
        }
      } catch {}
      this.readState();
    }
  }

  getSnapshot(): LoopStateSnapshot {
    return this.lastValidSnapshot;
  }

  /**
   * Reads and parses state.json.
   * Assertion 2: {"in":"state.json malformed mid-write","out":"retain last valid state; emit sync error"}
   */
  readState(): LoopStateSnapshot {
    if (!fs.existsSync(this.stateFilePath)) {
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
      return this.lastValidSnapshot;
    }

    try {
      const content = fs.readFileSync(this.stateFilePath, "utf-8");
      const parsed = parseLoopStateJson(content);

      if (!parsed.currentPhase || typeof parsed.currentPhase !== "string") {
        throw new Error("State missing valid currentPhase string");
      }

      const phaseStatuses = computePhaseStatuses(parsed.currentPhase);

      // Safe normalization for legacy snapshots without metadata
      const rawHistory = Array.isArray((parsed as Record<string, unknown>).history)
        ? ((parsed as Record<string, unknown>).history as Array<Record<string, unknown>>)
        : [];
      const history: LoopHistoryEntry[] = rawHistory.map((h, idx) => ({
        sequence: typeof h.sequence === "number" ? h.sequence : idx + 1,
        from: String(h.from || "UNKNOWN"),
        to: String(h.to || "UNKNOWN"),
        triggeredBy: typeof h.triggeredBy === "string" ? h.triggeredBy : "Unknown trigger",
        timestamp: typeof h.timestamp === "number" ? h.timestamp : Date.now(),
        autoAdvanced: Boolean(h.autoAdvanced)
      }));

      const rawTest = (parsed as Record<string, unknown>).testSummary as Record<string, unknown> | undefined;
      const testSummary: LoopTestSummary = rawTest
        ? {
            status: (rawTest.status as LoopTestStatus) || "idle",
            passCount: Number(rawTest.passCount) || 0,
            failCount: Number(rawTest.failCount) || 0,
            lastRunAt: typeof rawTest.lastRunAt === "string" ? rawTest.lastRunAt : null
          }
        : (this.lastValidSnapshot.testSummary || {
            status: "idle",
            passCount: 0,
            failCount: 0,
            lastRunAt: null
          });

      const rawCompliance = (parsed as Record<string, unknown>).architecturalCompliance as ArchitecturalCompliance | undefined;
      const architecturalCompliance = rawCompliance ?? this.lastValidSnapshot.architecturalCompliance;

      const rawAudit = (parsed as Record<string, unknown>).audit as AuditRecord | undefined;
      const audit = rawAudit ?? this.lastValidSnapshot.audit;

      const rawApproval = (parsed as Record<string, unknown>).blueprintApproval as AuthenticatedBlueprintApproval | undefined;
      const blueprintApproval = rawApproval ?? this.lastValidSnapshot.blueprintApproval;

      const rawGoldenSha = typeof (parsed as Record<string, unknown>).goldenSha256 === "string" ? String((parsed as Record<string, unknown>).goldenSha256) : undefined;
      const goldenSha256 = rawGoldenSha ?? this.lastValidSnapshot.goldenSha256;

      const rawResourceBudget = (parsed as Record<string, unknown>).resourceBudget as ResourceBudget | undefined;
      const resourceBudget: ResourceBudget = rawResourceBudget
        ? { ...rawResourceBudget }
        : { ...this.lastValidSnapshot.resourceBudget };

      const rawResourceUsage = (parsed as Record<string, unknown>).resourceUsage as ResourceUsage | undefined;
      const resourceUsage: ResourceUsage = rawResourceUsage
        ? { ...rawResourceUsage }
        : { ...this.lastValidSnapshot.resourceUsage };

      const resolvedSnapshot = {
        resourceBudget,
        resourceUsage
      };

      const nextRunId = String(parsed.runId || this.lastValidSnapshot.runId);
      const previousRunId = this.lastValidSnapshot.runId;
      const nextPhase = parsed.currentPhase;
      const previousPhase = this.lastValidSnapshot.currentPhase;

      const transition = evaluateRunResetTransition({
        previousRunId,
        nextRunId,
        previousPhase,
        nextPhase,
        lastNotifiedRunId: this.lastResetNotifiedRunId
      });
      this.lastResetNotifiedRunId = transition.lastNotifiedRunId;

      this.lastValidSnapshot = {
        runId: nextRunId,
        schemaVersion: Number(parsed.schemaVersion || 1),
        revision: typeof (parsed as Record<string, unknown>).revision === "number" ? Number((parsed as Record<string, unknown>).revision) : (this.lastValidSnapshot.revision ?? 1),
        currentPhase: parsed.currentPhase,
        status: (parsed.status as LoopStateSnapshot["status"]) || "running",
        usage: {
          transitions: Number(parsed.usage?.transitions ?? this.lastValidSnapshot.usage.transitions),
          retries: Number(parsed.usage?.retries ?? this.lastValidSnapshot.usage.retries),
          operations: Number(parsed.usage?.operations ?? this.lastValidSnapshot.usage.operations)
        },
        budget: {
          maxTransitions: Number(parsed.budget?.maxTransitions ?? this.lastValidSnapshot.budget.maxTransitions),
          maxRetries: Number(parsed.budget?.maxRetries ?? this.lastValidSnapshot.budget.maxRetries),
          maxOperations: Number(parsed.budget?.maxOperations ?? this.lastValidSnapshot.budget.maxOperations)
        },
        resourceBudget: { ...resolvedSnapshot.resourceBudget },
        resourceUsage: { ...resolvedSnapshot.resourceUsage },
        phases: phaseStatuses,
        history,
        testSummary,
        architecturalCompliance,
        audit,
        blueprintApproval,
        goldenSha256,
        lastError: parsed.lastError,
        syncError: undefined,
        lastUpdated: Date.now()
      };

      if (transition.notify) {
        this.notifyRunReset();
      }
    } catch (err) {
      // Assertion 2: Retain last valid state and emit sync error
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        syncError: `Sync Error: ${err instanceof Error ? err.message : String(err)}`,
        lastUpdated: Date.now()
      };
    }

    for (const listener of this.listeners) {
      listener(this.lastValidSnapshot);
    }

    return this.lastValidSnapshot;
  }

  updateTestSummary(summary: LoopTestSummary): void {
    try {
      this.readState();
      let stateData: Record<string, unknown> = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          stateData = {};
        }
      }

      const updatedState = {
        runId: this.lastValidSnapshot.runId,
        schemaVersion: this.lastValidSnapshot.schemaVersion,
        currentPhase: this.lastValidSnapshot.currentPhase,
        status: this.lastValidSnapshot.status,
        usage: this.lastValidSnapshot.usage,
        budget: this.lastValidSnapshot.budget,
        ...stateData,
        testSummary: summary
      };

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.stateFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tempPath, JSON.stringify(updatedState, null, 2), "utf-8");
      fs.renameSync(tempPath, this.stateFilePath);

      this.readState();
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    } catch {
      // Retain in memory if write fails
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        testSummary: summary,
        lastUpdated: Date.now()
      };
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    }
  }

  private customJudgeFn?: ((diffText: string) => ArchitecturalCompliance) | undefined;

  setJudgeFunctionForTesting(fn?: (diffText: string) => ArchitecturalCompliance): void {
    this.customJudgeFn = fn;
  }

  setAppRootForTesting(root: string): void {
    this.appRoot = root;
  }

  private resolveDefaultAppRoot(): string {
    let curr = path.dirname(fileURLToPath(import.meta.url));
    while (curr !== path.dirname(curr)) {
      if (fs.existsSync(path.join(curr, "scripts", "harness", "judge.mjs"))) {
        return curr;
      }
      curr = path.dirname(curr);
    }
    return process.cwd();
  }

  updateArchitecturalCompliance(compliance: ArchitecturalCompliance): void {
    try {
      this.readState();
      let stateData: Record<string, unknown> = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          stateData = {};
        }
      }

      const updatedState = {
        runId: this.lastValidSnapshot.runId,
        schemaVersion: this.lastValidSnapshot.schemaVersion,
        currentPhase: this.lastValidSnapshot.currentPhase,
        status: this.lastValidSnapshot.status,
        usage: this.lastValidSnapshot.usage,
        budget: this.lastValidSnapshot.budget,
        ...stateData,
        architecturalCompliance: compliance
      };

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempPath = `${this.stateFilePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tempPath, JSON.stringify(updatedState, null, 2), "utf-8");
      fs.renameSync(tempPath, this.stateFilePath);

      this.readState();
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    } catch {
      // Retain in memory if write fails
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        architecturalCompliance: compliance,
        lastUpdated: Date.now()
      };
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    }
  }

  updateAudit(audit: AuditRecord): void {
    try {
      this.readState();
      let stateData: Record<string, unknown> = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          stateData = {};
        }
      }

      const updatedState = {
        runId: this.lastValidSnapshot.runId,
        schemaVersion: this.lastValidSnapshot.schemaVersion,
        currentPhase: this.lastValidSnapshot.currentPhase,
        status: this.lastValidSnapshot.status,
        usage: this.lastValidSnapshot.usage,
        budget: this.lastValidSnapshot.budget,
        ...stateData,
        audit
      };

      this.store.writeSync(updatedState);

      this.readState();
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    } catch {
      // Retain in memory if write fails
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        audit,
        lastUpdated: Date.now()
      };
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    }
  }

  updateResourceUsage(usage: Partial<ResourceUsage>): void {
    try {
      this.readState();
      let stateData: Record<string, unknown> = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as Record<string, unknown>;
        } catch {
          stateData = {};
        }
      }

      const curUsage = this.lastValidSnapshot.resourceUsage || { ...EMPTY_RESOURCE_USAGE };
      const updatedUsage: ResourceUsage = {
        costMicroUsd: typeof usage.costMicroUsd === "number" ? usage.costMicroUsd : curUsage.costMicroUsd,
        promptTokens: typeof usage.promptTokens === "number" ? usage.promptTokens : curUsage.promptTokens,
        cachedTokens: typeof usage.cachedTokens === "number" ? usage.cachedTokens : curUsage.cachedTokens,
        reasoningTokens: typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : curUsage.reasoningTokens,
        completionTokens: typeof usage.completionTokens === "number" ? usage.completionTokens : curUsage.completionTokens,
        totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : curUsage.totalTokens,
        oracleCalls: typeof usage.oracleCalls === "number" ? usage.oracleCalls : curUsage.oracleCalls,
        globalCycles: typeof usage.globalCycles === "number" ? usage.globalCycles : curUsage.globalCycles,
        verificationRetries: typeof usage.verificationRetries === "number" ? usage.verificationRetries : curUsage.verificationRetries,
        qualityRemediations: typeof usage.qualityRemediations === "number" ? usage.qualityRemediations : curUsage.qualityRemediations
      };

      const updatedState = {
        ...stateData,
        runId: this.lastValidSnapshot.runId,
        schemaVersion: this.lastValidSnapshot.schemaVersion,
        currentPhase: this.lastValidSnapshot.currentPhase,
        status: this.lastValidSnapshot.status,
        usage: this.lastValidSnapshot.usage,
        budget: this.lastValidSnapshot.budget,
        resourceBudget: this.lastValidSnapshot.resourceBudget,
        resourceUsage: updatedUsage
      };

      this.store.writeSync(updatedState);
      this.readState();
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    } catch {
      this.lastValidSnapshot = {
        ...this.lastValidSnapshot,
        resourceUsage: {
          ...this.lastValidSnapshot.resourceUsage,
          ...usage
        },
        lastUpdated: Date.now()
      };
      for (const listener of this.listeners) {
        listener(this.lastValidSnapshot);
      }
    }
  }

  async evaluateArchitecture(): Promise<ArchitecturalCompliance | null> {
    try {
      const repoRoot = this.projectRoot || path.resolve(path.dirname(this.stateFilePath), "..");
      let diffText = "";
      let taskType = "fix";

      // 1. Check if working tree has non-documentation changes
      try {
        let workingTreeNames: string[] = [];
        try {
          workingTreeNames = execFileSync(
            "git",
            ["-c", "safe.directory=*", "diff", "--name-only", "HEAD"],
            { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
          ).split("\n").map(s => s.trim()).filter(Boolean);
        } catch {
          try {
            workingTreeNames = execFileSync(
              "git",
              ["-c", "safe.directory=*", "diff", "--name-only", "--cached"],
              { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
            ).split("\n").map(s => s.trim()).filter(Boolean);
          } catch {
            workingTreeNames = [];
          }
        }

        const hasWorkingTreeCode = workingTreeNames.some(p => !isDocumentationPath(p));
        if (hasWorkingTreeCode) {
          try {
            diffText = execFileSync("git", ["-c", "safe.directory=*", "diff", "HEAD"], {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"]
            });
          } catch {
            try {
              diffText = execFileSync("git", ["-c", "safe.directory=*", "diff", "--cached"], {
                cwd: repoRoot,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"]
              });
            } catch {
              diffText = "";
            }
          }

          try {
            const statusOutput = execFileSync(
              "git",
              ["-c", "safe.directory=*", "status", "--porcelain"],
              { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
            );
            const changes: ArchitectureChange[] = statusOutput
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const status = line.slice(0, 2).trim();
                const pathStr = line.slice(3).trim();
                return { status, path: pathStr };
              });
            const blueprintTaskType = this.lastValidSnapshot?.blueprint?.taskType;
            taskType = inferArchitectureTaskType(blueprintTaskType, changes, true);
          } catch {
            taskType = "fix";
          }
        }
      } catch {
        diffText = "";
      }

      // 2. If working tree is clean or documentation-only, inspect newest commits (up to 10)
      if (!diffText.trim()) {
        try {
          const logOutput = execFileSync(
            "git",
            ["-c", "safe.directory=*", "log", "-n", "10", "--format=%H"],
            { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
          );
          const commitHashes = logOutput.split("\n").map(h => h.trim()).filter(Boolean);

          for (const hash of commitHashes) {
            try {
              const changedFilesOutput = execFileSync(
                "git",
                ["-c", "safe.directory=*", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash],
                {
                  cwd: repoRoot,
                  encoding: "utf-8",
                  stdio: ["ignore", "pipe", "pipe"]
                }
              );
              const changedFiles = changedFilesOutput.split("\n").map(p => p.trim()).filter(Boolean);
              const hasCode = changedFiles.some(p => !isDocumentationPath(p));
              if (hasCode) {
                diffText = execFileSync(
                  "git",
                  ["-c", "safe.directory=*", "show", "--format=", "--patch", hash],
                  { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
                );
                try {
                  const subject = execFileSync(
                    "git",
                    ["-c", "safe.directory=*", "log", "-1", "--format=%s", hash],
                    { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
                  ).trim();
                  taskType = parseTaskType(subject);
                } catch {
                  taskType = "fix";
                }
                break;
              }
            } catch {
              continue;
            }
          }
        } catch {
          diffText = "";
        }
      }

      let compliance: ArchitecturalCompliance;
      if (this.customJudgeFn) {
        compliance = this.customJudgeFn(diffText);
      } else {
        if (!diffText.trim()) {
          return null;
        }
        let judgePath = path.resolve(repoRoot, "scripts", "harness", "judge.mjs");
        if (!fs.existsSync(judgePath)) {
          judgePath = path.resolve(this.appRoot, "scripts", "harness", "judge.mjs");
        }
        if (!fs.existsSync(judgePath)) {
          return null;
        }
        const judgeUrl = `${pathToFileURL(judgePath).href}?t=${Date.now()}`;
        const judgeModule = (await import(judgeUrl)) as {
          evaluateArchitecturalCompliance: (
            diff: string,
            options?: { repoRoot?: string; taskType?: string }
          ) => ArchitecturalCompliance;
        };
        compliance = judgeModule.evaluateArchitecturalCompliance(diffText, {
          repoRoot,
          taskType
        });
      }

      let enrichedCompliance: ArchitecturalCompliance | null = compliance;
      if (compliance) {
        enrichedCompliance = {
          ...compliance,
          taskType: compliance.taskType || taskType,
          minAqi: compliance.minAqi ?? compliance.threshold ?? 3.5
        };
      }

      this.updateArchitecturalCompliance(enrichedCompliance);
      return enrichedCompliance;
    } catch (err) {
      console.warn("[LoopStateService] evaluateArchitecture failed:", err);
      return null;
    }
  }

  resetLoop(customRunId?: string): LoopResetResult {
    try {
      const initialPhase = LOOP_PHASES[0];
      const runId = customRunId || `run-${Date.now()}`;
      const freshState = {
        schemaVersion: 1,
        revision: 1,
        runId,
        currentPhase: initialPhase,
        status: "ready" as const,
        budget: {
          maxTransitions: 25,
          maxRetries: 2,
          maxOperations: 50
        },
        usage: {
          transitions: 0,
          retries: 0,
          operations: 0
        },
        resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
        resourceUsage: { ...EMPTY_RESOURCE_USAGE },
        history: [],
        testSummary: {
          status: "idle" as const,
          passCount: 0,
          failCount: 0,
          lastRunAt: null
        }
      };

      // Write atomically via store with advisory file locking
      this.store.writeSync(freshState);

      // Immediately read back and emit to all listeners
      const state = this.readState();
      return {
        success: true,
        message: `Loop run ${runId} successfully initialized to ${initialPhase}`,
        state
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to reset loop: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  onRunReset(cb: () => void): () => void {
    this.onRunResetCallbacks.add(cb);
    return () => {
      this.onRunResetCallbacks.delete(cb);
    };
  }

  notifyRunReset(): void {
    for (const cb of this.onRunResetCallbacks) {
      try {
        cb();
      } catch {
        // Suppress subscriber failure to isolate caller
      }
    }
  }

  async decideGate(input: GateDecisionInput): Promise<GateDecisionResult> {
    if (!input || typeof input !== "object") {
      return { success: false, message: "Invalid input payload" };
    }
    const validPhases = ["SPEC_GATE", "RELEASE_GATE", "BLOCKED"];
    if (!validPhases.includes(input.expectedPhase)) {
      return { success: false, message: `Invalid gate phase: '${input.expectedPhase}'` };
    }
    const validDecisions = ["approve", "reject", "remediate", "override_quality_gate"];
    if (!validDecisions.includes(input.decision)) {
      return { success: false, message: `Invalid decision: '${input.decision}'. Must be one of: ${validDecisions.join(", ")}` };
    }
    if ((input.decision === "reject" || input.decision === "override_quality_gate" || input.decision === "remediate") && (!input.reason || !input.reason.trim())) {
      return { success: false, message: `Decision '${input.decision}' requires a non-blank justification reason` };
    }

    try {
      const commandService = new LoopCommandService(
        this.store,
        undefined,
        undefined,
        this.projectRoot,
        this.userDataPath ? () => PreToolUseHookService.getOrCreateSigningKeySync(this.userDataPath!) : undefined
      );
      await commandService.transition({
        runId: input.runId,
        expectedPhase: input.expectedPhase,
        expectedRevision: this.lastValidSnapshot.revision ?? 1,
        action: input.decision,
        reason: input.reason,
        feedback: input.feedback,
        ticketReference: input.ticketReference,
        artifactHash: input.artifactHash,
        actor: "human"
      });
      const updated = this.readState();
      return {
        success: true,
        message: `Gate ${input.expectedPhase} ${input.decision} executed successfully`,
        state: updated
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  advanceToPhase(
    targetPhase: LoopPhase,
    evidence?: string,
    reason: PhaseTransitionReason = "forward"
  ): boolean {
    const current = this.readState();

    const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
    const targetIdx = LOOP_PHASES.indexOf(targetPhase);

    if (targetIdx === -1 || currentIdx === -1) {
      return false;
    }

    // 1. Same phase: no-op, retain state and transition count
    if (targetPhase === current.currentPhase) {
      return true;
    }

    // 2. Explicit loop reset to INITIALIZE (e.g. user requested new loop)
    if (targetPhase === "INITIALIZE") {
      this.resetLoop(`run-${Date.now()}`);
      return true;
    }

    // 3. Backward transitions (targetIdx < currentIdx)
    if (targetIdx < currentIdx) {
      // (a) VERIFY -> EXECUTE on test failure
      if (
        current.currentPhase === "VERIFY" &&
        targetPhase === "EXECUTE" &&
        reason === "verify-test-failure"
      ) {
        return this.transitionPhase("EXECUTE", {
          triggeredBy: evidence || "Test failure retry",
          autoAdvanced: false,
          timestamp: Date.now()
        });
      }

      // (b) REALITY_CHECK -> EXECUTE on remediation
      if (
        current.currentPhase === "REALITY_CHECK" &&
        targetPhase === "EXECUTE" &&
        reason === "reality-check-remediation"
      ) {
        return this.transitionPhase("EXECUTE", {
          triggeredBy: evidence || "Reality check remediation",
          autoAdvanced: false,
          timestamp: Date.now()
        });
      }

      // Invariant: Backward requests without explicit valid loopback reasons are rejected without mutation
      return false;
    }

    // 4. If current status is terminal, cannot advance forward unless reset
    if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
      return false;
    }

    // 5. Forward transitions (targetIdx > currentIdx)
    // Sequentially advance through intermediate phases with metadata
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const nextPhase = LOOP_PHASES[i];
      if (!nextPhase) break;
      const isTarget = i === targetIdx;
      const ok = this.transitionPhase(nextPhase, {
        triggeredBy: isTarget
          ? (evidence || "Auto-detected")
          : (evidence ? `Auto-advance to ${nextPhase} (${evidence})` : `Auto-advance to ${nextPhase}`),
        autoAdvanced: !isTarget,
        timestamp: Date.now()
      });
      if (!ok) return false;
    }

    return true;
  }

  transitionPhase(
    to: LoopPhase,
    metadata?: { triggeredBy?: string | undefined; autoAdvanced?: boolean | undefined; timestamp?: number | undefined }
  ): boolean {
    try {
      const current = this.readState();
      if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
        return false;
      }
      if (current.currentPhase === to) {
        return true;
      }

      let stateData: any = {};
      if (fs.existsSync(this.stateFilePath)) {
        try {
          stateData = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8"));
        } catch {
          stateData = {};
        }
      }

      const nextTransitions = (Number(stateData.usage?.transitions) || current.usage.transitions) + 1;
      const history = Array.isArray(stateData.history) ? [...stateData.history] : [];
      const entryTimestamp = metadata?.timestamp ?? Date.now();
      const triggeredBy = metadata?.triggeredBy || "Manual transition";
      const autoAdvanced = Boolean(metadata?.autoAdvanced);

      history.push({
        sequence: history.length + 1,
        from: current.currentPhase,
        to,
        triggeredBy,
        timestamp: entryTimestamp,
        autoAdvanced
      });

      const nextStatus: LoopStateSnapshot["status"] = to === "COMPLETE" ? "succeeded" : "running";

      // If transition is a backward retry to EXECUTE, increment retries
      const isRetry =
        (current.currentPhase === "VERIFY" || current.currentPhase === "REALITY_CHECK") &&
        to === "EXECUTE";
      const currentRetries = Number(stateData.usage?.retries) || current.usage.retries;
      const nextRetries = isRetry ? currentRetries + 1 : currentRetries;

      const nextApproval = (to === "PLAN" || to === "INITIALIZE")
        ? undefined
        : (stateData.blueprintApproval ?? current.blueprintApproval);

      const updatedState = {
        schemaVersion: 1,
        runId: stateData.runId || current.runId,
        currentPhase: to,
        status: nextStatus,
        budget: stateData.budget || current.budget,
        usage: {
          transitions: nextTransitions,
          retries: nextRetries,
          operations: stateData.usage?.operations ?? current.usage.operations
        },
        history,
        testSummary: stateData.testSummary || current.testSummary,
        architecturalCompliance: stateData.architecturalCompliance ?? current.architecturalCompliance,
        blueprint: stateData.blueprint ?? current.blueprint,
        blueprintApproval: nextApproval,
        goldenSha256: stateData.goldenSha256 ?? current.goldenSha256,
        audit: stateData.audit ?? current.audit,
        qualityGateBlock: stateData.qualityGateBlock ?? current.qualityGateBlock,
        qualityGateDecisions: stateData.qualityGateDecisions ?? current.qualityGateDecisions,
        resourceBudget: stateData.resourceBudget ?? current.resourceBudget,
        resourceUsage: stateData.resourceUsage ?? current.resourceUsage
      };

      this.store.writeSync(updatedState);

      this.readState();

      if (to === "REALITY_CHECK" || to === "COMPLETE") {
        void this.evaluateArchitecture().catch((err) => {
          console.warn("[LoopStateService] Auto-eval architecture failed:", err);
        });
      }

      return true;
    } catch {
      return false;
    }
  }

  stepForward(): StepForwardResult {
    const current = this.readState();
    if (current.status === "succeeded" || current.status === "failed" || current.status === "blocked") {
      return { success: false, message: `Cannot step forward while in terminal status '${current.status}'` };
    }
    const currentPhase = current.currentPhase as LoopPhase;
    const nextPhase = nextLoopPhase(currentPhase);
    if (nextPhase === currentPhase) {
      return { success: false, message: `Already at final canonical phase ${current.currentPhase}` };
    }
    const ok = this.transitionPhase(nextPhase, {
      triggeredBy: "Manual step forward",
      autoAdvanced: false,
      timestamp: Date.now()
    });
    if (ok) {
      return { success: true, message: `Stepped forward to ${nextPhase}`, state: this.readState() };
    }
    return { success: false, message: `Failed to transition to ${nextPhase}` };
  }

  stepBack(): RollbackResult {
    const current = this.readState();
    const currentPhase = current.currentPhase as LoopPhase;
    const prevPhase = previousLoopPhase(currentPhase);
    if (prevPhase === currentPhase) {
      return {
        success: false,
        message: `Cannot step back from initial phase ${current.currentPhase}`
      };
    }

    const ok = this.transitionPhase(prevPhase, {
      triggeredBy: "Manual step back",
      autoAdvanced: false,
      timestamp: Date.now()
    });

    if (ok) {
      return {
        success: true,
        message: `Stepped back to ${prevPhase}`,
        previousPhase: current.currentPhase,
        currentPhase: prevPhase
      };
    }

    return {
      success: false,
      message: `Failed to step back to ${prevPhase}`
    };
  }

  setUserDataPath(userDataPath: string): void {
    this.userDataPath = userDataPath;
  }

  getUserDataPath(): string | undefined {
    return this.userDataPath;
  }

  getStateFilePath(): string {
    return this.stateFilePath;
  }

  async setProjectRoot(projectPath: string, sidecarDirectory?: string): Promise<void> {
    const resolvedPath = path.resolve(projectPath);
    this.projectRoot = resolvedPath;
    this.stateFilePath = resolveLoopStatePath(resolvedPath, sidecarDirectory);
    this.store = new JsonFileLoopStateStore(this.stateFilePath);
    this.lastResetNotifiedRunId = null;

    const initialPhase = LOOP_PHASES[0];
    this.lastValidSnapshot = {
      runId: "init",
      schemaVersion: 1,
      revision: 1,
      currentPhase: initialPhase,
      status: "ready",
      usage: { transitions: 0, retries: 0, operations: 0 },
      budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
      resourceBudget: { ...DEFAULT_RESOURCE_BUDGET },
      resourceUsage: { ...EMPTY_RESOURCE_USAGE },
      phases: computePhaseStatuses(initialPhase),
      history: [],
      testSummary: {
        status: "idle",
        passCount: 0,
        failCount: 0,
        lastRunAt: null
      },
      architecturalCompliance: undefined,
      lastUpdated: Date.now()
    };

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      if (!dir.startsWith(resolvedPath) || (sidecarDirectory && dir.startsWith(path.resolve(sidecarDirectory)))) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    if (fs.existsSync(dir)) {
      try {
        this.watcher = fs.watch(dir, (_event, filename) => {
          if (filename && filename.includes("state.json")) {
            this.readState();
          }
        });
        this.watcher.unref?.();
      } catch {
        // Fallback to polling
      }
    }

    this.readState();

    if (!this.lastValidSnapshot.architecturalCompliance) {
      try {
        if (fs.existsSync(path.join(resolvedPath, ".git"))) {
          void this.evaluateArchitecture().catch(() => {});
        }
      } catch {}
    }
  }

  start(): void {
    void this.readState();

    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.includes("state.json")) {
          this.readState();
        }
      });
      this.watcher.unref?.();
    } catch {
      // Fallback to polling if fs.watch fails
    }

    this.pollTimer = setInterval(() => {
      this.readState();
    }, 1500);
    this.pollTimer.unref?.();
  }

  subscribe(listener: (snapshot: LoopStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.lastValidSnapshot);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}
