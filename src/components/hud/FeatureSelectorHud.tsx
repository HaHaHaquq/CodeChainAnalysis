import React, { useMemo, useState } from "react";
import {
  Activity,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Crosshair,
  Flame,
  RefreshCw,
  Search,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
import { EntryCategory, FeatureEntry } from "../../types/analysis";
import { computeStackMetrics } from "../../utils/graphMetrics";
import { SWIMLANE_META } from "../../utils/layoutEngine";
import { classifyProjectEntries } from "../../utils/storyAnalyzer";

const CATEGORY_META: Record<
  EntryCategory,
  { label: string; icon: React.ReactNode; color: string }
> = {
  RTOS_TASK: {
    label: "RTOS 任务",
    icon: <Activity className="h-3.5 w-3.5 text-[#7b9acc]" />,
    color: "text-[#a9c2eb]",
  },
  ISR: {
    label: "硬件中断 (ISR)",
    icon: <Zap className="h-3.5 w-3.5 text-[#c9858d]" />,
    color: "text-[#d9a3aa]",
  },
  MAIN_LOOP: {
    label: "主流程与初始化",
    icon: <Cpu className="h-3.5 w-3.5 text-[#859ce0]" />,
    color: "text-[#b0c0ed]",
  },
  PUBLIC_API: {
    label: "核心功能 / 协议模块",
    icon: <Box className="h-3.5 w-3.5 text-[#69ad99]" />,
    color: "text-[#95c9b9]",
  },
  CMD_TABLE: {
    label: "命令 / 状态表",
    icon: <Terminal className="h-3.5 w-3.5 text-[#d2a266]" />,
    color: "text-[#e0be92]",
  },
};

export const FeatureSelectorHud: React.FC = () => {
  const project = useChainStore((s) => s.project);
  const activeEntryId = useChainStore((s) => s.activeEntryId);
  const setActiveEntry = useChainStore((s) => s.setActiveEntry);
  const leftHudOpen = useChainStore((s) => s.leftHudOpen);
  const setLeftHudOpen = useChainStore((s) => s.setLeftHudOpen);
  const createCustomEntryFromNode = useChainStore(
    (s) => s.createCustomEntryFromNode
  );
  const selectNode = useChainStore((s) => s.selectNode);

  const [searchQuery, setSearchQuery] = useState("");
  const [showSupportEntries, setShowSupportEntries] = useState(false);

  const { coreEntries, supportEntries } = useMemo(
    () => classifyProjectEntries(project),
    [project]
  );

  const activeEntry =
    project.entries.find((e) => e.id === activeEntryId) ?? project.entries[0];

  const totalFunctionCount = Object.keys(project.nodes).length;

  const matchedFunctions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return Object.values(project.nodes)
      .filter(
        (fn) =>
          fn.name.toLowerCase().includes(q) ||
          fn.file.toLowerCase().includes(q) ||
          fn.brief.toLowerCase().includes(q)
      )
      .slice(0, 25);
  }, [project.nodes, searchQuery]);

  if (!leftHudOpen) {
    return (
      <div className="absolute top-20 left-3 z-20">
        <button
          type="button"
          onClick={() => setLeftHudOpen(true)}
          className="flex items-center gap-2 rounded-2xl border border-slate-300/12 bg-[#141b26]/95 px-3 py-2 text-xs font-medium text-[#dce4ee] backdrop-blur-xl shadow-lg hover:border-[#7b9acc]/50 transition-all cursor-pointer"
        >
          {CATEGORY_META[activeEntry.category].icon}
          <span className="max-w-[160px] truncate">
            {activeEntry.displayName}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
        </button>
      </div>
    );
  }

  const renderEntryCard = (entry: FeatureEntry) => {
    const isActive = entry.id === activeEntryId;
    const catMeta = CATEGORY_META[entry.category];
    const metrics = computeStackMetrics(entry, project.nodes, project.edges);

    return (
      <button
        key={entry.id}
        type="button"
        onClick={() => setActiveEntry(entry.id)}
        className={`w-full text-left rounded-xl border p-2.5 transition-all cursor-pointer ${
          isActive
            ? "border-[#7b9acc]/55 bg-[#1b2738]"
            : "border-slate-300/[0.06] bg-[#101620]/85 hover:border-slate-300/18 hover:bg-[#17202e]"
        }`}
      >
        <div className="flex items-center justify-between gap-1.5 mb-1">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium">
            {catMeta.icon}
            <span className={catMeta.color}>{catMeta.label}</span>
          </span>
          <span className="font-mono text-[10px] text-[#738296]">
            {entry.nodeIds.length} fn
          </span>
        </div>

        <div className="text-xs font-semibold text-[#e6edf3] leading-snug">
          {entry.displayName}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-[#8392a6] truncate">
          {entry.name}()
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {metrics.runtimeReq === "BARE_METAL_READY" ? (
            <span className="inline-flex items-center gap-1 rounded bg-[#69ad99]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#95c9b9] border border-[#69ad99]/25">
              裸机可用
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded bg-[#7b9acc]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#a9c2eb] border border-[#7b9acc]/25">
              需 RTOS/OSAL
            </span>
          )}

          <span
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] ${
              metrics.rtosOverflowRisk === "CRITICAL"
                ? "bg-[#c9858d]/18 text-[#e3a8af] border border-[#c9858d]/35"
                : "bg-[#192231] text-[#9aa7b8]"
            }`}
          >
            <Flame className="h-2.5 w-2.5" /> ~{metrics.maxStackBytes}B
          </span>

          {metrics.hasRecursion && (
            <span className="inline-flex items-center gap-0.5 rounded bg-[#9e8bc7]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#c5b6e3] border border-[#9e8bc7]/30">
              <RefreshCw className="h-2.5 w-2.5" /> 递归
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <aside className="absolute top-20 left-3 z-20 w-[290px] max-h-[calc(100vh-195px)] flex flex-col rounded-2xl border border-slate-300/10 bg-[#141b26]/95 backdrop-blur-xl shadow-[0_12px_36px_rgba(0,0,0,0.38)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-300/[0.08] px-3.5 py-2.5">
        <div>
          <div className="text-xs font-semibold text-[#e6edf3]">
            功能脉络与符号索引 ({totalFunctionCount} fn)
          </div>
          <div className="text-[10px] text-[#7c8a9e]">
            核心功能优先 · 任意函数可一键建链
          </div>
        </div>
        <button
          type="button"
          onClick={() => setLeftHudOpen(false)}
          title="收起为胶囊（沉浸阅读）"
          className="rounded-lg p-1 text-slate-400 hover:bg-[#1e2838] hover:text-slate-100 transition-colors cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Global Function Search Input */}
      <div className="border-b border-slate-300/[0.08] bg-[#101620]/70 px-2.5 py-2">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-[#738296]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`搜全库 ${totalFunctionCount} 个函数 (如 hid, cdc, enum)...`}
            className="w-full rounded-xl border border-slate-300/10 bg-[#0e131a] pl-8 pr-7 py-1.5 text-[11px] text-[#e6edf3] placeholder:text-[#64748b] focus:border-[#7b9acc]/60 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 text-slate-400 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Search Results OR Categorized Entry List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {searchQuery.trim() ? (
          matchedFunctions.length > 0 ? (
            <div className="space-y-1.5">
              <div className="px-1 text-[10px] font-semibold text-cyan-300">
                找到 {matchedFunctions.length} 个匹配函数（点击追踪完整上下游调用链）：
              </div>
              {matchedFunctions.map((fn) => {
                const layerMeta = SWIMLANE_META[fn.layer];
                const isInCurrentGraph = activeEntry.nodeIds.includes(fn.id);
                return (
                  <div
                    key={fn.id}
                    className="rounded-xl border border-white/10 bg-slate-900/80 p-2.5 hover:border-cyan-400/50 transition-all"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-bold"
                        style={{
                          backgroundColor: `${layerMeta.accentColor}22`,
                          color: layerMeta.accentColor,
                        }}
                      >
                        {fn.layer}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400">
                        ~{fn.stackBytes}B
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-xs font-bold text-slate-100 truncate">
                      {fn.name}()
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 truncate">
                      {fn.file}:{fn.lineStart}
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          createCustomEntryFromNode(fn.id);
                          setSearchQuery("");
                        }}
                        className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-cyan-500/20 border border-cyan-400/40 py-1 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-500/30"
                      >
                        <Crosshair className="h-3 w-3" />
                        生成此函数调用链
                      </button>
                      {isInCurrentGraph && (
                        <button
                          type="button"
                          onClick={() => {
                            selectNode(fn.id, true);
                            setSearchQuery("");
                          }}
                          className="rounded-lg bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
                        >
                          当前图定位
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-slate-400">
              未找到匹配 "{searchQuery}" 的函数
            </div>
          )
        ) : (
          <div className="space-y-2">
            <div className="px-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-[#7c8a9e]">
              核心功能与协议脉络 ({coreEntries.length})
            </div>
            {coreEntries.map(renderEntryCard)}

            {supportEntries.length > 0 && (
              <div className="pt-2 border-t border-slate-300/[0.08]">
                <button
                  type="button"
                  onClick={() => setShowSupportEntries(!showSupportEntries)}
                  className="w-full flex items-center justify-between rounded-lg px-2 py-1.5 text-[11px] font-medium text-[#8b98a9] hover:bg-[#1a2333] hover:text-[#dce4ee] transition-colors cursor-pointer"
                >
                  <span>板级支撑与辅助中断 ({supportEntries.length})</span>
                  {showSupportEntries ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
                {showSupportEntries && (
                  <div className="mt-1.5 space-y-1.5">
                    {supportEntries.map(renderEntryCard)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
