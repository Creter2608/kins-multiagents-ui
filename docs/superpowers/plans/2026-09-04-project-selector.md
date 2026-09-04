# Project Selector & Active Project Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an active project indicator and dropdown switcher in Kins Cockpit (Electron + React) allowing seamless in-place workspace switching.

**Architecture:** A main-process `ProjectService` orchestrates project persistence (`userData/recent-projects.json`) and dynamic re-pointing of project-scoped services (`PtyService`, `LoopStateService`, `McpMonitorService`, `RollbackService`). Exposes `CockpitApi.project` via IPC and Preload to a clean Tailwind/Lucide React header component.

**Tech Stack:** Electron 34, React 19, TypeScript 5.7, TailwindCSS 3.4, Lucide-react 1.16, node-pty 1.1, Node 22 (`node:test`, `node:assert/strict`).

## Global Constraints
- In-place switching without reloading the Electron window.
- Services re-pointed in deterministic order: PTY -> LoopState -> McpMonitor -> Rollback.
- Strict path validation: only existing directories allowed.
- Zero tampering with `.eval/` assertions.
- Minimal, surgical changes adhering to Karpathy Simplicity First invariant.

---

### Task 1: Update Shared Contracts (`src/shared/contracts.ts`)

**Files:**
- Modify: `src/shared/contracts.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectInfo {
    readonly name: string;
    readonly path: string;
  }

  export interface ProjectState {
    readonly currentProject: ProjectInfo;
    readonly recentProjects: readonly ProjectInfo[];
  }
  ```
  and updates `CockpitApi` to include:
  ```ts
  readonly project: {
    readonly getState: () => Promise<ProjectState>;
    readonly switchProject: (projectPath: string) => Promise<ProjectState>;
    readonly openProjectFolder: () => Promise<ProjectState | null>;
  };
  ```

- [ ] **Step 1: Add `ProjectInfo`, `ProjectState`, and update `CockpitApi` in `src/shared/contracts.ts`**
- [ ] **Step 2: Verify type definitions compile without errors**

---

### Task 2: Add `setProjectRoot` to Existing Backend Services

**Files:**
- Modify: `src/main/services/PtyService.ts`
- Modify: `src/main/services/LoopStateService.ts`
- Modify: `src/main/services/McpMonitorService.ts`
- Modify: `src/main/services/RollbackService.ts`

**Interfaces:**
- Produces:
  - `PtyService.prototype.setProjectRoot(projectPath: string): Promise<void>`
  - `LoopStateService.prototype.setProjectRoot(projectPath: string): Promise<void>`
  - `McpMonitorService.prototype.setProjectRoot(projectPath: string): Promise<void>`
  - `RollbackService.prototype.setProjectRoot(projectPath: string): Promise<void>`

- [ ] **Step 1: Implement `setProjectRoot` in `PtyService.ts`** (terminates current pty process and restarts with new cwd).
- [ ] **Step 2: Implement `setProjectRoot` in `LoopStateService.ts`** (updates `stateFilePath` to `<newPath>/.ai/state.json`, resets watcher, re-reads state, and notifies listeners).
- [ ] **Step 3: Implement `setProjectRoot` in `McpMonitorService.ts`** (updates `projectRoot` and reloads MCP configs).
- [ ] **Step 4: Implement `setProjectRoot` in `RollbackService.ts`** (updates `projectRoot`).

---

### Task 3: Implement `ProjectService` & Unit Tests

**Files:**
- Create: `src/main/services/ProjectService.ts`
- Create: `test/project-service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectScopedServices {
    readonly ptyService: { setProjectRoot(p: string): Promise<void> };
    readonly loopStateService: { setProjectRoot(p: string): Promise<void> };
    readonly mcpMonitorService: { setProjectRoot(p: string): Promise<void> };
    readonly rollbackService: { setProjectRoot(p: string): Promise<void> };
  }

  export class ProjectService {
    constructor(configFilePath: string, defaultProjectPath: string, services: ProjectScopedServices);
    initialize(): Promise<ProjectState>;
    getState(): ProjectState;
    switchProject(projectPath: string): Promise<ProjectState>;
  }
  ```

- [ ] **Step 1: Write test cases in `test/project-service.test.ts` verifying all 5 assertions:**
  1. Missing config -> defaults to initial root, places it first in recents, re-points services, persists state.
  2. Switch `/tmp/a` -> `/tmp/b` -> updates current, recents `[/tmp/b, /tmp/a]`, calls all services, persists state.
  3. Switch back to `/tmp/a` -> recents `[/tmp/a, /tmp/b]` without duplicates.
  4. Malformed config JSON -> falls back gracefully to default root.
  5. Nonexistent path -> throws error, does not mutate state or call services.
- [ ] **Step 2: Implement `src/main/services/ProjectService.ts`**
- [ ] **Step 3: Run `test/project-service.test.ts` to verify all tests pass**

---

### Task 4: Register IPC Handlers, Preload Bridge, and Main App Wiring

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces:
  - IPC channels: `project:get-state`, `project:switch`, `project:open-folder`
  - Context bridge: `window.cockpitApi.project`
  - Main composition root instantiates and initializes `ProjectService`.

- [ ] **Step 1: Update `ServiceContainer` and `registerIpcHandlers` in `src/main/ipc.ts`** (include `dialog.showOpenDialog` for `project:open-folder`).
- [ ] **Step 2: Update `src/preload/index.ts`** to expose `cockpitApi.project`.
- [ ] **Step 3: Update `src/main/index.ts`** to instantiate `ProjectService`, await `initialize()`, and pass to `registerIpcHandlers`.

---

### Task 5: Frontend UI Component (`ProjectSelector.tsx` & `App.tsx`)

**Files:**
- Create: `src/renderer/components/ProjectSelector.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Produces:
  - `<ProjectSelector />` component placed in top header bar.
  - Interactive dropdown showing active project name, path tooltip, chevron indicator, recent projects list, and "Open Project Folder..." button.

- [ ] **Step 1: Create `src/renderer/components/ProjectSelector.tsx`** with accessible dropdown, click-outside listener, and loading state.
- [ ] **Step 2: Integrate `ProjectSelector` into header in `src/renderer/App.tsx`**

---

### Task 6: Deterministic Local Verification

- [ ] **Step 1: Run TypeScript compiler (`npm run build:node && npm run build:ui` or `tsc --noEmit`)**
- [ ] **Step 2: Run test suite (`npm test`)**
- [ ] **Step 3: Inspect diff (`git diff -U3`)**
