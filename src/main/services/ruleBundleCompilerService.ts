/**
 * src/main/services/ruleBundleCompilerService.ts
 * Compiles canonical Karpathy, Dual-Oracle, CodeGraph, and Autonomous Loop V3 rules
 * deterministically across various agentic formats (AGENTS.md, CLAUDE.md, GEMINI.md, Cursor MDC).
 */

export interface CompiledRuleBundle {
  readonly agentsMarkdown: string;
  readonly claudeMarkdown: string;
  readonly geminiMarkdown: string;
  readonly cursorMdc: string;
}

const UNIVERSAL_INVARIANTS = `# Autonomous Agent Operating Guidelines

This environment enforces an **Enterprise-Grade AI-Ready Standard (v2.0)** designed for deterministic, token-efficient, and security-hardened autonomous pair programming.

---

## 🔁 Mandatory Autonomous Loop v2.0

All autonomous workflows, feature implementations, refactors, and bugfixes MUST strictly adhere to the loop workflow:
\`\`\`text
INITIALIZE -> SPEC_GATE -> ISOLATE -> DETECT_STACKS -> PLAN (Stage 2 GPT Architect) 
       -> EXECUTE (Layer 2 Gemini) -> VERIFY (Local CPU $0) -> REALITY_CHECK (Stage 4 GPT Adversary) 
       -> RELEASE_GATE (Human Sign-off) -> COMPLETE
\`\`\`

---

## 🛡️ Core Operating Invariants

### 1. Protected Evaluation Zone (.eval/)
- The directory \`.eval/\` is **STRICTLY READ-ONLY** for all coding agents.
- Agents MUST NOT edit, relax, comment out, delete, or regenerate golden assertions to force tests to pass. Any tampering triggers immediate \`FAILED: SPECIFICATION_INTEGRITY\`.

### 2. Execution Isolation & Sandboxing
- When container sandbox \`kins_autonomous_sandbox\` is active, shell operations MUST run inside Docker:
  \`docker exec kins_autonomous_sandbox <command>\`
- Agents MUST NOT run untrusted package installations directly on host without containment.

### 3. Hard Resource & Recursion Ceilings
- \`verificationRetry <= 1\` (Max 1 targeted fix retry after local test failure).
- \`qualityRemediation <= 1\` (Max 1 remediation after non-critical audit findings).
- \`globalCycles <= 5\` (Max 5 outer loop cycles per session).
- \`MAX_TOKENS_PER_RUN = 60,000\` | \`MAX_COST_USD = $0.50\`. Exceeding limits halts execution immediately.

### 4. Systematic Debugging & Error Triage
- Infrastructure/Environment errors (ports, locks, network) do not burn code retry quota.
- Before modifying code during a semantic retry, formulate and document a root-cause hypothesis based on the trimmed stack trace.

### 5. Context Pruning & Diff-First
- Terminal error excerpts are trimmed to 20-30 high-signal lines.
- Verification is Diff-First (\`git diff -U3\`); full-file re-reading after edits is prohibited.

### 6. Dual-Oracle Protocol & Anti-Token-Drain
- Stage 2: Independent technical blueprint & compact golden test assertions.
- Stage 4: Adversarial reality audit. Zero re-invocations permitted for syntax errors (handled $0 on CPU).

---

<!-- CODEGRAPH_START -->
## CodeGraph & Context Extraction

In repositories with CodeGraph (.codegraph/ or MCP codegraph):
1. **Mandatory MCP Usage**: Run \`codegraph_explore\` BEFORE reading entire files or calling external model MCPs.
2. **Never Probe .codegraph/ with find_by_name**: .codegraph/ is dot-prefixed and gitignored. Invoke CodeGraph MCP directly.
3. **Transparency Tag**: Output \`🔍 [CodeGraph Context]: Extracted <N> symbols from .codegraph/\`
<!-- CODEGRAPH_END -->

<!-- SUPERPOWERS_TEMPLATES_START -->
## Superpowers Template Enforcement & Routing

Route tasks to designated Superpowers template framework:
- Feature Implementation / Bugfix / Coding: \`implementer-prompt.md\`
- Code Review / Validation: \`task-reviewer-prompt.md\`
- Planning & Architecture: \`writing-plans/plan-document-reviewer-prompt.md\`
- Brainstorming / Spec Formulation: \`brainstorming/spec-document-reviewer-prompt.md\`

### Template Transparency Tag
\`📋 [Template Applied]: Loaded <template-name.md> for <workflow-stage>\`
<!-- SUPERPOWERS_TEMPLATES_END -->

<!-- KARPATHY_GUIDELINES_START -->
## Karpathy Behavioral Invariants & Anti-Pitfall Principles

### 1. Think Before Coding
- Don't assume. Don't hide confusion. Surface tradeoffs.
- State assumptions explicitly before implementing. If uncertain, ask rather than guess.
- If multiple valid interpretations exist, present them to the user - do not pick silently.
- If something is unclear, stop immediately and ask for clarification.

### 2. Simplicity First
- Minimum code that solves the problem. Nothing speculative.
- Do not add features beyond what was explicitly requested.
- No unnecessary abstractions for single-use code.
- No unrequested "flexibility" or "configurability".
- The test: Would a senior engineer consider this overcomplicated? If yes, simplify.

### 3. Surgical Changes
- Touch only what you must. Clean up only your own mess.
- Do not "improve" adjacent code, comments, or formatting.
- Do not refactor things that are not broken.
- Match existing project style, even if you prefer otherwise.
- Clean up only orphaned imports, variables, or functions that YOUR changes made unused.
- The test: Every changed line must trace directly to the user's request.

### 4. Goal-Driven Execution
- Define success criteria and loop until deterministically verified.
- Transform tasks into verifiable goals ("Write test -> Fix bug -> Verify pass").
- For multi-step tasks, state a brief plan with verifiable checkpoints before touching code.
<!-- KARPATHY_GUIDELINES_END -->
`.trim();

export class RuleBundleCompilerService {
  compileUniversalRules(): CompiledRuleBundle {
    const normalizedBody = UNIVERSAL_INVARIANTS.replace(/\r\n/g, "\n");

    const agentsMarkdown = normalizedBody + "\n";
    const claudeMarkdown = normalizedBody + "\n";
    const geminiMarkdown = normalizedBody + "\n";
    const cursorMdc = [
      "---",
      "description: Kin Autonomous Loop V3 & Karpathy Engineering Invariants",
      "globs: *",
      "---",
      "",
      normalizedBody,
      ""
    ].join("\n");

    return Object.freeze({
      agentsMarkdown,
      claudeMarkdown,
      geminiMarkdown,
      cursorMdc
    });
  }
}
