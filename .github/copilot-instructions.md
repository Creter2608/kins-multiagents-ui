# GitHub Copilot Custom Instructions

Canonical guidelines and operational specifications reside in [AGENTS.md](../AGENTS.md) and [docs/LOOP.md](../docs/LOOP.md).

## Operational Standards
- **Karpathy Principles**: Minimum code that solves the problem. No speculative abstractions. Match existing TypeScript patterns.
- **Docker-First Mandate**: Shell commands MUST run inside `kins_autonomous_sandbox` via `docker exec kins_autonomous_sandbox <cmd>` when the container is active.
- **Protected Verification**: Files in `.eval/` are immutable. Tests must be verified using `npm test`.
- **Zero-Token Output**: Prefer byte-capped test runners (`npm run test:ai`) to prevent terminal context flooding.
