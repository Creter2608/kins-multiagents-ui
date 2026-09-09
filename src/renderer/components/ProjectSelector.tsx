import React, { useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, ChevronDown, Check, Loader2, Clock, ShieldCheck, ShieldAlert, Globe, Sparkles } from "lucide-react";
import type { ProjectState, WorkspaceContext, WorkspaceStealthStatus } from "../../shared/contracts.js";

export const ProjectSelector: React.FC = () => {
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext | null>(null);
  const [stealthStatus, setStealthStatus] = useState<WorkspaceStealthStatus | null>(null);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isActionPending, setIsActionPending] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refreshContext = async () => {
    const api = window.cockpitApi;
    if (!api?.project) return;
    try {
      if (api.project.getWorkspaceContext) {
        const ctx = await api.project.getWorkspaceContext();
        setWorkspaceContext(ctx);
      }
      if (api.project.getStealthStatus) {
        const status = await api.project.getStealthStatus();
        setStealthStatus(status);
      }
    } catch (err) {
      console.error("[ProjectSelector] Failed to fetch workspace context/stealth status:", err);
    }
  };

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api?.project) return;

    void api.project.getState().then((state) => {
      setProjectState(state);
      void refreshContext();
    }).catch((err) => {
      console.error("[ProjectSelector] Failed to fetch initial state:", err);
    });

    const unsubProject = api.project.onProjectChanged?.((state) => {
      setProjectState(state);
      void refreshContext();
    });

    const unsubContext = api.project.onWorkspaceContextChanged?.((ctx) => {
      setWorkspaceContext(ctx);
      void refreshContext();
    });

    return () => {
      unsubProject?.();
      unsubContext?.();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleSelectProject = async (targetPath: string) => {
    const api = window.cockpitApi;
    if (!api?.project || isLoading || isActionPending) return;

    if (projectState?.currentProject.path === targetPath) {
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextState = await api.project.switchProject(targetPath);
      setProjectState(nextState);
      await refreshContext();
      setIsOpen(false);
    } catch (err) {
      console.error("[ProjectSelector] Failed to switch project:", err);
      alert(`Failed to switch project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenFolder = async () => {
    const api = window.cockpitApi;
    if (!api?.project || isLoading || isActionPending) return;

    setIsLoading(true);
    try {
      const nextState = await api.project.openProjectFolder();
      if (nextState) {
        setProjectState(nextState);
        await refreshContext();
        setIsOpen(false);
      }
    } catch (err) {
      console.error("[ProjectSelector] Failed to open folder:", err);
      alert(`Failed to open project folder: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleStealth = async () => {
    const api = window.cockpitApi;
    if (!api?.project || isActionPending) return;

    setIsActionPending(true);
    setActionMessage(null);
    try {
      if (stealthStatus?.equipped) {
        const res = await api.project.unequipStealthRules?.();
        if (res?.success) {
          setActionMessage(`Stealth rules unequipped (${res.filesRemoved.length} files removed)`);
        }
      } else {
        const res = await api.project.equipStealthRules?.();
        if (res?.success) {
          setActionMessage(`Stealth rules equipped (${res.filesCreated.length} files invisible to Git)`);
        }
      }
      await refreshContext();
    } catch (err) {
      console.error("[ProjectSelector] Failed to toggle stealth rules:", err);
      alert(`Stealth rule error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsActionPending(false);
    }
  };

  const handleSyncGlobalIde = async () => {
    const api = window.cockpitApi;
    if (!api?.project?.syncGlobalIdeRules || isActionPending) return;

    setIsActionPending(true);
    setActionMessage(null);
    try {
      const res = await api.project.syncGlobalIdeRules();
      if (res.success) {
        setActionMessage(`Synced rules to ${res.synced.length} global IDE locations`);
      }
    } catch (err) {
      console.error("[ProjectSelector] Failed to sync global IDE rules:", err);
      alert(`Global IDE sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsActionPending(false);
    }
  };

  const current = projectState?.currentProject;

  return (
    <div className="relative ml-2" ref={containerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        disabled={isLoading}
        onClick={() => setIsOpen((prev) => !prev)}
        title={current?.path ? `Current: ${current.path}\nSidecar: ${workspaceContext?.sidecarDirectory || "N/A"}` : "Select project"}
        className={`h-7 px-2.5 rounded bg-[#141414] hover:bg-[#1c1c1f] text-zinc-200 border border-[#27272a] hover:border-zinc-600 flex items-center space-x-1.5 transition-colors cursor-pointer select-none max-w-[320px] ${
          isOpen ? "border-emerald-500/60 ring-1 ring-emerald-500/30 bg-[#1a1a1e]" : ""
        } ${isLoading ? "opacity-70 cursor-wait" : ""}`}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        )}
        <span className="text-xs font-mono font-semibold truncate text-zinc-100">
          {current ? current.name : "No Project"}
        </span>
        {workspaceContext && (
          <span className="px-1 text-[9px] bg-emerald-950/70 border border-emerald-500/40 text-emerald-400 rounded shrink-0">
            {workspaceContext.rules.length} rules
          </span>
        )}
        {stealthStatus?.equipped && (
          <span className="px-1 text-[9px] bg-blue-950/70 border border-blue-500/40 text-blue-400 rounded shrink-0" title="Stealth rules active in .git/info/exclude">
            Stealth
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform duration-150 ${
            isOpen ? "rotate-180 text-emerald-400" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-9 left-0 w-88 bg-[#111113] border border-[#27272a] rounded-md shadow-2xl shadow-black/90 z-50 py-1.5 flex flex-col text-xs font-mono animate-in fade-in zoom-in-95 duration-100">
          {/* Workspace Sidecar & Stealth Status */}
          <div className="px-3 py-2 bg-[#141418] border-b border-[#1e1e24] mb-1.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold flex items-center space-x-1">
                <Sparkles className="w-3 h-3 text-emerald-400" />
                <span>Sidecar Cockpit</span>
              </span>
              <span className="text-[10px] text-emerald-400 font-medium">
                {workspaceContext ? "Active" : "Initializing..."}
              </span>
            </div>
            <div className="text-[10px] text-zinc-400 truncate" title={workspaceContext?.sidecarDirectory}>
              Sidecar: <span className="text-zinc-300 font-mono">{workspaceContext ? workspaceContext.sidecarDirectory : "None"}</span>
            </div>
            <div className="text-[10px] text-zinc-400 flex items-center justify-between">
              <span>Stealth (.git/info/exclude):</span>
              <span className={`font-semibold ${stealthStatus?.equipped ? "text-blue-400" : "text-zinc-500"}`}>
                {stealthStatus?.equipped ? (stealthStatus.excluded ? "Equipped (Zero Git Diff)" : "Equipped") : "Not equipped"}
              </span>
            </div>

            {actionMessage && (
              <div className="text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 rounded px-2 py-1 mt-1">
                {actionMessage}
              </div>
            )}

            {/* Quick Actions */}
            <div className="pt-1 flex items-center space-x-1.5">
              <button
                type="button"
                disabled={isActionPending}
                onClick={() => void handleToggleStealth()}
                className={`flex-1 px-2 py-1 rounded text-[10px] font-semibold border flex items-center justify-center space-x-1 transition-colors cursor-pointer ${
                  stealthStatus?.equipped
                    ? "bg-[#181820] text-zinc-300 border-zinc-700 hover:border-zinc-500"
                    : "bg-blue-950/40 text-blue-300 border-blue-700/50 hover:bg-blue-900/40"
                } ${isActionPending ? "opacity-60 cursor-wait" : ""}`}
              >
                {isActionPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : stealthStatus?.equipped ? (
                  <ShieldAlert className="w-3 h-3 text-zinc-400" />
                ) : (
                  <ShieldCheck className="w-3 h-3 text-blue-400" />
                )}
                <span>{stealthStatus?.equipped ? "Unequip Stealth" : "Equip Stealth Rules"}</span>
              </button>

              <button
                type="button"
                disabled={isActionPending}
                onClick={() => void handleSyncGlobalIde()}
                title="Export compiled rules to ~/.gemini, ~/.claude, and ~/.cursor"
                className={`px-2 py-1 rounded text-[10px] font-semibold bg-[#181820] hover:bg-[#20202a] text-zinc-300 border border-zinc-700 hover:border-zinc-500 flex items-center space-x-1 transition-colors cursor-pointer ${
                  isActionPending ? "opacity-60 cursor-wait" : ""
                }`}
              >
                <Globe className="w-3 h-3 text-emerald-400" />
                <span>Sync Global IDEs</span>
              </button>
            </div>
          </div>

          {/* Header */}
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center justify-between border-b border-[#1e1e24] pb-1 mb-1">
            <span className="flex items-center space-x-1">
              <Clock className="w-3 h-3 text-zinc-400" />
              <span>Recent Projects</span>
            </span>
            <span className="text-zinc-500 text-[9px]">{projectState?.recentProjects.length || 0} found</span>
          </div>

          {/* List of recent projects */}
          <div className="max-h-56 overflow-y-auto divide-y divide-[#18181b]">
            {projectState?.recentProjects && projectState.recentProjects.length > 0 ? (
              projectState.recentProjects.map((item) => {
                const isSelected = item.path === current?.path;
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => void handleSelectProject(item.path)}
                    title={item.path}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between hover:bg-[#1a1a22] transition-colors cursor-pointer group ${
                      isSelected ? "bg-[#16161d]" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div
                        className={`font-semibold text-xs truncate flex items-center space-x-1.5 ${
                          isSelected ? "text-emerald-400" : "text-zinc-200 group-hover:text-white"
                        }`}
                      >
                        <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-emerald-400" : "text-zinc-400"}`} />
                        <span className="truncate">{item.name}</span>
                      </div>
                      <div className="text-[10px] text-zinc-400 truncate pl-5 font-normal group-hover:text-zinc-300">
                        {item.path}
                      </div>
                    </div>
                    {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-2 text-zinc-400 text-center italic text-[11px]">
                No recent projects
              </div>
            )}
          </div>

          {/* Action: Open Folder */}
          <div className="pt-1.5 mt-1 border-t border-[#1e1e24] px-1">
            <button
              type="button"
              onClick={() => void handleOpenFolder()}
              className="w-full px-2.5 py-1.5 rounded hover:bg-[#1a1a22] text-zinc-200 hover:text-white flex items-center space-x-2 transition-colors cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-semibold text-xs">Open Project Folder...</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
