import React, { useMemo, useState } from "react";
import {
  Activity,
  Box,
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
import { EntryCategory } from "../../types/analysis";
import { computeStackMetrics } from "../../utils/graphMetrics";
import { SWIMLANE_META } from "../../utils/layoutEngine";

const CATEGORY_META: Record<
  EntryCategory,
  { label: string; icon: React.ReactNode; color: string }
> = {
  RTOS_TASK: {
    label: "RTOS 任务线程",
    icon: <Activity className="h-3.5 w-3.5 text-cyan-400" />,
    color: "text-cyan-300",
  },
  ISR: {
    label: "硬件中断入口 (ISR)",
    icon: <Zap className="h-3.5 w-3.5 text-rose-400" />,
    color: "text-rose-300",
  },
  MAIN_LOOP: {
    label: "主循环与初始化",
    icon: <Cpu className="h-3.5 w-3.5 text-indigo-400" />,
    color: "text-indigo-300",
  },
  PUBLIC_API: {
    label: "模块对外 API",
    icon: <Box className="h-3.5 w-3.5 text-emerald-400" />,
    color: "text-emerald-300",
  },
  CMD_TABLE: {
    label: "命令表 / 状态跳转表",
    icon: <Terminal className="h-3.5 w-3.5 text-amber-400" />,
    color: "text-amber-300",
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
          className="flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/85 px-3 py-2 text-xs font-semibold text-slate-200 backdrop-blur-xl shadow-2xl hover:border-cyan-400/50 transition-all"
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

  return (
    <aside className="absolute top-20 left-3 z-20 w-[290px] max-h-[calc(100vh-195px)] flex flex-col rounded-2xl border border-white/10 bg-slate-950/86 backdrop-blur-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2.5">
        <div>
          <div className="text-xs font-bold text-slate-100">
            功能入口与全库符号 ({totalFunctionCount} fn)
          </div>
          <div className="text-[10px] text-slate-400">
            5 类自动聚类 · 支持任意函数建链
          </div>
        </div>
        <button
          type="button"
          onClick={() => setLeftHudOpen(false)}
          title="收起为胶囊（沉浸全屏画布）"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Global Function Search Input */}
      <div className="border-b border-white/10 bg-slate-900/50 px-2.5 py-2">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`搜全库 ${totalFunctionCount} 个函数 (如 dfu, audio, hid)...`}
            className="w-full rounded-xl border border-white/10 bg-slate-950/90 pl-8 pr-7 py-1.5 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
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
          project.entries.map((entry) => {
            const isActive = entry.id === activeEntryId;
            const catMeta = CATEGORY_META[entry.category];
            const metrics = computeStackMetrics(
              entry,
              project.nodes,
              project.edges
            );

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setActiveEntry(entry.id)}
                className={`w-full text-left rounded-xl border p-2.5 transition-all ${
                  isActive
                    ? "border-cyan-400/60 bg-cyan-500/12 shadow-[0_0_18px_rgba(34,211,238,0.16)]"
                    : "border-white/5 bg-slate-900/60 hover:border-white/15 hover:bg-slate-900/90"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5 mb-1">
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold">
                    {catMeta.icon}
                    <span className={catMeta.color}>{catMeta.label}</span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {entry.nodeIds.length} fn
                  </span>
                </div>

                <div className="text-xs font-bold text-slate-100 leading-snug">
                  {entry.displayName}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-slate-400 truncate">
                  {entry.name}()
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {metrics.runtimeReq === "BARE_METAL_READY" ? (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
                      🟢 裸机可用
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 border border-sky-500/30">
                      🔵 需RTOS/OSAL
                    </span>
                  )}

                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      metrics.rtosOverflowRisk === "CRITICAL"
                        ? "bg-red-500/20 text-red-300 border border-red-500/40"
                        : "bg-slate-800 text-slate-300"
                    }`}
                  >
                    <Flame className="h-2.5 w-2.5" /> ~{metrics.maxStackBytes}B
                  </span>

                  {metrics.hasRecursion && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-purple-200 border border-purple-400/40">
                      <RefreshCw className="h-2.5 w-2.5" /> 递归
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
