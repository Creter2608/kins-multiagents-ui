# AI-Ready Project Template

A high-performance, deterministic, and security-hardened codebase template designed specifically for autonomous AI coding agents (Antigravity, Claude Code, Cursor, Windsurf).

---

## ⚡ Core Features

- **Standardized Autonomous Loop ([docs/LOOP.md](docs/LOOP.md))**: 6-phase deterministic state machine with strict phase transitions.
- **2-Tier Multi-Agent Pipeline**: Layer 1 GPT Architect (strategic blueprint & assertions) + Layer 2 Gemini 3.8 Flash (native code synthesis & local execution).
- **Anti-Token-Drain Protocol**: Local CPU verification ($0 LLM tokens) with hard cap of 1 retry on test failure.
- **Adversarial Quality Gates**: Built-in integration with `agency-reality-checker` and `agency-ai-generated-code-security-auditor`.
- **Karpathy Behavioral Invariants**: Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution.
- **Multi-Agent Thin Adapters**: Native zero-drift pointers for Claude Code ([`CLAUDE.md`](CLAUDE.md)), Cursor ([`.cursor/rules/`](.cursor/rules/autonomous-loop.mdc)), and GitHub Copilot ([`.github/`](.github/copilot-instructions.md)).
- **Token Shielding & Discovery**: Standardized [`llms.txt`](llms.txt) API roadmap, [`repomix.config.json`](repomix.config.json) compression, and [`.aidigestignore`](.aidigestignore).
- **Byte-Capped AI Runners**: `npm run test:ai` and `npm run typecheck:ai` capping output at 32 KiB to prevent terminal token flooding.
- **Living Knowledge & ADRs ([wiki/](wiki/))**: Persistent markdown wiki with structured Architecture Decision Records ([wiki/decisions/](wiki/decisions/ADR-001-two-tier-agent-loop.md)) and Living Pitfalls Registry ([wiki/pitfalls.md](wiki/pitfalls.md)).
- **CodeGraph Ready**: Ready for instant AST indexing via `codegraph init`.

---

## 🚀 Getting Started

1. Initialize CodeGraph index (once code files are added):
   ```bash
   codegraph init
   ```

2. Review the Loop specification:
   ```bash
   cat docs/LOOP.md
   ```

3. View autonomous execution history:
   ```bash
   cat wiki/log.md
   ```

---

## 🐳 Docker Sandbox & Container Isolation

This repository includes turnkey Docker and DevContainer support for 100% isolated execution:

- **Run tests inside Docker container:**
  ```bash
  npm run test:docker
  ```
- **Type-check inside Docker:**
  ```bash
  npm run typecheck:docker
  ```
- **Interactive Sandbox Shell:**
  ```bash
  npm run sandbox:sh
  ```
- **Dev Containers:** Open in VS Code / Antigravity / Cursor and click *"Reopen in Container"* for a fully isolated development environment.

---

## 📁 Repository Structure & Code Placement

- **`src/` & `test/`**: All application logic, domain modules, and unit tests belong in standard source directories (`src/`, `test/`), completely outside `wiki/`.
- **`wiki/`**: Dedicated strictly to durable, compounding project knowledge (ADRs, architectural syntheses, pitfalls registry, and execution logs) per Karpathy's LLM-Wiki standard.
- **`.eval/`**: Protected ground truth test assertions cryptographically bound by SHA-256 (`npm test`).
