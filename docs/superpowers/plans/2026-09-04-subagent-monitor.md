# Subagent Activity & Monitoring Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:implementer-prompt.md to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Subagent Activity & Monitoring Panel in Kins Cockpit (Electron + React) allowing live observation of spawned subagents, their roles, models, run states, elapsed durations, and task summaries.

**Architecture:** A main-process `SubagentService` maintains the single source of truth for subagents. Ingests events from `TranscriptIngestionService` (correlating `invoke_subagent` and lifecycle states). Exposes `CockpitApi.subagents` via IPC and Preload to a clean Tailwind/Lucide React sidebar tab with live badges and timers.

**Tech Stack:** Electron 34, React 19, TypeScript 5.7, TailwindCSS 3.4, Lucide-react 1.16, Node 22 (`node:test`, `node:assert/strict`).

## Global Constraints
- One-way data flow: Transcript -> Ingestion -> SubagentService -> IPC -> Preload -> React.
- Deterministic and idempotent replay of transcript steps.
- Immutable state snapshots returned across IPC.
- Zero tampering with `.eval/` assertions.
- Minimal, surgical changes adhering to Karpathy Simplicity First invariant.

---

### Task 1: Update Shared Contracts (`src/shared/contracts.ts`)
- Add `SubagentStatus`, `SubagentActivity`, `SubagentInvocationInput`, `SubagentStatusUpdate`, `SUBAGENT_IPC_CHANNELS`.
- Extend `CockpitApi` with:
  ```ts
  readonly subagents: {
    readonly getSubagents: () => Promise<SubagentActivity[]>;
    readonly onSubagentsChanged: (listener: (activities: SubagentActivity[]) => void) => Unsubscribe;
  };
  ```

### Task 2: Implement `SubagentService.ts` (`src/main/services/SubagentService.ts`)
- Implement `SubagentService` with injectable clock `now?: () => number`.
- Methods: `recordInvocation`, `updateStatus`, `list`, `subscribe`, `reset`.
- Idempotency on duplicate IDs, terminal state protection (`completed` / `error` cannot regress).
- Elapsed time calculation from `startedAt` to `completedAt ?? now()`.

### Task 3: Unit Tests for `SubagentService` (`test/subagents.test.ts`)
- Test compact assertions table:
  1. `invoke id=a role=planner model=m prompt='  plan   task  ' @1000` -> one running record, summary='plan task', elapsed=0.
  2. `id=a idle@2000, completed@5000, running@6000` -> completed, elapsed=4000, no regression.
  3. Replay invoke id=a twice -> one record, original startedAt retained.
  4. `invoke id=b then failed result 'timeout'` -> error, errorMessage='timeout', duration frozen.
  5. Unrelated or ID-less event -> no activity and no notification.

### Task 4: Integrate with `TranscriptIngestionService.ts`
- Pass `SubagentService` dependency to `TranscriptIngestionService`.
- Extract `invoke_subagent` tool calls: extract ID, role, model, prompt.
- Handle tool results: mark completed or error.
- Ensure replay idempotency.

### Task 5: Wire IPC (`src/main/ipc.ts`) and Preload Bridge (`src/preload/index.ts`)
- Register `subagents:list` handle and subscribe to `SubagentService` broadcasting on `subagents:changed`.
- Extend preload `window.cockpitApi.subagents`.

### Task 6: Implement Frontend UI Component (`SubagentSidebar.tsx`) and Integrate with `App.tsx`
- Build `src/renderer/components/SubagentSidebar.tsx` with role, model, prompt summary, status badges, and single timer hook.
- Update `src/renderer/App.tsx` right sidebar with tabs `[ MCP Servers ]` and `[ Subagents (N) ]` (showing active subagents count badge).
- Clean subscription on mount/unmount.

### Task 7: Full Verification Suite
- Run `npm run typecheck`, `npm test`, `npm run build`.
