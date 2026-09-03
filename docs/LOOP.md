# Enterprise-Grade Autonomous Agent Loop Specification (LOOP.md)

**Version:** 2.0.0  
**Status:** Canonical & Mandatory  
**Applies To:** All autonomous and semi-autonomous coding workflows across all languages in this repository.

---

## 1. Purpose and Scope

This document specifies the normative **Enterprise-Grade Autonomous Agent Loop Architecture (v2.0)** governing all repository-modifying tasks in this project. The loop enforces strict separation of concerns across four key operational dimensions:

1. **Model Reasoning & Synthesis**: Layered intelligence combining high-level architecture planning (Layer 1 GPT Architect) with native code generation (Layer 2 Gemini 3.8 Flash).
2. **Deterministic Local Execution**: Execution of compilers, linters, and test suites directly on the host CPU at **$0 model token cost**.
3. **Adversarial Review & Quality Gates**: Independent, skeptical verification of code quality, security vulnerabilities, anti-gaming diffs, and deployment readiness.
4. **Durable Knowledge Compounding**: Incremental, persistent recording of decisions, test evidence, and lessons learned into the repository's living wiki (`wiki/`).

> [!IMPORTANT]
> All repository-changing agents **MUST** strictly follow this loop. Repository-specific instructions override generic defaults only when explicitly documented and non-conflicting with security and verification invariants.

---

## 2. Canonical Constants, Enumerations & Symbols

### 2.1 Hard Execution Constants

```text
ERROR_EXCERPT_MAX_LINES = 30
ERROR_EXCERPT_MIN_TARGET_LINES = 20
MAX_COST_USD = 0.50
MAX_GLOBAL_CYCLES = 5
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
  costUsd: number;               // Estimated cumulative USD cost
  errorClass: ErrorClass | null; // Classification of most recent failure
  evidence: string;              // Trimmed diagnostics (<= 30 lines) and diff summary
  gateStatus: Record<Gate, GateStatus>;
  globalCycles: number;          // Total outer loop cycles (<= 5)
  hypothesis: string | null;     // Root-cause hypothesis required before semantic retry
  phase: Phase;                  // Current phase
  qualityRemediation: number;    // Count of remediation cycles (<= 1)
  terminalReason: string | null; // Explanation if BLOCKED or FAILED
  tokensUsed: number;            // Total cumulative token count (<= 60,000)
  verificationRetry: number;     // Count of code verification retries (<= 1)
}
```

---

## 3. The Nine Operational Pillars

### Pillar 1: Execution Isolation & Sandbox Policy
* **Docker-First Execution Mandate**: Whenever the container `kins_autonomous_sandbox` is active, all shell operations (installing packages, building, running tests, executing scripts) **MUST 100% RUN INSIDE THE CONTAINER** via `docker exec kins_autonomous_sandbox <command>`. Host-level execution of arbitrary packages is strictly forbidden.
* **Git Worktree Sandbox (`using-git-worktrees`)**: All non-trivial tasks (touching multiple files, dependencies, database migrations, or executing test suites) **MUST** execute inside an isolated Git worktree (`.worktrees/<task-id>`). The `main` branch remains untouched until final approval.
* **Terminal Sandbox**: Shell execution MUST be confined to the active workspace directory, adhere to least privilege, and forbid host-wide modifications outside the repository.
* **Containerized Execution (Docker)**: Unattended autonomous tasks (`/goal`, overnight loops), untrusted external code, and third-party build scripts **MUST** execute within an isolated Docker container.
* **Failure to Isolate**: If worktree or container sandbox cannot be initialized, the loop **MUST** transition immediately to `BLOCKED`.

### Pillar 2: Anti-Tampering & Anti-Specification-Gaming Safeguards
* **SHA-256 Checksum Lock**: Layer 1 generates an immutable SHA-256 checksum over the Technical Blueprint and Golden Test Assertions.
* **Protected Evaluation Zone (`.eval/`)**: All golden assertions, benchmark suites, and validation contracts stored in `.eval/` are **READ-ONLY** for Layer 2.
* **Anti-Weakening Diff Audit**: Before release approval, `agency-reality-checker` audits `git diff` against test files:
  * Any deleted test assertions, broadened exception catches, weakened comparison operators (e.g. `==` changed to `>=`), commented-out tests, or modified `.eval/` files trigger an immediate **`FAILED: SPECIFICATION_INTEGRITY`** hard stop.
  * Layer 2 **MUST NOT** recalculate or update checksums to match modified tests.

### Pillar 3: Context Pruning & Compaction Protocol
* **Smart Error Trimming**: Terminal outputs from failed compilers or test runners MUST be trimmed to a high-signal window of **20–30 lines** (max 30 lines) capturing only the failing command, assertion failure, line number, and immediate stack frame. Repetitive runtime noise and successful suite outputs MUST be stripped.
* **Diff-First Verification**: After code edits, Layer 2 MUST inspect changes using `git diff -U3 -- <files>`. Re-reading entire source files (e.g. 500+ lines) after minor edits is **STRICTLY PROHIBITED**.
* **Phase-Boundary Compaction**: When moving between phases, all scratch thoughts, intermediate tool outputs, and raw traces are dropped. Only the compact `RunRecord` JSON is propagated.

### Pillar 4: Error Triage & Systematic Debugging
When a command fails in `VERIFY`, the error MUST be classified before any action is taken:

| Error Class | Example Causes | Retry Accounting | Required Action |
| :--- | :--- | :---: | :--- |
| **`ENVIRONMENT_INFRA`** | Port in use, file lock, network timeout, missing OS tool, permission denied. | **0 code retries burned** (Consumes cycle/token budget only). | Remediate environment (e.g. kill process, unlock file) or transition to `BLOCKED`. |
| **`SEMANTIC_CODE`** | Type error, assertion failure, compilation error, runtime exception. | **Increments `verificationRetry` (+1).** Max 1 retry allowed. | **Systematic Debugging:** Must record a falsifiable `hypothesis` based on stack trace before modifying code. |
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
  * `verificationRetry <= 1`: Maximum 1 code-fix retry after a `SEMANTIC_CODE` test failure.
  * `qualityRemediation <= 1`: Maximum 1 remediation cycle after `REALITY_CHECK` non-critical findings.
* **Global Session Ceiling**:
  * `globalCycles <= 5`: The loop increments `globalCycles` on every re-entry into `EXECUTE`. Reaching `globalCycles > 5` causes an immediate **`FAILED: GLOBAL_CYCLE_EXHAUSTED`** hard stop.

### Pillar 8: Token Budget & Cost Circuit Breaker
* Every tool call and model response updates `tokensUsed` and `costUsd` in the `RunRecord`.
* **Hard Ceilings**:
  * `MAX_TOKENS_PER_RUN = 60,000 tokens`
  * `MAX_COST_USD = $0.50`
* **Circuit Breaker**: If conservative projection indicates the next phase will exceed either limit, or if a ceiling is reached, the agent **MUST** halt immediately, preserve the `RunRecord`, and transition to `BLOCKED` (if human can approve budget expansion) or `FAILED`.

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

> [!CAUTION]
> Any state transition not explicitly listed in this specification is **STRICTLY FORBIDDEN** and will trigger an immediate emergency shutdown.

---

## 5. Compact Determinism Assertions (Verbatim)

The state machine is verified against this normative assertion table:

```json
{"assertions":[{"in":"blueprint SHA mismatch","out":"FAILED:SPECIFICATION_INTEGRITY; no execution"},{"in":".eval assertion weakened","out":"Reality Checker rejects release"},{"in":"port lock then semantic failure","out":"verificationRetry=1; infra attempt excluded"},{"in":"tokensUsed=60001","out":"BLOCKED_OR_FAILED; stop immediately"},{"in":"globalCycles=6","out":"FAILED; no remediation"}]}
```
