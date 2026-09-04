# Specification: Project Selector & Active Project Display in Kins Cockpit

**Date:** 2026-09-04  
**Status:** Approved by User  
**Target:** `kins-multiagents-ui`  

---

## 1. Overview & Objective
Add an active project indicator and project selector in the top header of Kins Cockpit (Electron + React). Users can see the currently active project folder at a glance, open a dropdown to switch between recently opened projects, or select a new project folder from their local file system via native OS dialog. Switching is seamless and in-place without reloading the Electron window.

---

## 2. Architectural Design

### 2.1 Backend Authority (`ProjectService.ts`)
A dedicated service in the main process (`src/main/services/ProjectService.ts`) managing:
- `currentProject`: Canonical absolute path and directory name.
- `recentProjects`: Unique, most-recent-first list of project folders.
- Persistence: Stored under Electron `app.getPath("userData")/recent-projects.json`.
- Dynamic Re-pointing: When switching projects, updates all project-scoped services:
  1. `PtyService`: Restarts terminal session with `cwd = newPath`.
  2. `LoopStateService`: Re-points watcher/state file to `<newPath>/.ai/state.json` and pushes new snapshot.
  3. `McpMonitorService`: Re-points root to `<newPath>`, reloads `mcp.json` / `.agents/mcp.json`.
  4. `RollbackService`: Updates target repository root.

### 2.2 IPC & Preload Bridge
- **IPC Channels**:
  - `project:get-state`: Returns `{ currentProject: ProjectInfo, recentProjects: ProjectInfo[] }`.
  - `project:switch`: Switches to a given absolute directory path.
  - `project:open-folder`: Opens native directory picker via `dialog.showOpenDialog({ properties: ["openDirectory"] })` and switches if a folder is selected.
- **Preload API (`window.cockpitApi.project`)**:
  - `getState(): Promise<ProjectState>`
  - `switchProject(path: string): Promise<ProjectState>`
  - `openProjectFolder(): Promise<ProjectState | null>`

### 2.3 Frontend Header UI (`App.tsx` / `ProjectSelector.tsx`)
- Placed in top `<header>` adjacent to `KINS COCKPIT v2.1.0`.
- Visual components:
  - Folder icon (`Folder` from `lucide-react`).
  - Active project name (bold, mono).
  - Hover tooltip showing the full absolute path.
  - Chevron icon (`ChevronDown`) indicating dropdown capability.
- Dropdown Popover:
  - Header: "Recent Projects".
  - List of recent project paths with name + path hint. Clicking switches immediately.
  - Separator border.
  - Button: "Open Project Folder..." (`FolderOpen` icon), invoking native folder dialog.

---

## 3. Compact Test Assertion Table

| Input | Expected Output |
| :--- | :--- |
| Missing config + default root `/tmp/a` | `/tmp/a` active; all 4 services receive `/tmp/a`; persisted |
| Switch `/tmp/a` -> `/tmp/b` | `/tmp/b` active; recents `[/tmp/b, /tmp/a]`; persisted |
| Switch again to `/tmp/a` | Recents `[/tmp/a, /tmp/b]` without duplicates |
| Malformed config | Safe fallback to default root; re-points all services |
| Nonexistent / non-directory path | Rejects; state, file, and services remain unchanged |

---

## 4. Implementation Steps
1. Extend `src/shared/contracts.ts` with `ProjectInfo`, `ProjectState`, and `CockpitApi.project`.
2. Add `setProjectRoot(newPath: string)` to `PtyService`, `LoopStateService`, `McpMonitorService`, and `RollbackService`.
3. Implement `src/main/services/ProjectService.ts` with atomic persistence and validation.
4. Add unit test suite `test/project-service.test.ts` verifying all assertions in the table.
5. Register IPC handlers in `src/main/ipc.ts` and expose via `src/preload/index.ts`.
6. Wire `ProjectService` into `src/main/index.ts`.
7. Build `ProjectSelector` component in `src/renderer/components/ProjectSelector.tsx` and embed in `src/renderer/App.tsx`.
8. Verify deterministic compilation and test suite.
