# Enterprise-Grade Autonomous Agent Loop Specification (LOOP.md)

**Version:** 3.0.0  
**Status:** Canonical & Mandatory  
**Applies To:** All autonomous and semi-autonomous coding workflows across all languages in this repository.

---

## 1. Purpose and Scope

This document specifies the normative **Enterprise-Grade Autonomous Agent Loop Architecture (v3.0)** governing all repository-modifying tasks in this project. The loop implements a **5-Stage 2-Tier Architecture (Two-Call Bounded Model)** that enforces strict separation of concerns across five operational stages:

1. **Stage 1 (Context Ingestion - $0 CPU)**: Local CodeGraph AST and dependency graph extraction (`codegraph_explore`) delivering 3,000–6,000 tokens of high-signal type interfaces and caller topologies without reading full files.
2. **Stage 2 (PLAN Gate - Layer 1 GPT Architect)**: High-level architectural planning via `craft_technical_prompt_with_gpt` producing an immutable Blueprint, Interface Contracts, and Golden Test Assertions.
3. **Stage 3 (EXECUTE & VERIFY - Layer 2 Gemini Flash & CPU)**: Native code synthesis by Gemini 3.8 Flash, followed by zero-token local CPU verification (`tsc`, `npm test`, `pytest`) and automated CPU AQI evaluation ($\ge 4.5/5.0$).
4. **Stage 4 (REALITY_CHECK Gate - Layer 1 GPT Adversarial QA & AQI Doctor)**: Skeptical, read-only adversarial audit via `audit_and_break_code_with_gpt` (bounded to 8,000–15,000 context tokens). Generates falsifiable edge-case test suites and actionable AQI prescriptions without directly mutating code.
5. **Stage 5 (Remediation & Deterministic Closure)**: If non-critical findings exist, Layer 2 applies targeted remediations in `EXECUTE`, verifies passes on CPU in `VERIFY`, and returns to `REALITY_CHECK` for **deterministic closure** (evaluating finding-linked tests with zero external model re-invocations).

> [!IMPORTANT]
> All repository-changing agents **MUST** strictly follow this loop. Repository-specific instructions override generic defaults only when explicitly documented and non-conflicting with security and verification invariants.

---

## 2. Canonical Constants, Enumerations & Symbols

### 2.1 Hard Execution Constants

```text
ERROR_EXCERPT_MAX_LINES = 30
ERROR_EXCERPT_MIN_TARGET_LINES = 20
GLOBAL_CYCLES_MAX = 2
GLOBAL_TASK_TIMEOUT_SECONDS = 2400
MAX_COST_USD = 0.50
MAX_TOKENS_PER_RUN = 60000
QUALITY_REMEDIATION_MAX = 1
VERIFICATION_RETRY_MAX = 1
```

### 2.2 Canonical Enumerations

```typescript
type Phase =
  | 'INITIALIZE'
  | 'SPEC_GATE'
  | 'ISOLATE'
  | 'DETECT_STACKS'
  | 'PLAN'
  | 'EXECUTE'
  | 'VERIFY'
  | 'REALITY_CHECK'
  | 'RELEASE_GATE'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'FAILED';

type AuditStatus =
  | 'pending'
  | 'running'
  | 'accepted'
  | 'remediation_required'
  | 'closure_pending'
  | 'closed'
  | 'failed';

type ErrorClass =
  | 'ENVIRONMENT_INFRA'
  | 'FLAKY_TEST'
  | 'SEMANTIC_CODE'
  | 'SPECIFICATION_INTEGRITY';

type Gate =
  | 'DESTRUCTIVE_ACTION'
  | 'FINAL_RELEASE'
  | 'SPEC_SIGN_OFF';

type GateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'BYPASSED_FORBIDDEN';
```

### 2.3 The Compact Run Record (Phase-Boundary State)

To prevent context bloat and token rot, **only** the canonical `RunRecord` JSON is transferred across phase boundaries:

```typescript
interface RunRecord {
  auditRemediation: number;      // Count of adversarial audit remediation cycles (<= 1)
  auditStatus: AuditStatus | null; // Adversarial QA status in REALITY_CHECK
  costUsd: number;               // Estimated cumulative USD cost (<= $0.50)
  errorClass: ErrorClass | null; // Classification of most recent failure
  evidence: string;              // Trimmed diagnostics (<= 30 lines) and diff summary
  gateStatus: Record<Gate, GateStatus>;
  globalCycles: number;          // Total outer loop cycles (<= 2)
  hypothesis: string | null;     // Root-cause hypothesis required before semantic retry
  phase: Phase;                  // Current canonical phase
  qualityRemediation: number;    // Count of quality remediation cycles (<= 1)
  terminalReason: string | null; // Explanation if BLOCKED or FAILED
  tokensUsed: number;            // Total cumulative token count (<= 60,000)
  verificationRetry: number;     // Count of code verification retries (<= 1)
}
```

---

## 3. The Nine Operational Pillars

### Pillar 1: Execution Isolation & Timeout Watchdog Hierarchy
* **Docker-First Execution Mandate**: Whenever the container `kins_autonomous_sandbox` is active, all shell operations (installing packages, building, running tests, executing scripts) **MUST 100% RUN INSIDE THE CONTAINER** via `docker exec kins_autonomous_sandbox <command>`. Host-level execution of arbitrary packages is strictly forbidden.
* **Hierarchical Timeout & Process-Tree Cleanup**:
  1. Outer task deadline: `GLOBAL_TASK_TIMEOUT_SECONDS = 2400` (40 minutes).
  2. Stage and command deadlines are bounded within the remaining global budget.
  3. Commands must run within a distinct process group. Upon cancellation or timeout, send `SIGTERM`, wait 15 seconds, then send `SIGKILL` to all descendants (`kill -9 -<PID>`) to eliminate zombie processes.
* **Git Worktree Sandbox (`using-git-worktrees`)**: All non-trivial tasks **MUST** execute inside an isolated Git worktree (`.worktrees/<task-id>`). The `main` branch remains untouched until final approval.
* **Failure to Isolate**: If worktree or container sandbox cannot be initialized, the loop **MUST** transition immediately to `BLOCKED`.

### Pillar 2: Anti-Tampering & Anti-Specification-Gaming Safeguards
* **SHA-256 Checksum Lock**: Layer 1 generates an immutable SHA-256 checksum over the Technical Blueprint and Golden Test Assertions.
* **Protected Evaluation Zone (`.eval/`)**: All golden assertions, benchmark suites, and validation contracts stored in `.eval/` are **STRICTLY READ-ONLY** for Layer 2.
* **Anti-Weakening Diff Audit**: Before release approval, `agency-reality-checker` audits `git diff` against test files:
  * Any deleted test assertions, broadened exception catches, weakened comparison operators, commented-out tests, or modified `.eval/` files trigger an immediate **`FAILED: SPECIFICATION_INTEGRITY`** hard stop.
  * Layer 2 **MUST NOT** recalculate or update checksums to match modified tests.

### Pillar 3: Context Pruning & Compaction Protocol
* **Smart Error Trimming**: Terminal outputs from failed compilers or test runners MUST be trimmed to a high-signal window of **20–30 lines** (max 30 lines) capturing only the failing command, assertion failure, line number, and immediate stack frame. Repetitive runtime noise and successful suite outputs MUST be stripped.
* **Diff-First Verification**: After code edits, Layer 2 MUST inspect changes using `git diff -U3 -- <files>`. Re-reading entire source files after minor edits is **STRICTLY PROHIBITED**.
* **Phase-Boundary Compaction**: When moving between phases, all scratch thoughts, intermediate tool outputs, and raw traces are dropped. Only the compact `RunRecord` JSON is propagated.

### Pillar 4: Error Triage & Systematic Debugging
When a command fails in `VERIFY`, the error MUST be classified before any action is taken:

| Error Class | Example Causes | Retry Accounting | Required Action |
| :--- | :--- | :---: | :--- |
| **`ENVIRONMENT_INFRA`** | Port in use, file lock, network timeout, missing OS tool, permission denied. | **0 code retries burned** (Consumes cycle/token budget only). | Remediate environment (e.g. kill process, unlock file) or transition to `BLOCKED`. |
| **`SEMANTIC_CODE`** | Type error, assertion failure, compilation error, runtime exception. | **Increments `verificationRetry` (+1).** Hard cap: max 1 retry allowed. | **Systematic Debugging:** Must record a falsifiable `hypothesis` based on trimmed stack trace before modifying code. |
| **`FLAKY_TEST`** | Intermittent timing failure confirmed by identical re-run with zero code changes. | Does not burn code retry on first confirmation. | Re-run once. If nondeterminism persists, classify as `BLOCKED`. |
| **`SPECIFICATION_INTEGRITY`** | Checksum mismatch, attempt to modify `.eval/`, weakened assertions. | **Immediate Hard Stop.** | Transition to `FAILED`. Zero retries permitted. |

### Pillar 5: Prompt Caching & Prefix Optimization Protocol
To maintain a consistent **$\ge 80\%$ Cache Hit rate** on modern LLMs:
* **2-Zone Prompt Layout**:
  1. **Invariant Static Head ($\ge 1,024$ tokens)**: System Role, Karpathy Behavioral Invariants, Agency Guidelines, Error Matrix, and Stack Adapters. Must remain **100% byte-identical** across all requests.
  2. **Dynamic Tail**: Task description, active diffs, trimmed error snippets, and `RunRecord`.
* **Zero Prefix Jitter**: Dynamic timestamps, random UUIDs, and volatile loop counters **MUST NOT** appear in the static head or system prompt.
* **Deterministic Sorting**: File lists, CodeGraph symbols, and tool declarations MUST be sorted lexicographically (A–Z) to prevent cache invalidation caused by random array ordering.

### Pillar 6: Universal Polyglot Stack Adapter Engine
The loop automatically identifies the project stack via **Zero-Token Marker Detection** (checking file existence without reading content) and binds deterministic commands for Phase 4:

| Stack | Marker Files | Type-Check & Lint Command | Test Suite Command |
| :--- | :--- | :--- | :--- |
| **TypeScript / Node** | `package.json`, `tsconfig.json` | Lockfile runner (`npm run lint`, `npx tsc --noEmit`) | Lockfile runner (`npm test`, `pnpm test`, `bun test`) |
| **Python** | `pyproject.toml`, `requirements.txt` | `mypy . && ruff check` | `python -m pytest` |
| **Go** | `go.mod` | `go vet ./... && golangci-lint run` | `go test -v ./...` |
| **Rust** | `Cargo.toml` | `cargo clippy --all-targets --all-features -- -D warnings` | `cargo test --all-features` |
| **Java / Kotlin** | `pom.xml`, `build.gradle`, `build.gradle.kts` | Detected wrapper (`./gradlew check` / `mvn test-compile`) | Detected wrapper (`./gradlew test` / `mvn test`) |
| **C# / .NET** | `*.sln`, `*.csproj` | `dotnet build --no-restore` | `dotnet test --no-build` |
| **C / C++** | `CMakeLists.txt`, `meson.build` | `cmake --build build` / `clang-tidy` | `ctest --test-dir build --output-on-failure` |

* If multiple stacks coexist in a monorepo, adapters are executed in deterministic lexicographical order.

### Pillar 7: Global Loop & Recursion Limits
* **Internal Task Retries**:
  * `verificationRetry <= 1`: Maximum 1 code-fix retry after a `SEMANTIC_CODE` test failure. (Conditional 2nd retry rejected in production to prevent code thrashing and test-suppression gaming).
  * `qualityRemediation <= 1`: Maximum 1 remediation cycle after `REALITY_CHECK` non-critical findings.
* **Global Session Ceiling**:
  * `globalCycles <= 2`: The loop increments `globalCycles` on every re-entry into `EXECUTE`. Reaching `globalCycles > 2` causes an immediate **`FAILED: GLOBAL_CYCLE_EXHAUSTED`** hard stop.

### Pillar 8: Token Budget & Cost Circuit Breaker
* Every tool call and model response updates `tokensUsed` and `costUsd` in the `RunRecord`.
* **Hard Ceilings**:
  * `MAX_TOKENS_PER_RUN = 60,000 tokens`
  * `MAX_COST_USD = $0.50`
* **Circuit Breaker**: Conjunctive enforcement — if conservative projection indicates the next phase will exceed either limit, or if a ceiling is reached, the agent **MUST** halt immediately, preserve the `RunRecord`, and transition to `BLOCKED` (if human can approve budget expansion) or `FAILED`.

### Pillar 9: Human-in-the-Loop (HITL) Proactive Gates
The loop enforces three non-delegable human approval checkpoints:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Gate 1: SPEC_SIGN_OFF (After PLAN)                                     │
│ -> Mandatory for major architectural, cross-cutting, schema, or API    │
│    changes. Agent pauses, presents Blueprint, waits for explicit 'OK'.  │
├────────────────────────────────────────────────────────────────────────┤
│ Gate 2: DESTRUCTIVE_ACTION (Anytime before execution)                  │
│ -> Mandatory before deleting files (rm), dropping database tables,     │
│    force pushing, or altering secrets/.env. Must prompt user.          │
├────────────────────────────────────────────────────────────────────────┤
│ Gate 3: FINAL_RELEASE (After REALITY_CHECK)                            │
│ -> Reality Checker & Security Auditor submit proof. Agent waits for    │
│    human sign-off before merging worktree into main branch.            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Normative State Machine Transitions

```text
INITIALIZE    -> SPEC_GATE | FAILED
SPEC_GATE     -> ISOLATE | BLOCKED
ISOLATE       -> DETECT_STACKS | BLOCKED | FAILED
DETECT_STACKS -> PLAN | FAILED
PLAN          -> EXECUTE | BLOCKED | FAILED
EXECUTE       -> VERIFY | BLOCKED | FAILED
VERIFY        -> REALITY_CHECK | EXECUTE (if retry=0 and SEMANTIC_CODE) | BLOCKED | FAILED
REALITY_CHECK -> RELEASE_GATE | EXECUTE (if remediation=0 and non-critical) | BLOCKED | FAILED
RELEASE_GATE  -> COMPLETE | BLOCKED
```

### 4.1 Adversarial Audit & Deterministic Closure Protocol

The `REALITY_CHECK` phase operates under a strict two-stage contract:

```text
VERIFY (pass on CPU)
  -> REALITY_CHECK (audit pending)

REALITY_CHECK (audit pending)
  -> Invoke read-only audit_and_break_code_with_gpt exactly once
  -> Persist audit record (audited tree hash, invocation key, findings)
  -> RELEASE_GATE                         if audit accepted (AQI >= 4.5, 0 critical findings)
  -> EXECUTE                              if remediable findings exist and qualityRemediation == 0
  -> FAILED                               otherwise

EXECUTE (audit remediation)
  -> Apply targeted test cases and code fixes
  -> VERIFY

VERIFY (pass after audit remediation)
  -> REALITY_CHECK (audit closure)

REALITY_CHECK (audit closure)
  -> Deterministic closure checks ONLY (re-evaluate finding-linked test assertions on CPU)
  -> DO NOT call GPT again (no third model call permitted)
  -> RELEASE_GATE                         if all finding-linked assertions pass
  -> FAILED                               otherwise
```

> [!CAUTION]
> Any state transition not explicitly listed in this specification is **STRICTLY FORBIDDEN** and will trigger an immediate emergency shutdown.

---

## 5. Compact Determinism Assertions (Verbatim)

The state machine is verified against this normative assertion table:

```json
{"assertions":[{"in":"blueprint SHA mismatch","out":"FAILED:SPECIFICATION_INTEGRITY; no execution"},{"in":".eval assertion weakened","out":"Reality Checker rejects release"},{"in":"port lock then semantic failure","out":"verificationRetry=1; infra attempt excluded"},{"in":"tokensUsed=60001","out":"BLOCKED_OR_FAILED; stop immediately"},{"in":"globalCycles=3","out":"FAILED; no remediation"},{"in":"audit rejects verified tree","out":"EXECUTE->VERIFY->REALITY_CHECK closure"},{"in":"failures 3->1; test inventory unchanged","out":"shadow eligible; no Retry 2"},{"in":"elapsed=2400s","out":"cancel tree, clean resources, terminal timeout"}]}
```
