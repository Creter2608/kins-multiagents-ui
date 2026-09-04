# ADR-004: Release 2.0.0 Standardization & Enterprise-Grade Autonomous Loop

## Status
Accepted

## Context
The project evolved from an initial experimental prototype into a production-grade desktop mission-control cockpit for autonomous AI pair programming. While the engine and core specification transitioned to the Enterprise-Grade Autonomous Loop v2.0, legacy 6-phase terminology and prototype versioning (`0.1.0`) remained scattered across scripts, wiki records, and package manifests. A formal standardization to version `2.0.0` establishes semantic clarity, enforces the canonical 10-phase sequence, and cements telemetry ceiling safeguards.

## Decision
1. **Package Version Standardization**: Bump root `package.json` and package manifests to `2.0.0`.
2. **Canonical 10-Phase Sequence**: Standardize all scripts (`scripts/ai-loop.mjs`), engines (`src/engine.ts`, `src/shared/phases.ts`), and living knowledge documentation on the exact 10 canonical phases in sequential order:
   - `INITIALIZE`
   - `SPEC_GATE`
   - `ISOLATE`
   - `DETECT_STACKS`
   - `PLAN`
   - `EXECUTE`
   - `VERIFY`
   - `REALITY_CHECK`
   - `RELEASE_GATE`
   - `COMPLETE`
3. **Cockpit UI Release Identity & Telemetry Safeguards**:
   - Header badge displaying `v2.0.0` prominently in `App.tsx`.
   - Telemetry HUD display communicating hard budget ceilings: **`$0.50`** USD spend limit and **`60k tokens`** execution ceiling.
4. **Specification & Anti-Tampering Invariant**: Preserve read-only evaluation contracts in `.eval/` locked by cryptographic SHA-256 anchors.

## Consequences
- Single source of truth for all autonomous workflows, subagent runners, and human operators.
- Zero ambiguity regarding loop phases or transition rules.
- Local verification on CPU ($0 LLM token spend) guaranteed via automated regression tests.
