# Knowledge Base Index (wiki/index.md)

Welcome to the living project knowledge base, structured according to Andrej Karpathy's `llm-wiki` architecture.

## 🗂️ Categories

### 🏛️ Architecture & Standards
- [Autonomous Agent Loop (docs/LOOP.md)](../docs/LOOP.md) - Canonical 6-phase state machine.
- [Agent Operating Guidelines (AGENTS.md)](../AGENTS.md) - Repository instructions and invariants.

### 📦 Components & Modules
*(Will be incrementally cataloged during Phase 6 Knowledge Compounding)*

### 📝 Decision Records & Syntheses
- [ADR-001: 2-Tier Multi-Agent Pipeline & Zero-Token Verification](decisions/ADR-001-two-tier-agent-loop.md) - Layer 1 GPT Architect + Layer 2 Gemini Operator model separation.
- [ADR-002: Multi-IDE Thin Adapters, Persistent Loop Runner & Project Scaffolding](decisions/ADR-002-multi-ide-and-persistent-loop.md) - Universal adapters, persistent LoopEngine runner, and deterministic scaffolding.
- [ADR-003: Desktop Cockpit Architecture for Antigravity CLI](decisions/ADR-003-desktop-cockpit-architecture.md) - Mission-control desktop UI, ConPTY terminal, telemetry HUD, and log tailing.

### ⚠️ Pitfalls & Anti-Patterns (Failure Modes & Lessons Learned)
- [Pitfalls Registry (wiki/pitfalls.md)](pitfalls.md) - Living catalog of real-world stumbling blocks, cognitive traps, and preventive invariants.

---
*Maintained autonomously by `agency-llm-wiki-curator`.*
