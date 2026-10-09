import React, { useState, useEffect, useMemo, useCallback } from "react";
import type { EccAssetSummary, EccCatalogSnapshot, EccAssetType } from "../../shared/eccContracts.js";
import {
  Bot,
  Wrench,
  Search,
  RefreshCw,
  X,
  Copy,
  Check,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Send,
  Plus,
  Trash2
} from "lucide-react";

export interface EccCatalogViewProps {
  readonly onSelectAsset?: (asset: EccAssetSummary) => void;
  readonly onDispatched?: (invocationId: string) => void;
}

export const EccCatalogView: React.FC<EccCatalogViewProps> = ({ onSelectAsset, onDispatched }) => {
  const [snapshot, setSnapshot] = useState<EccCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<"all" | EccAssetType>("all");
  const [selectedAsset, setSelectedAsset] = useState<EccAssetSummary | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // Dispatch form state
  const [dispatchTask, setDispatchTask] = useState<string>("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [dispatching, setDispatching] = useState<boolean>(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchSuccess, setDispatchSuccess] = useState<string | null>(null);

  const fetchCatalog = useCallback(async (isRefresh = false) => {
    const api = window.cockpitApi;
    if (!api?.ecc) {
      setError("ECC bridge API unavailable");
      setLoading(false);
      return;
    }

    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const result = isRefresh ? await api.ecc.refreshCatalog() : await api.ecc.getCatalog();
      setSnapshot(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchCatalog(false);
  }, [fetchCatalog]);

  // Modal keyboard dismiss
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedAsset(null);
      }
    };
    if (selectedAsset) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedAsset]);

  // Reset dispatch state when selected asset changes
  useEffect(() => {
    setDispatchTask("");
    setSelectedSkillIds([]);
    setDispatchError(null);
    setDispatchSuccess(null);
  }, [selectedAsset]);

  const filteredAssets = useMemo(() => {
    if (!snapshot) return [];
    const query = searchQuery.trim().toLowerCase();
    return snapshot.assets.filter((asset) => {
      if (typeFilter !== "all" && asset.kind !== typeFilter && asset.type !== typeFilter) {
        return false;
      }
      if (!query) return true;

      const matchesName = asset.name.toLowerCase().includes(query);
      const matchesId = asset.id.toLowerCase().includes(query);
      const matchesDesc = asset.description.toLowerCase().includes(query);
      const matchesCategory = asset.category?.toLowerCase().includes(query) ?? false;
      const matchesModel = asset.model?.toLowerCase().includes(query) ?? false;
      const matchesTools = asset.tools?.some((t) => t.toLowerCase().includes(query)) ?? false;

      return matchesName || matchesId || matchesDesc || matchesCategory || matchesModel || matchesTools;
    });
  }, [snapshot, searchQuery, typeFilter]);

  const agentCount = useMemo(
    () => snapshot?.assets.filter((a) => a.kind === "agent").length ?? 0,
    [snapshot]
  );
  const skillCount = useMemo(
    () => snapshot?.assets.filter((a) => a.kind === "skill").length ?? 0,
    [snapshot]
  );

  const availableSkills = useMemo(
    () => snapshot?.assets.filter((a) => a.kind === "skill" && a.status === "available") ?? [],
    [snapshot]
  );

  const handleDispatch = async () => {
    if (!snapshot || !selectedAsset || !dispatchTask.trim()) return;
    setDispatching(true);
    setDispatchError(null);
    setDispatchSuccess(null);

    try {
      const api = window.cockpitApi?.ecc;
      if (!api?.dispatch) {
        throw new Error("Dispatch capability not available on Cockpit API");
      }

      const result = await api.dispatch({
        catalogRevision: snapshot.revision,
        agentId: selectedAsset.id,
        skillIds: selectedSkillIds,
        task: dispatchTask.trim()
      });

      if (result.accepted) {
        setDispatchSuccess(result.invocationId);
        setTimeout(() => {
          setSelectedAsset(null);
          onDispatched?.(result.invocationId);
        }, 750);
      } else {
        setDispatchError(`${result.reason}: ${result.message || "Dispatch was rejected"}`);
      }
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  const toggleSkill = (skillId: string) => {
    setSelectedSkillIds((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId]
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden text-zinc-300 font-sans select-none">
      {/* Search & Actions Bar */}
      <div className="p-2.5 border-b border-zinc-800 bg-zinc-900/60 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search 68 agents & 293 skills..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-md pl-8 pr-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/30 transition-all font-mono"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                title="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => void fetchCatalog(true)}
            disabled={loading || refreshing}
            className="p-1.5 rounded-md bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 border border-zinc-700/60 transition-colors disabled:opacity-40 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 shrink-0"
            title="Refresh ECC Catalog"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-blue-400" : ""}`} />
          </button>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer border ${
              typeFilter === "all"
                ? "bg-zinc-800 text-zinc-100 font-semibold border-zinc-600"
                : "bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 border-zinc-800"
            }`}
          >
            All ({snapshot?.assets.length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("agent")}
            className={`px-2 py-0.5 rounded text-[11px] font-mono flex items-center gap-1 transition-colors cursor-pointer border ${
              typeFilter === "agent"
                ? "bg-blue-950/60 text-blue-300 font-semibold border-blue-700"
                : "bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 border-zinc-800"
            }`}
          >
            <Bot className="w-3 h-3" />
            Agents ({agentCount})
          </button>
          <button
            type="button"
            onClick={() => setTypeFilter("skill")}
            className={`px-2 py-0.5 rounded text-[11px] font-mono flex items-center gap-1 transition-colors cursor-pointer border ${
              typeFilter === "skill"
                ? "bg-amber-950/60 text-amber-300 font-semibold border-amber-700"
                : "bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 border-zinc-800"
            }`}
          >
            <Wrench className="w-3 h-3" />
            Skills ({skillCount})
          </button>

          {snapshot?.quarantinedCount ? (
            <span
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800 font-mono flex items-center gap-1 shrink-0"
              title={`${snapshot.quarantinedCount} quarantined assets`}
            >
              <ShieldAlert className="w-2.5 h-2.5" />
              {snapshot.quarantinedCount} Quarantined
            </span>
          ) : null}
        </div>
      </div>

      {/* Asset List */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2 custom-scrollbar">
        {loading && !snapshot ? (
          <div className="text-center py-12 px-3 text-zinc-400 space-y-2">
            <RefreshCw className="w-6 h-6 mx-auto text-blue-400 animate-spin" />
            <div className="text-xs font-semibold text-zinc-300">Scanning ECC assets...</div>
            <div className="text-[11px] text-zinc-400">Inspecting agents and skills in read-only sandbox.</div>
          </div>
        ) : error ? (
          <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-800/60 text-rose-300 text-xs space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-rose-400" />
              Failed to load ECC Catalog
            </div>
            <div className="text-[11px] font-mono break-all">{error}</div>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="text-center py-10 px-3 text-zinc-400 space-y-2">
            <Bot className="w-8 h-8 mx-auto text-zinc-500 opacity-60" />
            <div className="text-xs font-semibold text-zinc-300">No assets matched</div>
            <div className="text-[11px] text-zinc-400">
              {searchQuery ? "Try a different search term or clear the filter." : "ECC repository empty or not found."}
            </div>
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const isQuarantined = asset.status === "quarantined";
            const isAgent = asset.kind === "agent" || asset.type === "agent";

            return (
              <div
                key={asset.id}
                onClick={() => {
                  setSelectedAsset(asset);
                  onSelectAsset?.(asset);
                }}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedAsset(asset);
                    onSelectAsset?.(asset);
                  }
                }}
                className={`p-2.5 rounded-lg border cursor-pointer transition-colors space-y-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 ${
                  isQuarantined
                    ? "bg-rose-950/20 border-rose-900/60 hover:border-rose-700/80"
                    : "bg-zinc-900/80 border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center space-x-1.5 min-w-0">
                    {isAgent ? (
                      <Bot className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    ) : (
                      <Wrench className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-zinc-100 truncate font-mono">
                      {asset.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      className={`text-[9px] px-1.5 py-0.2 rounded border font-mono uppercase font-medium ${
                        isAgent
                          ? "bg-blue-950/40 text-blue-300 border-blue-800/60"
                          : "bg-amber-950/40 text-amber-300 border-amber-800/60"
                      }`}
                    >
                      {asset.kind}
                    </span>
                    {isQuarantined ? (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-rose-950/70 text-rose-300 border border-rose-700/80 font-mono flex items-center gap-0.5">
                        <ShieldAlert className="w-2.5 h-2.5" />
                        Quarantine
                      </span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-800/60 font-mono flex items-center gap-0.5">
                        <ShieldCheck className="w-2.5 h-2.5" />
                        Safe
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] text-zinc-300 line-clamp-2 leading-relaxed">
                  {asset.description || "(No description provided)"}
                </div>

                <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-1 border-t border-zinc-800/70 font-mono">
                  <div className="flex items-center space-x-1.5 truncate">
                    {asset.category && (
                      <span className="flex items-center gap-0.5 text-zinc-300">
                        <Tag className="w-2.5 h-2.5 text-zinc-400" />
                        {asset.category}
                      </span>
                    )}
                    {asset.model && (
                      <span className="text-zinc-400 bg-zinc-950 px-1 rounded border border-zinc-800">
                        {asset.model}
                      </span>
                    )}
                  </div>
                  <span className="text-zinc-400 text-[9px]">
                    {(asset.digest ?? asset.sha256).slice(0, 8)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Asset Details & Dispatch Modal */}
      {selectedAsset && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ecc-modal-title"
          onClick={() => setSelectedAsset(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full shadow-2xl overflow-hidden text-zinc-200 flex flex-col max-h-[85vh] font-sans"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900">
              <div className="flex items-center space-x-2">
                {selectedAsset.kind === "agent" ? (
                  <Bot className="w-4 h-4 text-blue-400" />
                ) : (
                  <Wrench className="w-4 h-4 text-amber-400" />
                )}
                <span id="ecc-modal-title" className="text-xs font-bold text-zinc-100 uppercase tracking-wide font-mono">
                  {selectedAsset.name}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase font-semibold ${
                    selectedAsset.kind === "agent"
                      ? "bg-blue-950/60 text-blue-300 border-blue-800"
                      : "bg-amber-950/60 text-amber-300 border-amber-800"
                  }`}
                >
                  {selectedAsset.kind}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAsset(null)}
                aria-label="Close details"
                className="p-1 hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-3 overflow-y-auto text-xs custom-scrollbar">
              {/* Quarantine Banner */}
              {selectedAsset.status === "quarantined" && (
                <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-200 space-y-1">
                  <div className="font-semibold flex items-center gap-1 text-xs">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    Asset Quarantined by AgentShield Guardrails
                  </div>
                  <ul className="list-disc list-inside text-[11px] text-rose-300 font-mono space-y-0.5">
                    {selectedAsset.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">
                  Description
                </div>
                <div className="text-zinc-200 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800 text-[11px] leading-relaxed whitespace-pre-wrap font-sans">
                  {selectedAsset.description || "(No description provided)"}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">
                    Category
                  </div>
                  <div className="text-zinc-200 font-mono bg-zinc-950 p-1.5 rounded border border-zinc-800 text-[11px]">
                    {selectedAsset.category || "General"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">
                    Model
                  </div>
                  <div className="text-zinc-200 font-mono bg-zinc-950 p-1.5 rounded border border-zinc-800 text-[11px]">
                    {selectedAsset.model || "inherit"}
                  </div>
                </div>
              </div>

              {selectedAsset.tools && selectedAsset.tools.length > 0 && (
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-1">
                    Declared Tools
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {selectedAsset.tools.map((tool, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300 text-[11px] font-mono"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Interactive Dispatch Section for Available Agents */}
              {selectedAsset.kind === "agent" && selectedAsset.status === "available" && (
                <div className="p-3 rounded-lg bg-zinc-950/80 border border-blue-900/50 space-y-2.5 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-blue-300 font-mono flex items-center gap-1.5">
                      <Send className="w-3.5 h-3.5 text-blue-400" />
                      Dispatch into Subagent Queue
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      Target: Cockpit Queue
                    </span>
                  </div>

                  {/* Task Input */}
                  <div>
                    <label className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider block mb-1">
                      Task Prompt
                    </label>
                    <textarea
                      value={dispatchTask}
                      onChange={(e) => setDispatchTask(e.target.value)}
                      placeholder={`Enter mission instructions for ${selectedAsset.name}...`}
                      rows={3}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-md p-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500/80 focus:ring-1 focus:ring-blue-500/40 font-mono resize-none"
                    />
                  </div>

                  {/* Skills Attachment Picker */}
                  {availableSkills.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-1">
                        <span>Attach Capability Skills ({selectedSkillIds.length} selected)</span>
                        {selectedSkillIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedSkillIds([])}
                            className="text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-0.5 cursor-pointer"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                            clear
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto custom-scrollbar p-1 bg-zinc-900/60 rounded border border-zinc-800/80">
                        {availableSkills.map((sk) => {
                          const isAttached = selectedSkillIds.includes(sk.id);
                          return (
                            <button
                              key={sk.id}
                              type="button"
                              onClick={() => toggleSkill(sk.id)}
                              className={`px-2 py-0.5 rounded text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer border ${
                                isAttached
                                  ? "bg-amber-950 text-amber-200 border-amber-600 font-semibold"
                                  : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 border-zinc-800"
                              }`}
                            >
                              {isAttached ? <Check className="w-2.5 h-2.5 text-amber-300" /> : <Plus className="w-2.5 h-2.5" />}
                              {sk.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Status & Error Feedback */}
                  {dispatchSuccess && (
                    <div className="p-2 rounded bg-emerald-950/60 border border-emerald-700/80 text-emerald-300 text-xs font-mono flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>Dispatched as <strong>{dispatchSuccess}</strong>! Switching to Queue...</span>
                    </div>
                  )}

                  {dispatchError && (
                    <div className="p-2 rounded bg-rose-950/50 border border-rose-800 text-rose-300 text-xs font-mono flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span className="break-all">{dispatchError}</span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleDispatch()}
                    disabled={dispatching || !dispatchTask.trim() || !!dispatchSuccess}
                    className="w-full py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-xs font-semibold font-mono flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-md disabled:cursor-not-allowed"
                  >
                    {dispatching ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Dispatching into Cockpit...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Launch Subagent Activity</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              <div>
                <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">
                  Relative Path
                </div>
                <div className="text-zinc-200 font-mono bg-zinc-950 p-1.5 rounded border border-zinc-800 text-[11px] break-all">
                  {selectedAsset.relativePath}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800 text-[11px] text-zinc-400 font-mono">
                <div>Size: {selectedAsset.sizeBytes != null ? (selectedAsset.sizeBytes / 1024).toFixed(1) : "0.0"} KiB</div>
                <div className="truncate" title={selectedAsset.sha256}>
                  SHA256: {selectedAsset.sha256.slice(0, 16)}...
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-zinc-800 bg-zinc-900 flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  const promptPayload = `Invoke ECC ${selectedAsset.kind}: ${selectedAsset.name}\n${selectedAsset.description}`;
                  navigator.clipboard.writeText(promptPayload);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold border border-zinc-700 transition-colors flex items-center gap-1.5 cursor-pointer font-mono"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Reference</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setSelectedAsset(null)}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-zinc-700 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
