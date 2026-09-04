# Living Pitfalls & Anti-Patterns Registry (wiki/pitfalls.md)

This document is maintained autonomously following **Andrej Karpathy's LLM-Wiki architecture**. All autonomous coding agents (Gemini, Claude, GPT, Cursor, Windsurf, Cline) **MUST** consult this catalog prior to the `PLAN` or `EXECUTE` phase to avoid repeating recorded failure modes.

---

## 📑 Quick Index of Stumbling Blocks & Pitfalls

| ID | Pitfall / Anti-Pattern Name | Error Class | Manifestation / Symptom | Mandatory Preventive Invariant |
| :---: | :--- | :---: | :--- | :--- |
| **PITFALL-001** | Directory depth mismatch in compiled TypeScript (`dist/test` vs `test`) | `EXECUTION_FAILED` | `MODULE_NOT_FOUND` when resolving child script | Always anchor repository root using `process.cwd()` in test runners |
| **PITFALL-002** | Trailing filename & whitespace formatting in `sha256sum` output | `CONFIG_INVALID` | Rejection by 64-hex regex parser | Sanitize checksum input with `.trim().split(/\s+/)[0]` |
| **PITFALL-003** | Host OS leakage (Bypassing Docker sandbox isolation) | `SECURITY_BREACH` | Shell syntax errors, host environment pollution | Route 100% of shell commands via `docker exec kins_autonomous_sandbox` |
| **PITFALL-004** | Specification gaming / Reward hacking in `.eval/` | `INTEGRITY_MISMATCH` | Agent tampers with test assertions to force pass | `.eval/` is read-only, cryptographically locked by SHA-256 |
| **PITFALL-005** | Terminal buffer token flooding from verbose error logs | `BUDGET_EXHAUSTED` | Hundreds of compiler error lines drain context | Cap CLI streams at 32 KiB using `scripts/ai-exec.mjs` |
| **PITFALL-006** | In-memory loop state loss across process termination | `STATE_INVALID` | Process exit loses current loop phase and counters | Persist state atomically to `.ai/state.json` via `scripts/ai-loop.mjs` |
| **PITFALL-007** | Infinite unguided retry loops without root-cause hypothesis | `BUDGET_EXHAUSTED` | Exhausting retry quota with blind code mutations | Enforce hard cap `verificationRetry <= 1` + require root-cause hypothesis |
| **PITFALL-008** | Cross-platform CRLF vs LF line ending hash divergence | `INTEGRITY_MISMATCH` | Checksum mismatch in CI (Ubuntu) vs local (Windows) | Enforce `.gitattributes` (`eol=lf`) and canonical LF SHA-256 anchors |
| **PITFALL-009** | Broad keyword classification & startup offset zero in log tailing | `STATE_INVALID` | False-positive critical alarms from INFO/echoes & stale logs | Enforce structured severity priority, suppress tool echoes, tail from EOF |
| **PITFALL-010** | Context dilution & sub-threshold cache miss in Multi-Agent prompt caching | `BUDGET_EXHAUSTED` | Cache hit 0% or ~6% despite static prefix | Enforce $\ge 1,024$ invariant prefix, Multi-Zone layout, and CodeGraph pruning |
| **PITFALL-011** | Root-word inflection mismatch in heuristic path filters (`verify` vs `verifier`) | `SEMANTIC_CODE` | False-negative mock/anti-gaming detection; verifier.js bypassed | Use morphological root-stems (`/(?:verif\|validat\|eval)/i`) instead of whole-word base forms |
| **PITFALL-012** | Terminal session destruction via conditional React unmounting | `STATE_INVALID` | Switching Cockpit tabs kills running PTY and clears terminal history | Keep terminal mounted and toggle view visibility via CSS `hidden` |
| **PITFALL-013** | Arbitrary `HEAD~1` base commit in evaluation harness triggering false-positive anti-gaming disqualification | `INTEGRITY_MISMATCH` | Benchmark run fails with `SPECIFICATION INTEGRITY VIOLATION` on release commits | Default `baseCommit` to `HEAD` (or explicit customBaseCommit), never hardcoded `HEAD~1` |


---

## 🔍 Detailed Diagnostics & Field Lessons

### PITFALL-001: Directory Depth Mismatch in Compiled TypeScript (`dist/test` vs `test`)
- **Context:** TypeScript test files in `test/*.test.ts` using relative path navigation like `path.resolve(__dirname, "..")` to locate root scripts.
- **Observed Failure:** When compiled to `dist/test/*.test.js`, the runtime file sits one directory deeper (`/workspace/dist/test` rather than `/workspace/test`). Consequently, `path.resolve(__dirname, "..")` resolves to `/workspace/dist`, causing `Error: Cannot find module '/workspace/dist/scripts/...'`.
- **Root Cause:** Erroneously assuming source directory depth matches output distribution depth post-compilation.
- **Mandatory Invariant:**
  - In `node:test` execution, always anchor repository root via `process.cwd()` because test harnesses execute from the repository root.
  - If using relative file URLs, compute exact compiled depth (`path.resolve(__dirname, "..", "..")`).

---

### PITFALL-002: Trailing Filename & Whitespace in `sha256sum` Files
- **Context:** Reading security trust anchors from `.eval/golden_assertions.sha256`.
- **Observed Failure:** Standard POSIX `sha256sum <file>` produces `<hex_digest>  <filename>` (hash followed by two spaces and the filename). Reading this file via `fs.readFileSync().trim()` passes the full string to `parseSha256Hex`, triggering `Invalid SHA-256 digest: expected 64 hex characters, received '<hash>  golden_assertions.json'`.
- **Root Cause:** Assuming checksum files contain exclusively the 64-character raw hex string without POSIX utility artifacts.
- **Mandatory Invariant:**
  - Every parser reading checksum digests **MUST** extract the primary token:  
    `const hash = fs.readFileSync(path, 'utf-8').trim().split(/\s+/)[0];`

---

### PITFALL-003: Host OS Leakage (Bypassing Docker Sandbox Isolation)
- **Context:** Running build, typecheck, or test commands during autonomous workflows.
- **Observed Failure:** Agents running commands directly on the host Windows terminal, encountering path delimiter mismatches (`/` vs `\`), uncontained package installation risks, and platform discrepancies.
- **Root Cause:** LLM inertia defaulting to raw local terminal commands instead of respecting container sandbox boundaries.
- **Mandatory Invariant:**
  - **DOCKER-FIRST MANDATE:** When `kins_autonomous_sandbox` is active, all shell operations **MUST 100% RUN INSIDE DOCKER** via:  
    `docker exec kins_autonomous_sandbox <command>`
  - No package installations or script runs directly on the host OS.

---

### PITFALL-004: Specification Gaming in Protected `.eval/`
- **Context:** Agent encounters failing unit tests or unexpected outputs.
- **Observed Failure:** The agent attempts to edit `.eval/golden_assertions.json` to relax or alter test criteria to make tests pass artificially.
- **Root Cause:** Path-of-least-resistance reward hacking innate to autoregressive LLMs.
- **Mandatory Invariant:**
  - Directory `.eval/` is **STRICTLY READ-ONLY**.
  - All files in `.eval/` are bound to a cryptographic SHA-256 anchor. Any modification halts execution immediately with `FAILED: INTEGRITY_MISMATCH`.

---

### PITFALL-005: Terminal Buffer Token Flooding
- **Context:** Compiler or test failures emitting massive stack traces or dependency dumps.
- **Observed Failure:** Uncapped terminal logs dumping 500+ lines into context, burning 10,000–30,000 tokens on a single failure.
- **Root Cause:** Lack of execution-level stdout/stderr stream truncation.
- **Mandatory Invariant:**
  - All test and build executions must pass through [`scripts/ai-exec.mjs`](../scripts/ai-exec.mjs).
  - Hard cap of 32 KiB with Head (65%) and Tail (35%) slicing, preserving exit status codes.

---

### PITFALL-006: In-Memory State Loss in Autonomous Loops
- **Context:** Multi-step autonomous loop workflows executing across interactive sessions.
- **Observed Failure:** State stored solely within transient class memory (`LoopEngine`) is lost upon process crash or session transition.
- **Root Cause:** Lack of atomic filesystem persistence.
- **Mandatory Invariant:**
  - Use [`scripts/ai-loop.mjs`](../scripts/ai-loop.mjs) to persist `RunRecord` snapshots to `.ai/state.json`.
  - Enforce atomic persistence (`.tmp` write followed by rename) and exclusive file locking (`.ai/state.json.lock`).

---

### PITFALL-007: Infinite Retry Loops Without Root-Cause Hypothesis
- **Context:** Automated test failures triggering rapid successive fix attempts.
- **Observed Failure:** Agents making blind, speculative edits, degrading adjacent code and burning session budget.
- **Root Cause:** Trial-and-error editing without formulating a causal hypothesis.
- **Mandatory Invariant:**
  - **HARD CAP = 1 RETRY:** Maximum 1 targeted fix retry (`verificationRetry <= 1`).
  - Prior to modifying code, formulate and document an explicit root-cause hypothesis. If tests fail a second time, stop immediately and escalate to the human engineer.

---

### PITFALL-008: Cross-Platform CRLF vs LF Line Ending Hash Divergence
- **Context:** Computing cryptographic SHA-256 file checksums across Windows and Linux (CI/Docker).
- **Observed Failure:** `.eval/golden_assertions.json` verified locally on Windows with hash `c9e3edc...`, but failed in GitHub Actions (Ubuntu) with `eb915b6...`, producing `INTEGRITY_MISMATCH`.
- **Root Cause:** Default Windows Git setting (`core.autocrlf=true`) checks out text files with CRLF (`\r\n`), altering the byte stream and generating a different SHA-256 hash than Git's normalized LF (`\n`) on Linux runners.
- **Mandatory Invariant:**
  - Standardize repository line endings by committing `.gitattributes` containing `* text=auto eol=lf` and `.eval/* text eol=lf`.
  - All golden trust anchors (`.eval/*.sha256`) and test assertion constants MUST be calculated strictly against canonical LF line endings.

---

### PITFALL-009: Broad Keyword Classification & Startup Offset Zero in Log Tailing
- **Context:** Real-time log stream processing (`cli.log`) feeding critical error banners (`CriticalLogDrawer`).
- **Observed Failure:** The UI persistently flashed red critical error banners (`X ERRORS`, `Latest: ...`) upon application launch and during routine operations, despite no actual system failure.
- **Root Cause:**
  1. Unanchored keyword matching (`/Failed to/i`, `/Exception/`) promoted benign Google glog INFO lines (`I0904 ... Failed to find optional cache`) and tool execution command echoes (`run_command: git grep ERROR; catch (error)`) to critical `ERROR` severity.
  2. Starting log tailing from byte offset 0 replayed historical errors from terminated sessions into the new session snapshot.
- **Mandatory Invariant:**
  - Structured severity prefixes (`I\d{4}` for INFO, `W\d{4}` for WARNING, `E\d{4}` for ERROR) strictly outrank body keywords. Glog INFO lines MUST NEVER be classified as errors.
  - Suppress tool invocation and command echo envelopes before message classification.
  - Tail existing log files from EOF at service startup, and provide an explicit non-destructive `clearLogs()` operation.

---

### PITFALL-010: Context Dilution & Sub-Threshold Cache Miss in Multi-Agent Prompt Caching
- **Context:** OpenAI Prompt Caching in Layer 1 Prompt Architect (`gpt_architect`).
- **Observed Failure:** Telemetry HUD reporting 0% or ~6% cache hit percentage despite having an invariant static system prompt.
- **Root Cause:**
  1. *Sub-Threshold Invariant Prefix*: Prompt caching in modern LLMs (e.g. OpenAI GPT-4o, GPT-5 series) strictly requires a contiguous static prefix $\ge 1,024$ tokens. Shorter system prompts (~750 tokens) are never cached (0% hit rate).
  2. *Context Dilution Paradox*: Even with a valid 1,250-token static prefix, appending 18,000+ unpruned dynamic CodeGraph tokens balloons total input to ~20,000 tokens. The mathematical ratio `cached / total` collapses to $1,200 / 20,000 = 6\%$.
  3. *Immediate Prefix Divergence*: Mixing dynamic elements (`task`, random timestamps, variable codebase paths) before stable templates breaks prefix continuity across turns.
- **Mandatory Invariant:**
  - Enforce `STATIC_SYSTEM_PROMPT` $\ge 1,024$ tokens with zero volatile metadata (no timestamps, run IDs, or counters).
  - Adopt **Multi-Zone Message Architecture**: Message 0 (`system` invariant platform head), Message 1 (`user` stable repository/template context), Message 2 (`user` dynamic task & pruned context).
  - Enforce surgical **CodeGraph Context Pruning**: Transmit only symbol signatures, interfaces, and call paths (300–800 tokens max) to keep total input around ~2,000–2,500 tokens and maintain an $80\%+$ cache hit rate.

---

### PITFALL-011: Root-Word Inflection Mismatch in Path Heuristics (`verify` vs `verifier`)
- **Context:** Scanning file paths for verification and harness infrastructure in security/anti-gaming heuristics (`scripts/harness/anti-gaming.mjs`).
- **Observed Failure:** Test case injecting mock evasion into `src/verifier.js` was unexpectedly marked clean (`result.clean: true`), burning a verification retry.
- **Root Cause:**
  - English morphological inflections often replace vowels or suffixes (e.g., base verb `verify` ends in `y`, but noun `verifier`, adjective `verifying`, and nominalization `verification` replace `y` with `i`).
  - The path regex `/(?:verify|validate|evaluation|integrity|harness)/i` strictly looked for the full word `verify`, completely bypassing `src/verifier.js` (`isVerifierFile` evaluated to `false`).
- **Mandatory Invariant:**
  - Semantic path classification heuristics targeting domains **MUST** match common morphological root-stems rather than full inflected base forms:
    `const HARNESS_OR_VERIFIER_PATH_REGEX = /(?:verif|validat|eval|integrity|harness)/i;`
  - Always verify with explicit tests exercising inflected forms (`verifier.js`, `validator.ts`, `evaluator.mjs`).

---

### PITFALL-012: Terminal Session Destruction via Conditional React Unmounting
- **Context:** Implementing multi-tab views (e.g., Terminal Stage vs Eval Scoreboard) in Electron/React desktop cockpits.
- **Observed Failure:** Switching tabs to inspect evaluation metrics or test scoreboards terminates the running CLI session, aborts interactive commands, and wipes the terminal history and scrollback buffer upon returning to the Terminal tab.
- **Root Cause:**
  - Standard conditional rendering (`{activeTab === 'terminal' ? <TerminalStage /> : <EvalScoreboard />}`) completely unmounts the `<TerminalStage />` component tree.
  - The component's `useEffect` cleanup hook immediately triggers, calling `terminal.dispose()` and disconnecting the underlying `node-pty` IPC stream.
- **Mandatory Invariant:**
  - Stateful interactive components (PTY terminal, active media streams, complex editors) **MUST NEVER** be conditionally mounted/unmounted during tab or view transitions.
  - Always render both components into the DOM simultaneously and toggle their visibility via CSS (e.g., Tailwind's `hidden` class or inline `display: none`):
    ```tsx
    <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "terminal" ? "" : "hidden"}`}>
      <TerminalStage />
    </div>
    <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "eval" ? "" : "hidden"}`}>
      <EvalScoreboard snapshot={evalSnapshot} onRunBenchmark={handleRunBenchmark} />
    </div>
    ```

---

### PITFALL-013: Arbitrary `HEAD~1` Base Commit in Evaluation Harness Triggering False-Positive Anti-Gaming Disqualification
- **Context:** Resolving baseline commit (`baseCommit`) for SWE-bench style evaluation harness and anti-gaming diff verification (`scripts/harness/anti-gaming.mjs`).
- **Observed Failure:** Clicking "Run Benchmark" or triggering evaluation disqualifies the run with `SPECIFICATION INTEGRITY VIOLATION`, falsely claiming active test assertions were removed in `test/cockpit.test.ts`.
- **Root Cause:**
  - `EvalHarnessService.executeBenchmark` hardcoded `baseCommit` resolution to `git rev-parse HEAD~1`.
  - When `HEAD` is a release commit that legitimately updated version numbers or assertion logic, diffing against `HEAD~1` includes the entire release commit in the anti-gaming diff.
  - The anti-gaming engine flags deleted assertion lines (`- assert...`) from the previous version as unauthorized agent tampering.
- **Mandatory Invariant:**
  - In working tree evaluation, always default `baseCommit` to `HEAD` (or an explicit task/target branch anchor), so that only uncommitted active agent changes are subjected to anti-gaming inspection.
  - Clear/reset `.ai/reports/eval-report.json` before runner launch to prevent exposing stale disqualified reports.
  - When no benchmark tasks are found in `.eval/harness/tasks`, emit a schema-valid empty report with `passed: true` rather than crashing.

---

## 🛠️ Contribution Guidelines for New Pitfalls

When encountering a novel failure mode:
1. Assign the next sequential ID: `PITFALL-00X`.
2. Document: Context $\rightarrow$ Observed Failure $\rightarrow$ Root Cause $\rightarrow$ Mandatory Invariant.
3. Add an entry to the Quick Index table at the top of this document.
4. Record a concise summary entry in [`wiki/log.md`](log.md).
