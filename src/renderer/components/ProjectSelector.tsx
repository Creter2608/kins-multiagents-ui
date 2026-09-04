import React, { useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, ChevronDown, Check, Loader2, Clock } from "lucide-react";
import type { ProjectState } from "../../shared/contracts.js";

export const ProjectSelector: React.FC = () => {
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api?.project) return;

    void api.project.getState().then(setProjectState).catch((err) => {
      console.error("[ProjectSelector] Failed to fetch initial state:", err);
    });
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
    if (!api?.project || isLoading) return;

    if (projectState?.currentProject.path === targetPath) {
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextState = await api.project.switchProject(targetPath);
      setProjectState(nextState);
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
    if (!api?.project || isLoading) return;

    setIsLoading(true);
    try {
      const nextState = await api.project.openProjectFolder();
      if (nextState) {
        setProjectState(nextState);
        setIsOpen(false);
      }
    } catch (err) {
      console.error("[ProjectSelector] Failed to open folder:", err);
      alert(`Failed to open project folder: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
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
        title={current?.path ? `Current: ${current.path}` : "Select project"}
        className={`h-7 px-2.5 rounded bg-[#141414] hover:bg-[#1c1c1f] text-zinc-200 border border-[#27272a] hover:border-zinc-600 flex items-center space-x-1.5 transition-colors cursor-pointer select-none max-w-[260px] ${
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
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform duration-150 ${
            isOpen ? "rotate-180 text-emerald-400" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-9 left-0 w-80 bg-[#111113] border border-[#27272a] rounded-md shadow-2xl shadow-black/90 z-50 py-1.5 flex flex-col text-xs font-mono animate-in fade-in zoom-in-95 duration-100">
          {/* Header */}
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center justify-between border-b border-[#1e1e24] pb-1.5 mb-1">
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
