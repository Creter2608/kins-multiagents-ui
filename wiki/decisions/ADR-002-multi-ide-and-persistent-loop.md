# ADR-002: Multi-IDE Thin Adapters, Persistent Loop Runner & Project Scaffolding

**Status:** Accepted  
**Date:** 2026-09-03  
**Deciders:** Core Engineering Team  
**Consulted:** Layer 1 GPT Architect, Autonomous Loop v2.0  

---

## Context
As the AI development ecosystem expands across IDEs (Cursor, Windsurf, Roo Code, Cline, GitHub Copilot) and agent orchestration frameworks:
1. Hardcoded, vendor-specific rules lead to configuration drift and maintenance fragmentation.
2. In-memory execution loops lose state upon CLI session termination and lack atomic persistence.
3. Repositories lack standardized scaffolding to replicate the protected `.eval/` zone into new projects.

## Decision
1. **Multi-IDE Thin Adapters**:
   - Provide ultra-compact adapters (`.windsurfrules`, `.clinerules`, `.roomodes`, `mcp.json`, `.cursor/rules/*.mdc`, `CLAUDE.md`, `.github/copilot-instructions.md`), each bounded under 1,024 bytes.
   - All adapters defer canonically to `AGENTS.md` and `docs/LOOP.md` as the single source of truth.
2. **Persistent Loop Runner (`scripts/ai-loop.mjs`)**:
   - Wraps `LoopEngine` with atomic JSON persistence (`.ai/state.json`) and exclusive file locking.
   - Enforces transition budgets, retry budgets, and terminal failure tracking across sessions.
3. **Project Scaffolding (`scripts/init-template.mjs`)**:
   - Deterministically initializes new AI-ready projects with path traversal protection, clean staging, fresh `.eval/golden_assertions.json`, and automated SHA-256 anchor computation.
4. **CI Autonomous Gate (`.github/workflows/ai-verify.yml`)**:
   - Continuous verification of tamper-proof assertions, types, and Docker execution.

## Consequences
### Positive
- Universal interoperability across all leading AI coding assistants without rule duplication.
- Resumable, crash-safe state machines for long-running autonomous workflows.
- Turnkey creation of new AI-ready repositories with guaranteed golden assertion verification.

### Trade-Offs
- State directory `.ai/` must be strictly excluded from git tracking and context digests.
