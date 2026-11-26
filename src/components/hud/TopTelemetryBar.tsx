import React from "react";
import {
  BookOpen,
  Cpu,
  FileText,
  Flame,
  FolderOpen,
  GitCommitHorizontal,
  Layers,
  Network,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriDesktop, useChainStore } from "../../store/useChainStore";
import {
  PortingBoundaryResult,
  StackMetricsResult,
} from "../../types/analysis";

interface TopTelemetryBarProps {
  stackMetrics: StackMetricsResult;
  porting: PortingBoundaryResult;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

export const TopTelemetryBar: React.FC<TopTelemetryBarProps> = ({
  stackMetrics,
  porting,
}) => {
  const project = useChainStore((s) => s.project);
  const viewMode = useChainStore((s) => s.viewMode);
  const setViewMode = useChainStore((s) => s.setViewMode);
  const heatmapEnabled = useChainStore((s) => s.heatmapEnabled);
  const toggleHeatmap = useChainStore((s) => s.toggleHeatmap);
  const rightDrawerOpen = useChainStore((s) => s.rightDrawerOpen);
  const setRightDrawerOpen = useChainStore((s) => s.setRightDrawerOpen);
  const rightDrawerLayout = useChainStore((s) => s.rightDrawerLayout);
  const setRightDrawerLayout = useChainStore((s) => s.setRightDrawerLayout);
  const layerOverrides = useChainStore((s) => s.layerOverrides);
  const resetLayerOverrides = useChainStore((s) => s.resetLayerOverrides);
  const setAiPromptModalOpen = useChainStore((s) => s.setAiPromptModalOpen);
  const setOpenProjectModalOpen = useChainStore((s) => s.setOpenProjectModalOpen);

  const hasOverrides = Object.keys(layerOverrides).length > 0;
  const riskColor =
    stackMetrics.rtosOverflowRisk === "CRITICAL"
      ? "text-[#e3a8af] border-[#c9858d]/40 bg-[#c9858d]/12"
      : stackMetrics.rtosOverflowRisk === "WARNING"
      ? "text-[#e0be92] border-[#d2a266]/40 bg-[#d2a266]/12"
      : "text-[#95c9b9] border-[#69ad99]/35 bg-[#69ad99]/10";

  return (
    <header className="pointer-events-none absolute top-3 left-3 right-3 z-30 flex items-center justify-between gap-3">
      {/* Left: Brand + Project pill (Refined Editorial Slate) */}
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-2xl border border-slate-300/12 bg-[#141b26]/95 px-3.5 py-2 backdrop-blur-xl shadow-[0_8px_28px_rgba(0,0,0,0.32)]">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#2c2c2e] via-[#1c1c1e] to-[#0a0a0c] border border-[#8e8e93]/40 shadow-[0_2px_10px_rgba(255,255,255,0.08)]">
          <svg
            viewBox="0 0 128 128"
            className="h-5 w-5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
            fill="none"
          >
            <defs>
              <linearGradient
                id="hudSilverMain"
                x1="26"
                y1="22"
                x2="96"
                y2="104"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="#FFFFFF" />
                <stop offset="42%" stopColor="#E5E5EA" />
                <stop offset="58%" stopColor="#F5F5F7" />
                <stop offset="100%" stopColor="#8E8E93" />
              </linearGradient>
              <linearGradient
                id="hudSilverBranch"
                x1="62"
                y1="62"
                x2="96"
                y2="86"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0%" stopColor="#D1D1D6" />
                <stop offset="100%" stopColor="#8E8E93" />
              </linearGradient>
            </defs>
            {/* Secondary Callback Branch */}
            <path
              d="M70 67 Q 79 74 88 79"
              stroke="url(#hudSilverBranch)"
              strokeWidth="7.5"
              strokeLinecap="round"
            />
            <circle cx="91" cy="81" r="7" fill="url(#hudSilverBranch)" />
            {/* Main Chain Connectors */}
            <path
              d="M46 77 Q 52 67 55 68"
              stroke="url(#hudSilverMain)"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <path
              d="M70 55 Q 76 45 81 47"
              stroke="url(#hudSilverMain)"
              strokeWidth="8"
              strokeLinecap="round"
            />
            {/* 3 Main Hollow Rings */}
            <circle
              cx="37"
              cy="84"
              r="11.5"
              stroke="url(#hudSilverMain)"
              strokeWidth="7.5"
            />
            <circle
              cx="63"
              cy="62"
              r="11.5"
              stroke="url(#hudSilverMain)"
              strokeWidth="7.5"
            />
            <circle
              cx="90"
              cy="40"
              r="11.5"
              stroke="url(#hudSilverMain)"
              strokeWidth="7.5"
            />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold tracking-wide bg-gradient-to-b from-white via-[#f5f5f7] to-[#a1a1a6] bg-clip-text text-transparent">
              ChainAnalysis
            </span>
            <span className="rounded bg-[#2c2c2e] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#e5e5ea] border border-[#8e8e93]/35">
              {project.archBits}-bit
            </span>
          </div>
          <div className="max-w-[200px] truncate font-mono text-[10px] text-slate-400">
            {project.projectName}
          </div>
        </div>

        <button
          type="button"
          title="切换或加载本地嵌入式 C/C++ 仓库目录"
          onClick={() => setOpenProjectModalOpen(true)}
          className="ml-1 inline-flex items-center gap-1 rounded-lg border border-slate-300/12 bg-[#1a2333] px-2.5 py-1 text-[11px] font-medium text-[#cbd5e1] hover:border-[#7b9acc]/45 hover:text-white transition-colors cursor-pointer"
        >
          <FolderOpen className="h-3.5 w-3.5 text-[#7b9acc]" />
          切换工程
        </button>
      </div>

      {/* Center: Calm View Switcher & Compact Telemetry */}
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-slate-300/10 bg-[#141b26]/95 px-3 py-1.5 backdrop-blur-xl shadow-[0_8px_28px_rgba(0,0,0,0.32)]">
        {/* 4-Way Understanding View Switcher */}
        <div className="flex items-center rounded-xl bg-[#0e131a] p-0.5 border border-slate-300/10">
          <button
            type="button"
            onClick={() => setViewMode("STORY")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
              viewMode === "STORY"
                ? "bg-[#7b9acc]/20 text-[#d0e0f7] border border-[#7b9acc]/45"
                : "text-[#8b98a9] hover:text-[#dce4ee] border border-transparent"
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            功能导览
          </button>
          <button
            type="button"
            onClick={() => setViewMode("CANVAS")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
              viewMode === "CANVAS"
                ? "bg-[#7b9acc]/20 text-[#d0e0f7] border border-[#7b9acc]/45"
                : "text-[#8b98a9] hover:text-[#dce4ee] border border-transparent"
            }`}
          >
            <Network className="h-3.5 w-3.5" />
            调用图谱
          </button>
          <button
            type="button"
            onClick={() => setViewMode("SWIMLANE")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
              viewMode === "SWIMLANE"
                ? "bg-[#69ad99]/20 text-[#bce3d6] border border-[#69ad99]/40"
                : "text-[#8b98a9] hover:text-[#dce4ee] border border-transparent"
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            架构分层
          </button>
          <button
            type="button"
            onClick={() => setViewMode("SEQUENCE")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
              viewMode === "SEQUENCE"
                ? "bg-[#d2a266]/20 text-[#edd0a8] border border-[#d2a266]/40"
                : "text-[#8b98a9] hover:text-[#dce4ee] border border-transparent"
            }`}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            时序链路
          </button>
        </div>

        <div className="mx-0.5 h-5 w-px bg-slate-300/10" />

        {/* Runtime Requirement Pill */}
        {stackMetrics.runtimeReq === "BARE_METAL_READY" ? (
          <div
            title="该功能链路未调用任何 RTOS 线程/信号量/队列 API"
            className="hidden lg:flex items-center gap-1.5 rounded-lg border border-[#69ad99]/30 bg-[#69ad99]/10 px-2 py-1 text-[11px] font-medium text-[#95c9b9]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#69ad99]" />
            裸机可用
          </div>
        ) : (
          <div
            title={`该功能调用了 OS 原语: ${stackMetrics.osApisUsed.join(", ")}`}
            className="hidden lg:flex items-center gap-1.5 rounded-lg border border-[#7b9acc]/30 bg-[#7b9acc]/10 px-2 py-1 text-[11px] font-medium text-[#a9c2eb]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#7b9acc]" />
            需 RTOS
          </div>
        )}

        {/* Depth */}
        <div className="hidden md:flex items-center gap-1.5 rounded-lg bg-[#101620] px-2 py-1 text-[11px] text-[#9aa7b8] border border-slate-300/[0.06]">
          <span className="text-[#6f7e92]">深度</span>
          <span className="font-mono font-semibold text-[#dce4ee]">
            {stackMetrics.maxDepth} 层
          </span>
        </div>

        {/* WCS Stack */}
        <div
          title={`${stackMetrics.budgetSourceLabel} | 峰值栈深 ~${stackMetrics.maxStackBytes}B (${stackMetrics.budgetUsagePercent}%)`}
          className={`hidden xl:flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium ${riskColor}`}
        >
          <Flame className="h-3 w-3" />
          <span className="font-mono font-semibold">
            ~{formatBytes(stackMetrics.maxStackBytes)}
          </span>
          <span className="rounded bg-black/25 px-1 font-mono text-[10px]">
            {stackMetrics.budgetUsagePercent}%
          </span>
        </div>

        {/* Static RAM */}
        <div className="hidden 2xl:flex items-center gap-1.5 rounded-lg bg-[#101620] px-2 py-1 text-[11px] text-[#9aa7b8] border border-slate-300/[0.06]">
          <Cpu className="h-3 w-3 text-[#859ce0]" />
          <span className="font-mono font-semibold text-[#b8c6ef]">
            {formatBytes(porting.totalStaticRamBytes)}
          </span>
        </div>

        {stackMetrics.hasRecursion && (
          <div className="flex items-center gap-1 rounded-lg border border-[#9e8bc7]/40 bg-[#9e8bc7]/15 px-2 py-1 text-[11px] font-medium text-[#d2c6ed]">
            <RefreshCw className="h-3 w-3" /> 递归
          </div>
        )}

        {/* Stack Heatmap Toggle (only relevant in graph views) */}
        {(viewMode === "CANVAS" || viewMode === "SWIMLANE") && (
          <button
            type="button"
            onClick={toggleHeatmap}
            className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-all cursor-pointer ${
              heatmapEnabled
                ? "bg-[#c9858d]/20 text-[#e8b4ba] border border-[#c9858d]/45"
                : "bg-[#101620] text-[#8b98a9] border border-slate-300/10 hover:border-[#c9858d]/35 hover:text-[#dce4ee]"
            }`}
            title="高亮显示最坏情况最大栈深(WCS)调用路径"
          >
            <Flame className="h-3 w-3" />
            栈热力
          </button>
        )}

        {hasOverrides && (
          <button
            type="button"
            onClick={resetLayerOverrides}
            title="重置手动拖拽修改的架构泳道归属"
            className="inline-flex items-center gap-1 rounded-lg border border-[#d2a266]/35 bg-[#d2a266]/12 px-2 py-1 text-[11px] font-medium text-[#e0be92] hover:bg-[#d2a266]/20 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" /> 重置分层
          </button>
        )}
      </div>

      {/* Right: Offline Analysis Notes & Drawer Toggle */}
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAiPromptModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300/12 bg-[#141b26]/95 px-3 py-2 text-xs font-medium text-[#cbd5e1] backdrop-blur-xl hover:border-[#7b9acc]/45 hover:text-white shadow-md transition-colors cursor-pointer"
          title="离线导出当前功能的 Markdown 调用链与框架摘要笔记"
        >
          <FileText className="h-3.5 w-3.5 text-[#7b9acc]" />
          导出分析笔记
        </button>

        {rightDrawerLayout === "DETACHED" ? (
          <button
            type="button"
            onClick={() => {
              setRightDrawerLayout("SPLIT");
              setRightDrawerOpen(true);
              if (isTauriDesktop()) {
                invoke("close_standalone_drawer").catch(() => {});
              }
            }}
            className="inline-flex items-center gap-1 rounded-xl border border-[#7b9acc]/45 bg-[#7b9acc]/18 px-2.5 py-2 text-xs font-medium text-[#d0e0f7] backdrop-blur-xl hover:bg-[#7b9acc]/28 shadow-md cursor-pointer"
            title="右侧面板已独立成窗，点击召回至主窗口分屏"
          >
            ↙ 召回右侧栏
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setRightDrawerOpen(!rightDrawerOpen)}
            className="inline-flex items-center justify-center rounded-xl border border-slate-300/12 bg-[#141b26]/95 p-2 text-[#9aa7b8] backdrop-blur-xl hover:border-[#7b9acc]/45 hover:text-white shadow-md transition-colors cursor-pointer"
            title={rightDrawerOpen ? "收起右侧分析面板" : "展开右侧分析面板"}
          >
            {rightDrawerOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </header>
  );
};
