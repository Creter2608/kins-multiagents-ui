# Autonomous Agent Operating Guidelines (AGENTS.md)

This repository enforces an **Enterprise-Grade AI-Ready Standard (v2.0)** designed for deterministic, token-efficient, and security-hardened autonomous pair programming.

---

## 🔁 Mandatory Autonomous Loop v2.0

All autonomous workflows, feature implementations, refactors, and bugfixes in this repository **MUST** strictly adhere to the normative specification:
👉 **[Autonomous Loop Specification v2.0 (docs/LOOP.md)](docs/LOOP.md)**

```text
INITIALIZE ➔ SPEC_GATE ➔ ISOLATE (Git Worktree) ➔ DETECT_STACKS ➔ PLAN (Layer 1 GPT) 
       ➔ EXECUTE (Layer 2 Gemini) ➔ VERIFY (Local CPU $0) ➔ REALITY_CHECK (Agency Squad) 
       ➔ RELEASE_GATE (Human Sign-off) ➔ COMPLETE
```

---

## 🛡️ Core Operating Invariants

### 1. Protected Evaluation Zone (`.eval/`)
- The directory `.eval/` is **STRICTLY READ-ONLY** for all coding agents.
- Agents **MUST NOT** edit, relax, comment out, delete, or regenerate golden assertions to force tests to pass. Any tampering triggers immediate `FAILED: SPECIFICATION_INTEGRITY`.

### 2. Execution Isolation & Sandboxing (DOCKER-FIRST MANDATE)
- When the sandbox container `kins_autonomous_sandbox` is active, all shell operations (dependency installation, compilation, linting, test suites, script execution) **MUST 100% RUN INSIDE DOCKER** via:
  `docker exec kins_autonomous_sandbox <command>`
- Agents **MUST NOT** run package installations (`npm install`, `pip install`) or execute untrusted code directly on the host Windows machine.
- Non-trivial tasks **MUST** also run inside an isolated Git worktree (`using-git-worktrees`).

### 3. Hard Resource & Recursion Ceilings
- `verificationRetry <= 1` (Max 1 targeted fix retry after local test failure).
- `qualityRemediation <= 1` (Max 1 remediation after non-critical audit findings).
- `globalCycles <= 5` (Max 5 outer loop cycles per session).
- `MAX_TOKENS_PER_RUN = 60,000` | `MAX_COST_USD = $0.50`. Exceeding limits halts execution immediately.

### 4. Systematic Debugging & Error Triage
- Infrastructure/Environment errors (ports, locks, network) do not burn code retry quota.
- Before modifying code during a semantic retry, Layer 2 **MUST** formulate and document a root-cause hypothesis based on the trimmed stack trace.

### 5. Context Pruning & Diff-First
- Terminal error excerpts are trimmed to **20–30 high-signal lines**.
- Verification is **Diff-First** (`git diff -U3`); full-file re-reading after edits is prohibited.
- Only the compact `RunRecord` JSON is transferred across phases.

### 6. Human-in-the-Loop (HITL) Proactive Gates
- **`SPEC_SIGN_OFF`**: Major architecture/schema changes require explicit user approval after planning.
- **`DESTRUCTIVE_ACTION`**: File deletions (`rm`), database drops, or secret changes require interactive confirmation.
- **`FINAL_RELEASE`**: Reality Checker evidence must be submitted for user sign-off before merge.

---

<!-- CODEGRAPH_START -->
## CodeGraph & Context Extraction

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root):
1. **Mandatory Usage**: Run `codegraph explore "<query>"` before reading entire files. Extract only the exact symbols, interfaces, and call graphs needed.
2. **Transparency Tag**: Whenever `.codegraph/` is used, output:
   `🔍 [CodeGraph Context]: Extracted <N> symbols (<symbol names>) from .codegraph/`
3. If no `.codegraph/` directory exists, proceed using targeted search tools and notify the user to run `codegraph init` when ready.
<!-- CODEGRAPH_END -->

<!-- SUPERPOWERS_TEMPLATES_START -->
## Superpowers Template Enforcement & Routing

When executing engineering workflows, Layer 1 MUST automatically route tasks to the designated Superpowers template framework:
- **Feature Implementation / Bugfix / Coding**: Apply `implementer-prompt.md`
- **Code Review / Validation**: Apply `task-reviewer-prompt.md`
- **Planning & Architecture**: Apply `writing-plans/plan-document-reviewer-prompt.md`
- **Brainstorming / Spec Formulation**: Apply `brainstorming/spec-document-reviewer-prompt.md`

### Template Transparency Tag
`📋 [Template Applied]: Loaded <template-name.md> for <workflow-stage>`
<!-- SUPERPOWERS_TEMPLATES_END -->

<!-- KARPATHY_GUIDELINES_START -->
## Karpathy Behavioral Invariants & Anti-Pitfall Principles

👉 **[Living Pitfalls Registry (wiki/pitfalls.md)](wiki/pitfalls.md)**: Mandatory catalog of past failure modes and cognitive traps. Consult before planning or code changes.

Adhere strictly to Andrej Karpathy's core engineering principles:

### 1. Think Before Coding
- **Don't assume. Don't hide confusion. Surface tradeoffs.**
- State assumptions explicitly before implementing. If uncertain, ask rather than guess.
- If multiple valid interpretations exist, present them to the user—do not pick silently.
- If something is unclear, stop immediately and ask for clarification.

### 2. Simplicity First
- **Minimum code that solves the problem. Nothing speculative.**
- Do not add features beyond what was explicitly requested.
- No unnecessary abstractions for single-use code.
- No unrequested "flexibility" or "configurability".
- The test: Would a senior engineer consider this overcomplicated? If yes, simplify.

### 3. Surgical Changes
- **Touch only what you must. Clean up only your own mess.**
- Do not "improve" adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing project style, even if you prefer otherwise.
- Clean up only orphaned imports, variables, or functions that YOUR changes made unused.
- The test: Every changed line must trace directly to the user's request.

### 4. Goal-Driven Execution
- **Define success criteria and loop until deterministically verified.**
- Transform tasks into verifiable goals ("Write test -> Fix bug -> Verify pass").
- For multi-step tasks, state a brief plan with verifiable checkpoints before touching code.
<!-- KARPATHY_GUIDELINES_END -->

<!-- AGENCY_CHECKPOINTS_START -->
## Agency Core Checkpoints

Mandatory specialist gates enforced by [Autonomous Loop](docs/LOOP.md):
- **Architecture & System Design**: `agency-backend-architect`
- **Database Schema & Migrations**: `agency-database-optimizer`
- **Pre-Completion Reality Audit**: `agency-reality-checker` (Rejects unverified claims, defaults to "NEEDS WORK")
- **AI Security Audit**: `agency-ai-generated-code-security-auditor` (Scans for hallucinated dependencies & credential leaks)
- **Living Knowledge Compounding**: `agency-llm-wiki-curator`
<!-- AGENCY_CHECKPOINTS_END -->
