# ADR-003: Desktop Cockpit Architecture for Antigravity CLI

## Status
Accepted

## Context
Antigravity CLI (`agy`) runs in a terminal without visual peripheral awareness of MCP servers, active autonomous loop phases, token cache statistics, or background container health. Developers require a cockpit mission-control interface that preserves full terminal interactivity while presenting real-time telemetry HUD panels and collapsible critical error logs.

## Decision
1. **Frontend / Terminal Stack**: Electron + React 19 + Tailwind CSS + `@xterm/xterm` + `node-pty`.
2. **Process Separation**:
   - **Main Process**: Owns PTY process lifecycle, file watchers (`.ai/state.json`, `cli.log`), Docker inspect polling, and typed IPC bridge.
   - **Renderer Process**: Pure React functional UI with dark theme, responsive 3-column layout, collapsible bottom drawer, and telemetry HUD.
3. **Fault-Tolerant Telemetry & Log Tailing**:
   - State file reads gracefully handle mid-write malformed JSON by preserving last valid snapshot.
   - `cli.log` uses byte-offset tailing with automatic truncation / rotation detection.
   - Cache hit % explicitly handles 0/0 edge-case by returning `null` ("N/A") rather than `NaN`.

## Consequences
- 100% ANSI colors, terminal escape codes, and interactive prompts function reliably via Windows ConPTY.
- Zero token drain: local CPU execution, deterministic verification ($0 LLM tokens).
