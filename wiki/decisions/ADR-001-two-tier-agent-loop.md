# ADR-001: 2-Tier Multi-Agent Pipeline & Zero-Token Verification Architecture

**Status:** Accepted  
**Date:** 2026-09-03  
**Deciders:** Core Engineering Team  
**Consulted:** Andrej Karpathy Behavioral Invariants, Superpowers Framework  

---

## Context
Autonomous AI coding agents frequently suffer from two critical operational pathologies:
1. **Semantic Drift & Hallucinated Logic**: Agents attempting simultaneous architectural design, code synthesis, and self-evaluation often change test assertions to force failing code to pass.
2. **Infinite Token Drain**: Re-invoking large frontier models (e.g. GPT-4o / Claude 3.5 Sonnet) on repetitive compilation or syntax errors rapidly exhausts rate limits and costs tens of dollars per task.

## Decision
We enforce a strict **2-Tier Multi-Agent Separation of Concerns**:
1. **Layer 1: GPT Prompt Architect (One-Shot Blueprint)**:
   - Invoked AT MOST ONCE per task via MCP tool `craft_technical_prompt_with_gpt`.
   - Generates independent architectural specification and compact adversarial test assertions (3–5 Input/Expected Output pairs, ~100 tokens).
2. **Layer 2: Gemini 3.8 Flash (Host Operator & Native Code Synthesizer)**:
   - Performs context gathering, file I/O, and direct code synthesis.
   - Executes verification commands locally on CPU (`npm test`, `tsc`) at **$0 model token cost**.
   - Strictly bounded by `verificationRetry <= 1`. If local verification fails twice, execution immediately halts.
3. **Execution Isolation**: Shell operations run inside Docker sandbox `kins_autonomous_sandbox`.

## Consequences
### Positive
- Predictable token spend: $0 CPU verification loops save > 80% tokens per session.
- Elimination of specification gaming: Layer 2 is prohibited from modifying `.eval/` golden assertions.
- Fast turnaround: High-throughput code synthesis via Gemini 3.8 Flash.

### Trade-Offs
- Requires Docker sandbox environment to be active for untrusted operations.
- Single-retry ceiling requires disciplined, root-cause hypothesis generation prior to code edits.
