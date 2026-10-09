# Kin's Multi-Agents UI 🤖⚡

[![Release: v2.13.0](https://img.shields.io/badge/Release-v2.13.0-emerald.svg)](package.json)
[![Tests: 523 passing](https://img.shields.io/badge/Tests-523%20passing-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-34-black.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Docker Sandbox](https://img.shields.io/badge/Docker-Sandboxed-2496ed.svg)](https://www.docker.com/)

**Kin's Multi-Agents UI** is a desktop mission-control cockpit designed for autonomous AI pair programming (Google Antigravity CLI, Claude Code, Cursor, Windsurf). It combines an interactive ConPTY terminal with live telemetry tracking, multi-project workspace switching, 10-phase autonomous loop orchestration, DeepSeek Harness runtime sandboxing, append-only session journaling, test verification summaries, MCP server monitoring, and Docker container isolation.

Repository: **[https://github.com/Creter2608/kins-multiagents-ui](https://github.com/Creter2608/kins-multiagents-ui)**

---

## 🚀 What's New in v2.13.0 (Major Release: Everything Claude Code Absorption)

Version `2.13.0` marks a transformative leap forward: **Zero-Pollution Absorption of the Everything Claude Code (ECC) Ecosystem** directly into Kin's Multi-Agents UI Cockpit. This milestone delivers a secure, read-only capability catalog, interactive subagent dispatching, token-budgeted skill context injection, and real-time telemetry HUD integration:

1. **Read-Only Capability Catalog & Quarantine Sandbox (`EccCatalogService`, IPC `cockpitApi.ecc.getSnapshot`)**:
   - **Zero-Pollution External Discovery**: Dynamically scans external ECC directories (`~/.claude/` or configured source roots) for specialized agents and modular skills without creating temporary files, symlinks, or clutter in the active project codebase.
   - **4-Tier Security Quarantine Defense**:
     - *Symlink Escape Traversal Defense*: Strictly resolves canonical paths via `fs.realpathSync`, preventing directory traversal attacks escaping the designated source root.
     - *Size Ceiling Enforcement*: Rejects oversized assets (> 512 KiB) to prevent memory exhaustion and DoS vectors.
     - *Suspicious Invisible & Bidirectional Unicode Quarantine*: Sanitizes and quarantines assets containing zero-width spaces (`\u200B\u200C\u200D\u2060\uFEFF`) and dangerous directional embedding/override marks (`\u200E\u200F\u202A-\u202E\u2066-\u2069`) to neutralize stealth prompt-injection vectors (Stage 4 hardened via `ECC-001`).
     - *Script Execution Containment*: Detects and quarantines dangerous shell and binary payloads.
   - **Deterministic Revision Caching**: Computes SHA-256 digests for individual assets and combines them into an atomic catalog revision hash, guaranteeing fast cached lookups and optimistic concurrency validation.

2. **Interactive Capability Dispatcher & Cockpit UI (`EccDispatcherService`, `EccCatalogView`, `SubagentSidebar`)**:
   - **1-Click Subagent Dispatch**: Seamlessly transforms external ECC agents into active Cockpit subagents participating in the canonical autonomous loop.
   - **Fail-Closed Admission Gate**: The IPC dispatch endpoint (`cockpitApi.ecc.dispatch`) enforces strict preflight validation—rejecting quarantined assets, detecting stale catalog revisions, and verifying that total enriched prompt context remains strictly under a 64 KiB ceiling.
   - **Interactive Catalog & Dispatch View (`EccCatalogView.tsx`)**:
     - Accessible directly via the Subagent drawer with instant tab switching (*Active Queue* vs *ECC Library*).
     - Full-text search and category filtering across agents and skills.
     - Interactive multi-skill chip composer: dynamically attach, stack, or remove skill augmentations with previewable prompt payloads before launch.

3. **Dynamic Skill Context Injector & Token Budget Optimization (`EccSkillContextInjector`)**:
   - **High-Density Markdown Compaction**: Strips YAML frontmatter, HTML comments, visual badges, and superfluous reference links from skill documents to maximize prompt token density.
   - **Safe UTF-8 Character Slicing (`sliceUtf8Safe`)**: Walks back buffer slicing boundaries to guarantee multi-byte UTF-8 character sequences are never severed mid-character, completely eliminating `\uFFFD` corruption.
   - **Dual-Budget Packing Engine**: Enforces strict per-skill (default 8 KiB) and aggregate (default 32 KiB) byte limits. When limits are approached, gracefully falls back to structured summary cards (`*[SUMMARY ONLY: ...]*`), saving **35–50% context tokens** while preserving critical execution instructions.

4. **Telemetry & Activity HUD Deep Integration (`SubagentService`, `SubagentSidebar`)**:
   - **Immutable Dispatched Metadata**: Subagents track immutable `EccDispatchedMetadata` records preserving source asset IDs, applied skill IDs, content SHA-256 digests, and exact byte counts (raw vs injected) across all lifecycle states (`running`, `completed`, `error`).
   - **Visual Queue Indicators**: Active subagents dispatched from ECC display an eye-catching `✨ ECC` badge alongside a live `% saved` token compression metric directly on list items.
   - **Dedicated Inspector Card**: Clicking any subagent item opens a detailed modal inspector featuring an "ECC Capability & Skills" telemetry card with full provenance data.

5. **Dual-Oracle Rigor & Architectural Excellence**:
   - **523 Deterministic Tests Passing 100%**: Added 37 comprehensive unit, integration, and adversarial tests (`ecc-catalog.test.ts`, `ecc-dispatcher.test.ts`, `ecc-skill-injector.test.ts`, `ecc-telemetry.test.ts`, `ecc-catalog.audit.test.ts`) with zero test regressions.
   - **Stage 4 Adversarial Audit Verified**: Passed rigorous examination by Stage 4 Oracle (`audit_and_break_code_with_gpt`), resolving bidirectional Unicode vulnerabilities before deployment.
   - **Perfect AQI 5.0 / 5.0**: Zero architectural violations, zero circular dependencies, and clean module boundaries.
   - **Isolated Experimental Probes**: Ongoing provider quota instrumentation cleanly isolated on branch `experimental/antigravity-quota`.

---

## 🌟 Release History

### v2.12.1: Token & Quota Observability

Version `2.12.1` introduces enterprise-grade **Token & Quota Observability** alongside intelligent **Context Optimization**, integrating architectural patterns adapted from `codeburn` into the Cockpit without spawning speculative abstractions or extra Electron windows:

1. **Per-Worktree / Branch Token Attribution Ledger (`WorktreeAttributionService`, `TelemetryService`)**:
   - **Fine-Grained Attribution**: Traces prompt, completion, and cached token consumption directly back to specific Git worktrees and branches with deterministic path hashing.
   - **Immutable Attribution Ledger**: Idempotent event recording (`recordUsageEvent`) guarantees replaying identical events never double-counts tokens or overwrites historical branch allocations (**GA1**, **GA2**).
   - **Accurate Token Math**: Strict separation of uncached input, cached input, and output tokens preventing duplicate accounting (**GA5**).
2. **Context Optimization & Deduplication Engine (`ContextOptimizationService`, IPC `context:analyze`)**:
   - **Report-Only Analysis**: Accurately analyzes token footprint, identifying duplicate instructions and unused registered MCP tools to prevent prompt bloat.
   - **Specification Integrity Invariant**: Mandatory oversized system instructions (e.g. `AGENTS.md`) produce actionable warnings while leaving the underlying prompt files 100% unmutated and untouched (**GA3**).
3. **Provider Capacity HUD & Rolling Quota Observability (`ProviderCapacityService`, `TelemetryHud`)**:
   - **External Rolling Quota Tracking**: Observes rate limits, remaining tokens/requests, and window reset deadlines across providers (OpenAI, Gemini, Anthropic).
   - **Karpathy-Compliant HUD Integration**: Integrated directly into the existing Cockpit footer HUD with a compact `Gauge` icon badge—zero extra Electron windows spawned.
   - **Fail-Closed Quota Expiration**: Expired observations (`expiresAt <= now`) strictly transition to `source: "unavailable"` and nullify remaining/limit numbers, rendering clean `N/A` badges instead of misleading speculative metrics (**GA4**).
4. **Adversarial Hardening & Deep Immutability**:
   - **Stage 4 Adversarial Remediation**: Passed thorough scrutiny by Stage 4 Oracle (`audit_and_break_code_with_gpt`) with deep defensive copying (`cloneMetrics`, `cloneProviderCapacity`, `cloneBranchSummary`) across all snapshot and listener boundaries (**IMM-01**, **IMM-02**).
   - **467 Deterministic Tests Passing 100%**: Expanded test suite with 23 new unit, integration, and adversarial contract tests (`worktree-attribution-ledger.test.ts`, `context-optimization.test.ts`, `provider-capacity.test.ts`, `telemetry-snapshot-immutability.test.ts`, `telemetry-contract-adversarial.test.ts`).
   - Protected Evaluation Zone (`.eval/`) 100% intact; AQI compliance 10/10.

---

### v2.11.0: DeepSeek Harness Runtime Integration

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
   - **444 Deterministic Tests Passing 100%**: Added 7 adversarial regression test suites (`deepseek-harness-stage4-remediation.test.ts`) covering executor sandbox enforcement, dangling symlink defense, concurrent repetition limits, non-cooperative tool timeouts, malformed envelope protection, and journal crash recovery.
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

### 4. Everything Claude Code (ECC) Absorption & Skill Context Engine
- **Read-Only Capability Catalog (`EccCatalogService`)**: Dynamic discovery of external specialized agents and modular skills from `~/.claude/` or custom source roots without creating temporary files, symlinks, or repo pollution in client workspaces.
- **4-Tier Security Quarantine Sandbox**:
  - *Symlink Traversal Guards*: Resolves real canonical destinations via `fs.realpathSync`, neutralizing path escape attempts.
  - *Size Ceiling Enforcement*: Strictly rejects oversized assets (> 512 KiB) to thwart memory exhaustion.
  - *Suspicious Unicode Quarantine (`SUSPICIOUS_UNICODE_REGEX`)*: Quarantines assets harboring stealth zero-width characters (`\u200B\u200C\u200D\u2060\uFEFF`) and bidirectional embedding/override markers (`\u200E\u200F\u202A-\u202E\u2066-\u2069`) to shut down hidden prompt-injection vectors (hardened via `ECC-001`).
  - *Payload Containment*: Isolates unverified shell scripts and executable binaries.
- **Dynamic Skill Context Injector (`EccSkillContextInjector`)**:
  - Compacts markdown documents by stripping frontmatter, HTML comments, badges, and redundant links to maximize prompt token density.
  - Applies multibyte-safe UTF-8 boundary slicing (`sliceUtf8Safe`) to avoid `\uFFFD` character corruption.
  - Dual-budget packing (8 KiB per-skill ceiling, 32 KiB aggregate limit) with intelligent fallback to reference summary cards (`*[SUMMARY ONLY: ...]*`), saving 35–50% context tokens.
- **Interactive Dispatch UI & Cockpit Queue Integration (`EccCatalogView.tsx`, `SubagentSidebar.tsx`)**:
  - Subagent drawer with dual-tab switcher: *Active Queue* and *ECC Library*.
  - Full search and filtering across categories and asset kinds (Agents vs. Skills).
  - Interactive multi-skill chip composer with prompt preview and 1-click dispatch into the canonical autonomous loop.
  - Subagent queue items display distinct `✨ ECC` badges with live `% saved` token compression chips, backed by a detailed provenance inspector modal.

### 5. Canonical Autonomous Loop v3.0 & Hard Gates ([docs/LOOP.md](docs/LOOP.md))
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

### 6. Docker Sandbox & Container Isolation
- When container `kins_autonomous_sandbox` is active, all builds, dependency installations, and test runs execute inside Docker for complete host OS isolation.
- Automatic container health polling (`Active`, `Stopped`, or `Unavailable`) displayed directly on the HUD.

### 7. Architectural Quality Index (AQI v2.0) & Compliance Engine
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
- **Testing**: Node.js Native Test Runner (`node --test`), assert module (**523 deterministic unit, integration, and harness tests passing 100%**)

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

- **Run Full Deterministic Test Suite (523 tests)**:
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
│   │   ├── services/          # Telemetry, WorktreeAttribution, ContextOptimization, ProviderCapacity, EccCatalog, EccDispatcher, EccSkillContextInjector, SubagentService, Pty, McpMonitor, LoopState, TranscriptIngestion, HarnessService
│   │   ├── ipc.ts             # Typed IPC event bridge (cockpitApi.ecc.*)
│   │   └── index.ts           # Window lifecycle & service bootstrapping
│   ├── preload/               # Context bridge (esbuild -> CommonJS)
│   ├── renderer/              # React 19 UI
│   │   ├── components/        # PhaseTracker, TelemetryHud, McpSidebar, RunActivityPanel, TerminalStage, CriticalLogDrawer, EccCatalogView, SubagentSidebar
│   │   ├── App.tsx            # Cockpit mission-control layout & event wiring
│   │   └── main.tsx           # UI entrypoint
│   ├── shared/                # Shared contracts, phases, usage, contextOptimization, providerCapacity, eccContracts
│   └── engine.ts              # Canonical LoopEngine state machine
├── docs/
│   └── LOOP.md                # Normative Autonomous Loop v3.0 specification
├── wiki/                      # Karpathy LLM-Wiki Knowledge Base
│   ├── decisions/             # Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── pitfalls.md            # Living pitfalls and cognitive traps registry
│   └── log.md                 # Autonomous execution log
├── test/                      # 523 automated unit, integration, and adversarial tests
├── scripts/                   # harness (aqi/, pricing/, schemas/), ai-loop.mjs, ai-exec.mjs, init-template.mjs
├── start-cockpit.bat          # 1-click Windows desktop batch launcher
└── .eval/                     # Read-only golden assertions locked by SHA-256
```

---

## 📄 License

MIT © [Kin / Creter2608](https://github.com/Creter2608)
