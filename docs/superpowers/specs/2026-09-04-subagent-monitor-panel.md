# Specification: Subagent Monitor & Activity Panel in Kins Cockpit

**Date:** 2026-09-04  
**Status:** Approved (SPEC_GATE)  
**Target:** `kins-multiagents-ui`  

---

## 1. Overview & Objective
Provide real-time visibility into autonomous subagents spawned during CLI or multi-agent workflows (`invoke_subagent`, `/teamwork-preview`, parallel dispatching, agency squads). Users can see live subagents running concurrently, their roles, models, run states, elapsed durations, and task prompts directly within the Kins Cockpit desktop application.

---

## 2. Architectural Design

### 2.1 Backend Authority (`SubagentService.ts`)
A dedicated service in the main process (`src/main/services/SubagentService.ts`):
- Ingests subagent events:
  - `invoke_subagent` calls containing `Subagents: [{ TypeName, Role, Prompt, Model, Workspace }]`.
  - Subagent lifecycle updates: start (`running`), idle, message exchanges (`send_message`), completion/exit, errors.
  - Integration with `TranscriptIngestionService.ts`: captures tool calls (`invoke_subagent`, `manage_subagents`) and subagent transcript entries.
- Maintains live state:
  ```ts
  export interface SubagentInfo {
    readonly id: string;
    readonly conversationId?: string;
    readonly role: string;
    readonly typeName: string;
    readonly model: string;
    readonly status: "running" | "idle" | "completed" | "error";
    readonly promptSummary: string;
    readonly startedAt: number;
    readonly completedAt?: number;
    readonly lastMessage?: string;
    readonly error?: string;
  }

  export interface SubagentSnapshot {
    readonly activeCount: number;
    readonly subagents: readonly SubagentInfo[];
    readonly lastUpdated: number;
  }
  ```
- Re-points cleanly when switching projects via `ProjectService`.

### 2.2 IPC & Preload Bridge (`window.cockpitApi.subagents`)
- **IPC Channels**:
  - `subagents:get-snapshot`: Returns the current `SubagentSnapshot`.
  - `subagents:snapshot`: Broadcasts real-time snapshot updates to renderer.
- **Preload API (`CockpitApi.subagents`)**:
  - `getSnapshot(): Promise<SubagentSnapshot>`
  - `onSnapshot(listener: (snapshot: SubagentSnapshot) => void): Unsubscribe`

### 2.3 Frontend UI (`SubagentSidebar.tsx` / Tab in Right Sidebar)
- Right sidebar navigation tabs: `[ MCP Servers ]` and `[ Subagents (N) ]` with an active pulsing indicator when subagents are running.
- In `Subagents` tab:
  - Header: Active subagents count and filter (All / Active / Completed).
  - Subagent Cards:
    - Role badge with icon (`Bot`, `BrainCircuit`).
    - Model badge (`flash`, `inherit`, `pro`).
    - Live status badge (`RUNNING` pulsing emerald, `COMPLETED` blue, `ERROR` rose, `IDLE` zinc).
    - Live elapsed duration timer.
    - Truncated prompt/task summary.
    - Click to open Subagent Detail modal with full prompt, conversation ID, and recent activity.
  - Empty state with guidance on how to trigger subagents (`/teamwork-preview`, `dispatching-parallel-agents`).

---

## 3. Compact Test Assertion Table

| Input | Expected Output |
| :--- | :--- |
| `invoke_subagent` with 2 subagents (`Role: "Tester"`, `Role: "Reviewer"`) | Snapshot has `activeCount: 2`, 2 entries with `status: "running"` |
| Duplicate step replay from transcript | Idempotent; does not duplicate subagent records |
| Subagent completion / finish message | State transitions from `running` to `completed`; `activeCount` decrements |
| Project switch / loop reset | Subagents state resets or re-anchors to project without orphaned state |
| Subagent error / failure signal | State transitions to `error` with error text captured |
