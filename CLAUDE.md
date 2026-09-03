# Claude Code Guidelines

Repository follows **Autonomous Loop v2.0**.
Canonical rules: 👉 [AGENTS.md](AGENTS.md) and [docs/LOOP.md](docs/LOOP.md).

## Operational Invariants
- **Docker-First**: When `kins_autonomous_sandbox` is active, run commands via: `docker exec kins_autonomous_sandbox <cmd>`.
- **Anti-Token-Drain**: $0 CPU verification (`npm test`, `npm run typecheck`). Hard cap: 1 retry on test failure.
- **Protected Eval**: `.eval/` is STRICTLY READ-ONLY. Never tamper with golden assertions.
- **Diff-First**: Inspect edits with `git diff -U3`. Do not re-read entire files.

## Commands
```bash
npm test          # Build + test suite
npm run typecheck # Type-check without emit
npm run test:ai   # Token-safe test runner (32 KiB cap)
```
