# Kin's Multi-Agents UI (Cockpit)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-34-black.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Docker Sandbox](https://img.shields.io/badge/Docker-Sandboxed-2496ed.svg)](https://www.docker.com/)

**Kin's Multi-Agents UI** is a desktop mission-control cockpit designed for autonomous AI pair programming (Google Antigravity CLI, Claude Code, Cursor, Windsurf). It combines an interactive ConPTY terminal with live telemetry tracking, 10-phase autonomous loop progression, MCP server monitoring, and Docker sandbox isolation.

Repository: **[https://github.com/Creter2608/kins-multiagents-ui](https://github.com/Creter2608/kins-multiagents-ui)**

---

## ⚡ Core Features & Architecture

### 1. Interactive Mission-Control Cockpit
- **ConPTY Terminal Integration**: Full raw ANSI terminal powered by `@xterm/xterm` and `node-pty`, preserving interactive CLI prompts, bash sequences, and colors.
- **Restful Command Prompt Dark Aesthetic**: Tailored `#000000`/`#0c0c0c` console dark theme with soft zinc typography and emerald status indicators to prevent eye strain during extended autonomous sessions.
- **Collapsible Critical Log Drawer**: Automatic extraction and triaging of high-signal errors, glog filtering, and CLI output monitoring.
- **Active MCP Server Monitor**: Real-time peripheral awareness of connected MCP servers, tool call counts, latency, and operational health.

### 2. Live Telemetry HUD & Token Accounting
- **Provider Breakdown**: Displays prompt (in) and completion (out) tokens for both Layer 1 GPT and Layer 2 Gemini:
  - **GPT Telemetry**: In / Out / Cached tokens with real-time prompt cache hit percentage (`gpt-5.6-sol` pricing model: $4.00/1M uncached input, $0.40/1M cached input, $20.00/1M output).
  - **Gemini Telemetry**: In / Out tokens tracking Gemini 3.8 Flash. Output tokens explicitly account for **Thinking / Reasoning tokens**.
- **Session vs. All-Time Scopes**: Toggle between current active session metrics and persistent all-time cumulative counters (`telemetry_alltime.json`). Includes an instant 1-click `Reset` button for session counters.
- **Cost & Budget Circuit Breaker**: Real-time USD spend tracking against a hard configurable ceiling (`$0.50` default).

### 3. Canonical Autonomous Loop v2.0 ([docs/LOOP.md](docs/LOOP.md))
Deterministic state machine enforcing 10 canonical phases:
```text
INITIALIZE ➔ SPEC_GATE ➔ ISOLATE ➔ DETECT_STACKS ➔ PLAN 
       ➔ EXECUTE ➔ VERIFY ➔ REALITY_CHECK ➔ RELEASE_GATE ➔ COMPLETE
```
- **Auto-Transition via Transcript Signals**: `TranscriptIngestionService` tails `transcript.jsonl` in real-time, detecting tool calls and template banners (`craft_technical_prompt_with_gpt` ➔ `PLAN`, `write_to_file` ➔ `EXECUTE`, `npm test` ➔ `VERIFY`).
- **Interactive Phase Control & Rollback**: Single-step rollback capability and manual override with safety confirmation dialogs for destructive actions.
- **Zero-Token Local Verification**: Local CPU testing (`npm test`) at **$0 LLM token cost** with a hard ceiling of 1 fix retry.

### 4. Docker Sandbox & Container Isolation
- When container `kins_autonomous_sandbox` is active, all builds, dependency installations, and test runs execute inside Docker for complete host OS isolation.
- Automatic container health polling (`Active`, `Stopped`, or `Unavailable`) displayed directly on the HUD.

---

## 🛠️ Tech Stack

- **Desktop Framework**: Electron 34 + Node.js 22 LTS
- **UI & Styling**: React 19, TypeScript 5.7, Tailwind CSS 3.4, Lucide Icons
- **Terminal Core**: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`
- **Build System**: Vite 6, esbuild (CommonJS preload bundling), TypeScript Compiler (`tsc`)
- **Testing**: Node.js Native Test Runner (`node --test`), assert module (55+ deterministic tests)

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
1. **Development Mode (Vite Hot-Reload)**:
   ```bash
   npm run app:dev
   ```

2. **Production Desktop App**:
   ```bash
   npm run build
   npm run app:start
   ```

---

## 🧪 Verification & Testing Commands

All verification commands are CPU-bound ($0 LLM token spend):

- **Run Full Test Suite**:
  ```bash
  npm test
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
│   └── LOOP.md                # Normative Autonomous Loop v2.0 specification
├── wiki/                      # Karpathy LLM-Wiki Knowledge Base
│   ├── decisions/             # Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── pitfalls.md            # Living pitfalls and cognitive traps registry
│   └── log.md                 # Autonomous execution log
├── test/                      # 55+ automated unit and integration tests
├── scripts/                   # ai-loop.mjs, ai-exec.mjs, init-template.mjs
└── .eval/                     # Read-only golden assertions locked by SHA-256
```

---

## 📄 License

MIT © [Kin / Creter2608](https://github.com/Creter2608)
