# Kin's Multi-Agents UI 🤖⚡

[![Release: v2.10.1](https://img.shields.io/badge/Release-v2.10.1-emerald.svg)](package.json)
[![Tests: 386 passing](https://img.shields.io/badge/Tests-386%20passing-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-34-black.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Docker Sandbox](https://img.shields.io/badge/Docker-Sandboxed-2496ed.svg)](https://www.docker.com/)

**Kin's Multi-Agents UI** is a desktop mission-control cockpit designed for autonomous AI pair programming (Google Antigravity CLI, Claude Code, Cursor, Windsurf). It combines an interactive ConPTY terminal with live telemetry tracking, multi-project workspace switching, 10-phase autonomous loop orchestration, test verification summaries, MCP server monitoring, and Docker sandbox isolation.

Repository: **[https://github.com/Creter2608/kins-multiagents-ui](https://github.com/Creter2608/kins-multiagents-ui)**

---

## ⚡ Core Features & Architecture

### 1. Interactive Mission-Control Cockpit
- **Multi-Project Workspace Switcher**: Top navbar dropdown (`ProjectSelector` + `ProjectService`) providing seamless workspace switching across local codebases. Automatically updates working directories, re-anchors PTY shell sessions, re-points transcript ingestion and critical log services, and remembers recent projects.
- **ConPTY Terminal Integration**: Full raw ANSI terminal powered by `@xterm/xterm` and `node-pty`, preserving interactive CLI prompts, bash sequences, and colors.
- **Restful Command Prompt Dark Aesthetic**: Tailored `#000000`/`#0c0c0c` console dark theme with soft zinc typography and emerald status indicators to prevent eye strain during extended autonomous sessions.
- **Pinned Verification Test Summary**: Compact status card pinned directly below the pipeline phases in `PhaseTracker`. Displays test run status (`PASS`, `FAIL`, `IDLE`), passed/failed test counts, timestamp of last run, and collapsible error excerpts extracted from test runners (TAP, Jest, Vitest, pytest).
- **Active MCP Server Monitor & Inspector**: Real-time awareness of connected MCP servers with an "All Calls" vs "MCP Only" filter in `McpSidebar`. Click any tool execution to open an interactive Tool Call Inspector modal dialog showing execution latency, timestamp, status, error details, and full indented JSON payload.
- **Collapsible Critical Log Drawer**: Automatic extraction and triaging of high-signal errors, glog filtering, and CLI output monitoring.
- **1-Click Desktop Launcher & Shortcut Generator**: Instant startup via `start-cockpit.bat` (with automatic missing build detection and compilation) or generate a Windows Desktop shortcut via `npm run shortcut` (`scripts/create-shortcut.ps1`).

### 2. Live Telemetry HUD & Token Accounting
- **Provider Breakdown**: Displays prompt (in) and completion (out) tokens for both Layer 1 GPT and Layer 2 Gemini:
  - **GPT Telemetry**: In / Out / Cached tokens with real-time prompt cache hit percentage (`gpt-5.6-sol` pricing model: $4.00/1M uncached input, $0.40/1M cached input, $20.00/1M output).
  - **Gemini Telemetry**: In / Out tokens tracking Gemini 3.8 Flash. Output tokens explicitly account for **Thinking / Reasoning tokens**.
- **Session vs. All-Time Scopes**: Toggle between current active session metrics and persistent all-time cumulative counters (`telemetry_alltime.json`). Includes an instant 1-click `Reset` button for session counters.
- **Cost & Budget Circuit Breaker**: Real-time USD spend tracking against a hard configurable ceiling (`$0.50` default) alongside an autonomous token budget indicator that evaluates **strictly Layer 1 GPT tokens** against the 50k (warning) and 60k (exceeded) limits. Unbilled or flat-rate Layer 2 tokens (Gemini) are explicitly excluded from tripping this budget threshold.

### 3. Canonical Autonomous Loop v3.0 & Fail-Closed Hard Hooks ([docs/LOOP.md](docs/LOOP.md))
Deterministic 5-stage state machine enforcing 10 canonical phases:
```text
INITIALIZE ➔ SPEC_GATE ➔ ISOLATE ➔ DETECT_STACKS ➔ PLAN (Stage 2 GPT Architect)
       ➔ EXECUTE (Layer 2 Gemini) ➔ VERIFY (Local CPU $0) ➔ REALITY_CHECK (Stage 4 GPT Adversary) 
       ➔ RELEASE_GATE (Human Sign-off) ➔ COMPLETE
```
- **Bounded Large Output Tail Dereferencing (`TranscriptIngestionService`)**: Automatically detects when Antigravity CLI offloads large tool results (>20KB) to `steps/<id>/output.txt`. Performs bounded tail dereferencing (up to 8,192 bytes) under security-allowlisted roots (`~/.gemini/antigravity-cli/brain`) to accurately recover GPT token metrics and costs without memory exhaustion or path traversal vulnerabilities.
- **Atomic Fail-Closed PLAN ➔ EXECUTE Handshake (`LoopCommandService`)**: Advances to `EXECUTE` only with an authenticated HMAC-SHA256 `blueprintApproval` signature over verified blueprint SHA-256 and canonical workspace path. Throws deterministic errors on missing keys or blueprints, preventing deadlock and fail-open executions.
- **Mandatory Registry Entry HMAC Validation (`preToolUseHook.ts`)**: Cryptographically signs and validates `canonicalWorkspacePath`, `sidecarStatePath`, `mutationPolicyMode`, and `schemaVersion` before reading state files, neutralizing sidecar redirection attacks.
- **Windows Node CJS CLI Normalization (PITFALL-024)**: Cleanses command invocation strings in `hooks.json` on Windows (forward slashes, omit redundant inner quotes), eliminating `MODULE_NOT_FOUND` process launch failures.
- **Stage 4 Reality Check Context Pruning (PITFALL-025)**: Context payload pruning to unified diffs (`-U3`) and concise root error slices (`<=25` lines) keeps reasoning latency under 75-90s, completely preventing Antigravity CLI's 180s MCP timeout.
- **Strict Type-Safety & Zero Any Casts**: Eliminates unsafe type suppressions in state transitions, enforcing fully-typed `AuthenticatedBlueprintApproval` across contracts and state snapshots.
- **Hybrid Mutation Policy & CLI PreToolUse Hard Hook (`src/cli/preToolUseHook.ts`)**: Real-time stdio JSON interceptor registered in Antigravity CLI's `hooks.json`. Supports a **Strict-by-Default** architecture with a **Hardened Documentation Fast Path** (`WorkspaceMutationPolicyMode`): allows $0-token edits for safe documentation (`README.md`, `LICENSE*`, `docs/**/*.md|txt`), while strictly blocking any tampering with prompt governance files (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `docs/LOOP.md`) and production code (`src/**`, `test/**`) without an HMAC-SHA-256 signed blueprint approval from Stage 2.
- **Complete Canonical Registry HMAC Binding (`src/main/services/preToolUseHookService.ts`)**: Binds `canonicalWorkspacePath`, `sidecarStatePath`, `mutationPolicyMode`, and `schemaVersion` into `entryHmac`, verified before reading sidecar state to eliminate path-hijacking vulnerabilities.
- **Automatic Multi-Project Lifecycle Wiring (`src/main/services/ProjectService.ts`)**: `initialize()` equips active workspace hooks automatically on Cockpit launch, while `switchProject()` executes transactional handoffs across client workspaces with zero foreign repo pollution.
- **Human-in-the-Loop (HITL) 3-Way Quality Gate Triage Modal (`QualityGateDecisionModal.tsx`)**: When Architectural Quality Index (AQI) falls below threshold, execution suspends into a durable `BLOCKED` state rather than discarding workspace changes. The cockpit modal presents 3 deterministic choices:
  1. *Loop Again to Improve*: Re-enters the autonomous loop for targeted remediation.
  2. *Override Quality Gate*: Explicitly waives the gate with recorded operator audit trail.
  3. *Reject & Revert*: Safely cleans up the candidate working tree back to baseline.
- **Fail-Closed Release Gate (`src/engine.ts`)**: Mechanically prohibits transitioning from `REALITY_CHECK ➔ RELEASE_GATE` without verified audit closure and passing architectural compliance (`aqi >= minAqi`), unless an active human override bound to the block's `artifactHash` is present.
- **Universal Repository Decoupling & Zero-Pollution Sidecar**: Target client workspaces remain 100% pristine with zero foreign files (no `.agents/`, `.ai/`, or hook scripts placed in user repos). Sidecar state and workspace registry are isolated entirely inside Electron `<userData>/`.
- **Fail-Closed Phase Barrier**: Mechanically blocks advancing from `PLAN ➔ EXECUTE` via `LoopEngine` and `LoopCommandService` unless Stage 2 Technical Blueprint is `ready`, `artifactSha256` matches `.ai/blueprint.md`, `assertionsSha256` matches the canonical assertions, and strict 3-5 golden assertions exist.
- **Unconditional Blueprint Verification**: `FileBlueprintArtifactVerifier` performs timing-safe SHA-256 verification and golden assertions schema enforcement directly on disk before code execution is permitted.
- **Workspace Write Guard (`WorkspaceWriteGuard`)**: Prohibits any file modifications outside `EXECUTE` (`TRANSITION_INVALID`), guarantees absolute immutability of `.eval/` across all phases (`SPECIFICATION_INTEGRITY`), and locks `.ai/blueprint.md` from runtime mutation.
- **One-Shot Oracle Reservation (`BlueprintOracleService`)**: Enforces atomic single-invocation reservation (`0 ➔ 1`), preventing token drain or duplicate Stage 2 calls.
- **Mandatory Stage 4 Adversarial Audit**: Advance to `RELEASE_GATE` strictly requires formal audit closure (`closed`/`accepted`) via `audit_and_break_code_with_gpt`.
- **Auto-Transition via Transcript Signals**: `TranscriptIngestionService` tails `transcript.jsonl` in real-time, detecting tool calls and template banners (`craft_technical_prompt_with_gpt` ➔ `PLAN`, `write_to_file` ➔ `EXECUTE`, `npm test` ➔ `VERIFY`).
- **Turn & Upstream Automatic Loop Reset**: Transitioning to an upstream phase or submitting a new user turn (`USER_INPUT`) in `transcript.jsonl` automatically triggers `resetLoop()`, resetting `currentPhase` to `INITIALIZE` with a new `runId` and clearing test summaries back to `idle`.
- **Per-Run Token Telemetry Reset**: Workload tokens (`oraclePromptTokens + oracleCompletionTokens + geminiGenerationTokens`) strictly reset on every loop run (`runId` change), preventing inherited budget exhaustion while displaying active context window size independently.
- **Interactive Phase Control & Rollback**: Single-step rollback capability and manual override with safety confirmation dialogs for destructive actions.
- **Zero-Token Local Verification**: Local CPU testing (`npm test`) at **$0 LLM token cost** with a hard ceiling of 1 fix retry.

### 4. Docker Sandbox & Container Isolation
- When container `kins_autonomous_sandbox` is active, all builds, dependency installations, and test runs execute inside Docker for complete host OS isolation.
- Automatic container health polling (`Active`, `Stopped`, or `Unavailable`) displayed directly on the HUD.

### 5. Architectural Quality Index (AQI v2.0) & Compliance Engine
- **Modular Single-Responsibility Engine (`scripts/harness/aqi/`)**: Decomposed into focused submodules (`diff-parser.mjs`, `cycle-detector.mjs`, `contract-rules.mjs`, `scoring.mjs`) with `aqi.mjs` serving as a lightweight façade (<250 lines) adhering strictly to `aqi.d.mts`.
- **Working-Tree Task-Type Topology Inference**: Computes active `taskType` (`feat`, `refactor`, `fix`, `bootstrap`) directly from working-tree topology (`git status --porcelain`) and active blueprint, completely eliminating commit-header drift from stale historical commits.
- **Tarjan's Strongly Connected Components (SCC)**: Deterministic module cycle detection identifying newly introduced circular dependencies between files in patch diffs.
- **AST Companion Declaration & JSDoc Typing**: Verifies companion `.d.mts`/`.d.ts` declarations and typed JSDoc comments to eliminate false `WEAK_PUBLIC_CONTRACT` penalties on pure ESM JavaScript modules.
- **Precise Directive Suppression & Scope Filtering**: Eliminates false `UNSAFE_SUPPRESSION` by distinguishing directive comments (`// @ts-ignore`) from documentation prose, and scopes debug output penalties strictly to non-test production code.
- **AST Scope-Aware Alias Tracking**: Eliminates regex evasion by tracking aliased debug sinks (`const emit = console.log`, `const { log } = console`, `process.stdout.write`) and block-commented declarations.
- **Monotonic Churn Calculation**: Computes `semanticChurn = addedLines + deletedLines`, neutralizing dummy deletion offset gaming.
- **Public Contract Validation**: Verifies exported functions, methods, and classes retain strict TypeScript argument and return type signatures.
- **God-Module Concentration Detector**: Penalizes monolithic patches that concentrate >65% churn and >500 lines into single files.
- **Context-Aware Task Profiles & Dynamic Cockpit Inference**: Tailored evaluation profiles (`fix`, `feat`, `refactor`, `bootstrap`) dynamically inferred by `LoopStateService`, paired with cache-busted judge loading.
- **Visualized in Kins Cockpit**: Rendered natively in `PhaseTracker` and `EvalScoreboard` with task profile tags, criteria breakdowns (`Surg`, `Simp`, `Mod`, `Maint`), and prominent hard-failure alerts.

---

## 🛠️ Tech Stack

- **Desktop Framework**: Electron 34 + Node.js 22 LTS
- **UI & Styling**: React 19, TypeScript 5.7, Tailwind CSS 3.4, Lucide Icons
- **Terminal Core**: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`
- **Build System**: Vite 6, esbuild (CommonJS preload bundling), TypeScript Compiler (`tsc`)
- **Testing**: Node.js Native Test Runner (`node --test`), assert module (372 deterministic unit, integration, and harness tests passing 100%)

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `>= 22.0.0`
- **Docker Desktop** (Optional, recommended for sandboxed execution)

### Installation
```bash
git clone https://github.com/Creter2608/kins-multiagents-ui.git
cd kins-multiagents-ui
npm install
```

### Running the Cockpit Application

1. **Quick Launcher (Batch Script)**:
   ```cmd
   start-cockpit.bat
   ```
   *Automatically builds missing production artifacts and launches Electron directly.*

2. **Generate Desktop Shortcut**:
   ```bash
   npm run shortcut
   ```
   *Creates a `Kins Multi-Agents Cockpit.lnk` shortcut on your Windows Desktop via `scripts/create-shortcut.ps1`.*

3. **Development Mode (Vite Hot-Reload)**:
   ```bash
   npm run app:dev
   ```

4. **Production Desktop App**:
   ```bash
   npm run build
   npm run app:start
   ```

---

## 🧪 Verification & Testing Commands

All verification commands are CPU-bound ($0 LLM token spend):

- **Run Full Deterministic Test Suite (314 tests)**:
  ```bash
  npm test
  node scripts/harness/aqi.test.mjs
  ```
- **Strict TypeScript Typecheck**:
  ```bash
  npm run typecheck
  ```
- **Token-Safe Byte-Capped Test Runner (32 KiB cap)**:
  ```bash
  npm run test:ai
  ```
- **Verify Golden Assertions against SHA-256**:
  ```bash
  node scripts/ai-loop.mjs verify
  ```
- **Run Inside Docker Container Sandbox**:
  ```bash
  docker exec kins_autonomous_sandbox npm test
  ```

---

## 📁 Repository Structure

```text
kins-multiagents-ui/
├── src/
│   ├── main/                  # Electron Main Process
│   │   ├── services/          # Telemetry, Pty, McpMonitor, LoopState, TranscriptIngestion
│   │   ├── ipc.ts             # Typed IPC event bridge
│   │   └── index.ts           # Window lifecycle & service bootstrapping
│   ├── preload/               # Context bridge (esbuild -> CommonJS)
│   ├── renderer/              # React 19 UI
│   │   ├── components/        # PhaseTracker, TelemetryHud, McpSidebar, TerminalStage, CriticalLogDrawer
│   │   ├── App.tsx            # 3-column cockpit mission-control layout
│   │   └── main.tsx           # UI entrypoint
│   ├── shared/                # Shared contracts, phases, and interfaces
│   └── engine.ts              # Canonical LoopEngine state machine
├── docs/
│   └── LOOP.md                # Normative Autonomous Loop v3.0 specification
├── wiki/                      # Karpathy LLM-Wiki Knowledge Base
│   ├── decisions/             # Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── pitfalls.md            # Living pitfalls and cognitive traps registry
│   └── log.md                 # Autonomous execution log
├── test/                      # 314 automated unit and integration tests
├── scripts/                   # harness (aqi/, aqi.mjs, judge, runner), ai-loop.mjs, ai-exec.mjs, init-template.mjs
├── start-cockpit.bat          # 1-click Windows desktop batch launcher
└── .eval/                     # Read-only golden assertions locked by SHA-256
```

---

## 📄 License

MIT © [Kin / Creter2608](https://github.com/Creter2608)
