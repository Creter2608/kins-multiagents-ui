# Kin's Multi-Agents UI 🤖⚡

[![Release: v2.11.1](https://img.shields.io/badge/Release-v2.11.1-emerald.svg)](package.json)
[![Tests: 444 passing](https://img.shields.io/badge/Tests-444%20passing-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-34-black.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Docker Sandbox](https://img.shields.io/badge/Docker-Sandboxed-2496ed.svg)](https://www.docker.com/)

**Kin's Multi-Agents UI** is a desktop mission-control cockpit designed for autonomous AI pair programming (Google Antigravity CLI, Claude Code, Cursor, Windsurf). It combines an interactive ConPTY terminal with live telemetry tracking, multi-project workspace switching, 10-phase autonomous loop orchestration, DeepSeek Harness runtime sandboxing, append-only session journaling, test verification summaries, MCP server monitoring, and Docker container isolation.

Repository: **[https://github.com/Creter2608/kins-multiagents-ui](https://github.com/Creter2608/kins-multiagents-ui)**

---

## 🌟 What's New in v2.11.1 (Major Release Notes)

Version `2.11.1` delivers a major architectural leap forward, integrating the **DeepSeek Harness** autonomous runtime patterns, an adversarial-hardened 3-tier sandbox policy, real-time activity event journaling, and a **Diff-First Context Pruning Engine** that slashes Stage 4 GPT token consumption by over 50–85%:

1. **DeepSeek Harness Runtime Integration**:
   - **3-Tier Sandbox Confinement (`SandboxPolicy.ts`)**: Supports `read-only`, `workspace-write`, and `danger-full-access` execution modes. Enforces an immutable `.eval/` protected root invariant and canonical symlink resolution (including dangling symlink alias defense) to prevent filesystem escapes.
   - **Loop-Hygiene Execution Guards (`ExecutionGuard.ts`)**: Automatic anti-loop detection (blocks >=3 consecutive identical tool requests), bounded step ceilings (`maxPlanSteps = 16`), deep runtime schema validation for every tool step, and safe rejection logging.
   - **Durable Append-Only Session Journal (`SessionJournal.ts`)**: Monotonic sequence numbering, single-writer mutex serialization, crash recovery with uncommitted tail quarantine, and candidate sequence isolation preventing sequence number gaps on I/O failures.
   - **Programmatic Tool Calling (PTC) Executor (`ToolPlanExecutor.ts`)**: Execution mutex queue preventing race conditions in repetition tracking, executor-level sandbox authorization (rejects write tools in read-only mode and validates target paths), and non-cooperative tool timeout resolution via `Promise.race` independent of tool cancellation.
   - **Lifecycle Hook Bridge (`HookBridge.ts`)**: Normalizes external provider lifecycle events (Claude Code, OpenAI Codex) into standardized session events with automated sensitive credential sanitization (API keys, Bearer tokens).
2. **Run Activity Panel & Event Timeline (`RunActivityPanel.tsx`)**:
   - Live collapsible telemetry drawer displaying tool dispatches, execution results, guard blocks, and provider hooks.
   - Interactive modal inspection for detailed event payloads with formatted JSON.
   - Filtering by event categories (All, Tools, Guards, Hooks, Errors) with auto-scroll lock.
3. **Diff-First Context Pruning & Anti-Token-Drain Protocol (`gpt_architect/server.py`)**:
   - **Zero Full-File Dumps**: Set `MODIFIED_FILES_CONTEXT_MAX_CHARS = 0`, eliminating 50,000 characters of redundant source code dumps.
   - **Strict Per-Section Budgets**: Unified diff capped at `16,000` chars (~4,000 tokens), blueprint capped at `8,000` chars (~2,000 tokens), test log & AQI capped at `3,000` chars each.
   - **Hard Aggregate Ceiling**: `DYNAMIC_AUDIT_TOTAL_MAX_CHARS = 32_000` guarantees the dynamic payload never exceeds ~8,000 tokens.
   - **Prefix Cache Optimization**: Maximizes OpenAI prefix caching, saving over 2,400+ cached tokens per Stage 4 audit call and reducing audit costs by ~50%.
4. **Adversarial Hardening & Comprehensive Test Expansion**:
   - **444 Deterministic Tests Passing 100%** (up from 386 in v2.10.1): Added 7 adversarial regression test suites (`deepseek-harness-stage4-remediation.test.ts`) covering executor sandbox enforcement, dangling symlink defense, concurrent repetition limits, non-cooperative tool timeouts, malformed envelope protection, and journal crash recovery.
   - 10/10 AST AQI compliance suite passing with 0 regression.

---

## ⚡ Core Features & Architecture

### 1. Interactive Mission-Control Cockpit
- **Multi-Project Workspace Switcher**: Top navbar dropdown (`ProjectSelector` + `ProjectService`) providing seamless workspace switching across local codebases. Automatically updates working directories, re-anchors PTY shell sessions, re-points transcript ingestion and critical log services, and remembers recent projects.
- **ConPTY Terminal Integration**: Full raw ANSI terminal powered by `@xterm/xterm` and `node-pty`, preserving interactive CLI prompts, bash sequences, and colors.
- **Restful Command Prompt Dark Aesthetic**: Tailored `#000000`/`#0c0c0c` console dark theme with soft zinc typography and emerald status indicators to prevent eye strain during extended autonomous sessions.
- **Pinned Verification Test Summary**: Compact status card pinned directly below the pipeline phases in `PhaseTracker`. Displays test run status (`PASS`, `FAIL`, `IDLE`), passed/failed test counts, timestamp of last run, and collapsible error excerpts extracted from test runners (TAP, Jest, Vitest, pytest).
- **Active MCP Server Monitor & Inspector**: Real-time awareness of connected MCP servers with an "All Calls" vs "MCP Only" filter in `McpSidebar`. Click any tool execution to open an interactive Tool Call Inspector modal dialog showing execution latency, timestamp, status, error details, and full indented JSON payload.
- **Run Activity & Event Journal Drawer**: Dedicated panel visualizing real-time session events, tool dispatches, guard blocks, and provider hooks generated by the DeepSeek Harness runtime.
- **1-Click Desktop Launcher & Shortcut Generator**: Instant startup via `start-cockpit.bat` (with automatic missing build detection and compilation) or generate a Windows Desktop shortcut via `npm run shortcut` (`scripts/create-shortcut.ps1`).

### 2. Live Telemetry HUD & Token Accounting
- **Provider Breakdown**: Displays prompt (in) and completion (out) tokens for both Layer 1 GPT and Layer 2 Gemini:
  - **GPT Telemetry**: In / Out / Cached tokens with real-time prompt cache hit percentage (`gpt-6.1-sol` pricing model: $2.00/1M uncached input, $0.10/1M cached input, $10.00/1M output).
  - **Gemini Telemetry**: In / Out tokens tracking Gemini 3.8 Flash. Output tokens explicitly account for **Thinking / Reasoning tokens**.
- **Session vs. All-Time Scopes**: Toggle between current active session metrics and persistent all-time cumulative counters (`telemetry_alltime.json`). Includes an instant 1-click `Reset` button for session counters.
- **Cost & Budget Circuit Breaker**: Real-time USD spend tracking against a hard configurable ceiling (`$0.50` default) alongside an autonomous token budget indicator that evaluates **strictly Layer 1 GPT tokens** against the 50k (warning) and 60k (exceeded) limits. Unbilled or flat-rate Layer 2 tokens (Gemini) are explicitly excluded from tripping this budget threshold.

### 3. DeepSeek Harness Bounded Autonomous Runtime
- **3-Tier Sandbox Confinement (`SandboxPolicy.ts`)**:
  - `read-only`: Completely prevents write dispatches and files mutations.
  - `workspace-write`: Confines filesystem mutations strictly to authorized repository target roots.
  - `danger-full-access`: Unrestricted access with mandatory `.eval/` immutability invariant.
  - **Canonical Symlink Resolution**: Uses recursive `lstat` and `readlink` traversal (up to 16 hops) to resolve real destinations of dangling symlinks, guaranteeing that aliases targeting `.eval/` cannot bypass write guards.
- **Loop-Hygiene Execution Guards (`ExecutionGuard.ts`)**:
  - **Anti-Loop / Repeat-Tool Guard**: Tracks canonical JSON fingerprints of tool arguments. Blocks the 3rd consecutive identical tool execution (`REPEAT_TOOL_DETECTED`).
  - **Plan Step Ceiling**: Rejects plans exceeding 16 steps (`PLAN_STEP_LIMIT_EXCEEDED`).
  - **Deep Envelope Validation**: Verifies step IDs, tool names, and argument shapes before admission.
- **Append-Only Session Journal (`SessionJournal.ts`)**:
  - Monotonic sequence ordering (`sequence: 1, 2, ...`).
  - Mutex serialization preventing interleaved concurrent disk writes.
  - Corruption-aware crash recovery: Automatically trims and quarantines incomplete trailing lines from unexpected termination, ensuring clean continuation.
  - Candidate sequence isolation: Preserves sequence integrity when serialization fails.
- **Programmatic Tool Calling (PTC) Executor (`ToolPlanExecutor.ts`)**:
  - Execution lock queue preventing concurrent race conditions.
  - Preflight authorization checking registered tool effect against sandbox policy.
  - Independent timeout racing: Guarantees execution settles with `TOOL_TIMEOUT` within 60s even if external tool processes ignore cancellation signals.

### 4. Canonical Autonomous Loop v3.0 & Hard Gates ([docs/LOOP.md](docs/LOOP.md))
Deterministic 5-stage state machine enforcing 10 canonical phases:
```text
INITIALIZE ➔ SPEC_GATE ➔ ISOLATE ➔ DETECT_STACKS ➔ PLAN (Stage 2 GPT Architect)
       ➔ EXECUTE (Layer 2 Gemini) ➔ VERIFY (Local CPU $0) ➔ REALITY_CHECK (Stage 4 GPT Adversary) 
       ➔ RELEASE_GATE (Human Sign-off) ➔ COMPLETE
```
- **Bounded Large Output Tail Dereferencing (`TranscriptIngestionService`)**: Automatically detects when Antigravity CLI offloads large tool results (>20KB) to `steps/<id>/output.txt`. Performs bounded tail dereferencing (up to 8,192 bytes) under security-allowlisted roots (`~/.gemini/antigravity-cli/brain`) to accurately recover GPT token metrics and costs without memory exhaustion or path traversal vulnerabilities.
- **Atomic Fail-Closed PLAN ➔ EXECUTE Handshake (`LoopCommandService`)**: Advances to `EXECUTE` only with an authenticated HMAC-SHA256 `blueprintApproval` signature over verified blueprint SHA-256 and canonical workspace path.
- **Mandatory Registry Entry HMAC Validation (`preToolUseHook.ts`)**: Cryptographically signs and validates `canonicalWorkspacePath`, `sidecarStatePath`, `mutationPolicyMode`, and `schemaVersion` before reading state files, neutralizing sidecar redirection attacks.
- **Diff-First Stage 4 Reality Check Context Pruning**: Eliminates full-source dumping in favor of unified diffs (`-U3`), bounding reasoning latency under 75-90s and avoiding 180s MCP CLI timeouts.
- **Human-in-the-Loop (HITL) 3-Way Quality Gate Triage Modal (`QualityGateDecisionModal.tsx`)**: When Architectural Quality Index (AQI) falls below threshold, execution suspends into a durable `BLOCKED` state. Operators choose: *Loop Again to Improve*, *Override Quality Gate*, or *Reject & Revert*.
- **Fail-Closed Release Gate (`src/engine.ts`)**: Mechanically prohibits transitioning from `REALITY_CHECK ➔ RELEASE_GATE` without verified audit closure and passing architectural compliance (`aqi >= minAqi`).
- **Universal Repository Decoupling & Zero-Pollution Sidecar**: Target client workspaces remain 100% pristine with zero foreign files. Sidecar state and workspace registry are isolated entirely inside Electron `<userData>/`.
- **Zero-Token Local Verification**: Local CPU testing (`npm test`) at **$0 LLM token cost** with a hard ceiling of 1 fix retry.

### 5. Docker Sandbox & Container Isolation
- When container `kins_autonomous_sandbox` is active, all builds, dependency installations, and test runs execute inside Docker for complete host OS isolation.
- Automatic container health polling (`Active`, `Stopped`, or `Unavailable`) displayed directly on the HUD.

### 6. Architectural Quality Index (AQI v2.0) & Compliance Engine
- **Modular Single-Responsibility Engine (`scripts/harness/aqi/`)**: Decomposed into focused submodules (`diff-parser.mjs`, `cycle-detector.mjs`, `contract-rules.mjs`, `scoring.mjs`) with `aqi.mjs` serving as a lightweight façade (<250 lines) adhering strictly to `aqi.d.mts`.
- **Working-Tree Task-Type Topology Inference**: Computes active `taskType` (`feat`, `refactor`, `fix`, `bootstrap`) directly from working-tree topology (`git status --porcelain`) and active blueprint.
- **Tarjan's Strongly Connected Components (SCC)**: Deterministic module cycle detection identifying newly introduced circular dependencies between files in patch diffs.
- **AST Companion Declaration & JSDoc Typing**: Verifies companion `.d.mts`/`.d.ts` declarations and typed JSDoc comments to eliminate false `WEAK_PUBLIC_CONTRACT` penalties on pure ESM JavaScript modules.
- **Monotonic Churn Calculation**: Computes `semanticChurn = addedLines + deletedLines`, neutralizing dummy deletion offset gaming.
- **God-Module Concentration Detector**: Penalizes monolithic patches that concentrate >65% churn and >500 lines into single files.
- **Visualized in Kins Cockpit**: Rendered natively in `PhaseTracker` and `EvalScoreboard` with task profile tags, criteria breakdowns (`Surg`, `Simp`, `Mod`, `Maint`), and prominent hard-failure alerts.

---

## 🛠️ Tech Stack

- **Desktop Framework**: Electron 34 + Node.js 22 LTS
- **UI & Styling**: React 19, TypeScript 5.7, Tailwind CSS 3.4, Lucide Icons
- **Terminal Core**: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`
- **Build System**: Vite 6, esbuild (CommonJS preload bundling), TypeScript Compiler (`tsc`)
- **Testing**: Node.js Native Test Runner (`node --test`), assert module (**444 deterministic unit, integration, and harness tests passing 100%**)

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

- **Run Full Deterministic Test Suite (444 tests)**:
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
│   │   ├── harness/           # DeepSeek Harness Runtime (SandboxPolicy, ExecutionGuard, SessionJournal, ToolPlanExecutor, HookBridge)
│   │   ├── services/          # Telemetry, Pty, McpMonitor, LoopState, TranscriptIngestion, HarnessService
│   │   ├── ipc.ts             # Typed IPC event bridge
│   │   └── index.ts           # Window lifecycle & service bootstrapping
│   ├── preload/               # Context bridge (esbuild -> CommonJS)
│   ├── renderer/              # React 19 UI
│   │   ├── components/        # PhaseTracker, TelemetryHud, McpSidebar, RunActivityPanel, TerminalStage, CriticalLogDrawer
│   │   ├── App.tsx            # Cockpit mission-control layout & event wiring
│   │   └── main.tsx           # UI entrypoint
│   ├── shared/                # Shared contracts, phases, harnessContracts, and interfaces
│   └── engine.ts              # Canonical LoopEngine state machine
├── docs/
│   └── LOOP.md                # Normative Autonomous Loop v3.0 specification
├── wiki/                      # Karpathy LLM-Wiki Knowledge Base
│   ├── decisions/             # Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── pitfalls.md            # Living pitfalls and cognitive traps registry
│   └── log.md                 # Autonomous execution log
├── test/                      # 444 automated unit, integration, and adversarial tests
├── scripts/                   # harness (aqi/, pricing/, schemas/), ai-loop.mjs, ai-exec.mjs, init-template.mjs
├── start-cockpit.bat          # 1-click Windows desktop batch launcher
└── .eval/                     # Read-only golden assertions locked by SHA-256
```

---

## 📄 License

MIT © [Kin / Creter2608](https://github.com/Creter2608)
