import React from "react";
import {
  Cpu,
  Flame,
  FolderOpen,
  GitCommitHorizontal,
  Layers,
  Network,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
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
      ? "text-red-300 border-red-500/50 bg-red-500/15"
      : stackMetrics.rtosOverflowRisk === "WARNING"
      ? "text-amber-300 border-amber-500/50 bg-amber-500/15"
      : "text-emerald-300 border-emerald-500/40 bg-emerald-500/15";

  return (
    <header className="pointer-events-none absolute top-3 left-3 right-3 z-30 flex items-center justify-between gap-3">
      {/* Left: Brand + Project pill (Apple Space-Black & Metallic Silver Chain-Node Emblem) */}
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-2xl border border-white/15 bg-slate-950/85 px-3.5 py-2 backdrop-blur-xl shadow-2xl">
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
          className="ml-1 inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-cyan-400/50 hover:text-white transition-colors"
        >
          <FolderOpen className="h-3.5 w-3.5 text-cyan-400" />
          切换工程
        </button>
      </div>

      {/* Center: Telemetry & View Switcher */}
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/85 px-3 py-1.5 backdrop-blur-xl shadow-2xl">
        {/* Runtime Requirement Pill: Bare-Metal vs RTOS */}
        {stackMetrics.runtimeReq === "BARE_METAL_READY" ? (
          <div
            title="该功能链路未调用任何 RTOS 线程/信号量/队列 API，可直接移植到纯裸机工程！"
            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            裸机可用 (0 OS)
          </div>
        ) : (
          <div
            title={`该功能调用了 OS 原语: ${stackMetrics.osApisUsed.join(", ")}`}
            className="flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-300"
          >
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            需 OSAL/RTOS
          </div>
        )}

        {/* Depth */}
        <div className="flex items-center gap-1.5 rounded-lg bg-slate-900/90 px-2.5 py-1 text-[11px] text-slate-300 border border-white/5">
          <span className="text-slate-500">深度</span>
          <span className="font-mono font-bold text-slate-100">
            {stackMetrics.maxDepth} 层
          </span>
        </div>

        {/* WCS Stack */}
        <div
          title={`${stackMetrics.budgetSourceLabel} | 峰值栈深 ~${stackMetrics.maxStackBytes}B (${stackMetrics.budgetUsagePercent}%)`}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium ${riskColor}`}
        >
          <Flame className="h-3.5 w-3.5" />
          <span>
            {stackMetrics.stackKind === "MSP_BARE_METAL"
              ? "裸机栈深(MSP)"
              : "线程栈深(PSP)"}
          </span>
          <span className="font-mono font-bold">
            ~{formatBytes(stackMetrics.maxStackBytes)}
          </span>
          <span className="rounded bg-black/30 px-1 py-0.2 font-mono text-[10px]">
            {stackMetrics.budgetUsagePercent}%
          </span>
        </div>

        {/* Static RAM */}
        <div className="hidden xl:flex items-center gap-1.5 rounded-lg bg-slate-900/90 px-2.5 py-1 text-[11px] text-slate-300 border border-white/5">
          <Cpu className="h-3.5 w-3.5 text-indigo-400" />
          <span className="text-slate-500">静态RAM</span>
          <span className="font-mono font-bold text-indigo-200">
            {formatBytes(porting.totalStaticRamBytes)}
          </span>
        </div>

        {/* Recursion alert */}
        {stackMetrics.hasRecursion && (
          <div className="flex items-center gap-1 rounded-lg border border-purple-400/60 bg-purple-500/20 px-2 py-1 text-[11px] font-semibold text-purple-200 animate-pulse">
            <RefreshCw className="h-3.5 w-3.5" /> 递归风险
          </div>
        )}

        <div className="mx-1 h-5 w-px bg-white/10" />

        {/* Stack Heatmap Toggle */}
        <button
          type="button"
          onClick={toggleHeatmap}
          className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-all ${
            heatmapEnabled
              ? "bg-red-500/25 text-red-200 border border-red-500/60 shadow-[0_0_16px_rgba(239,68,68,0.35)]"
              : "bg-slate-900/80 text-slate-300 border border-white/10 hover:border-red-400/40 hover:text-red-200"
          }`}
          title="高亮显示最坏情况最大栈深(WCS)调用路径"
        >
          <Flame className={`h-3.5 w-3.5 ${heatmapEnabled ? "text-red-400" : "text-slate-400"}`} />
          栈深热力图
        </button>

        {/* Plan 2 <-> Plan 3 <-> Sequence Segmented View Switch */}
        <div className="flex items-center rounded-xl bg-slate-900/90 p-0.5 border border-white/10">
          <button
            type="button"
            onClick={() => setViewMode("CANVAS")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
              viewMode === "CANVAS"
                ? "bg-cyan-500/25 text-cyan-200 border border-cyan-400/50 shadow-sm"
                : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            <Network className="h-3.5 w-3.5" />
            无界画布
          </button>
          <button
            type="button"
            onClick={() => setViewMode("SWIMLANE")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
              viewMode === "SWIMLANE"
                ? "bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 shadow-sm"
                : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            四层泳道(移植)
          </button>
          <button
            type="button"
            onClick={() => setViewMode("SEQUENCE")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
              viewMode === "SEQUENCE"
                ? "bg-amber-500/25 text-amber-200 border border-amber-400/50 shadow-sm"
                : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            时序生命线
          </button>
        </div>

        {hasOverrides && (
          <button
            type="button"
            onClick={resetLayerOverrides}
            title="重置手动拖拽修改的架构泳道归属"
            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
          >
            <RotateCcw className="h-3 w-3" /> 重置分层
          </button>
        )}
      </div>

      {/* Right: AI Prompt & Drawer Toggle */}
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAiPromptModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-400/40 bg-indigo-600/25 px-3 py-2 text-xs font-semibold text-indigo-100 backdrop-blur-xl hover:bg-indigo-600/40 shadow-lg transition-colors"
          title="免 API Key：一键导出当前功能精简调用链与移植上下文给免费网页 AI"
        >
          <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
          导出 AI Prompt
        </button>

        {rightDrawerLayout === "DETACHED" ? (
          <button
            type="button"
            onClick={() => {
              setRightDrawerLayout("SPLIT");
              setRightDrawerOpen(true);
            }}
            className="inline-flex items-center gap-1 rounded-xl border border-cyan-400/50 bg-cyan-500/20 px-2.5 py-2 text-xs font-bold text-cyan-200 backdrop-blur-xl hover:bg-cyan-500/30 shadow-lg"
            title="右侧面板已独立成窗，点击召回至主窗口分屏"
          >
            ↙ 召回右侧栏
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setRightDrawerOpen(!rightDrawerOpen)}
            className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-slate-950/80 p-2 text-slate-300 backdrop-blur-xl hover:border-cyan-400/40 hover:text-white shadow-lg transition-colors"
            title={rightDrawerOpen ? "收起右侧分析面板（全屏画布）" : "展开右侧分析面板"}
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
