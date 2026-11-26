import React, { memo } from "react";
import { Handle, NodeProps, Position } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  Flame,
  GitBranch,
  Globe,
  RefreshCw,
  Zap,
} from "lucide-react";
import { SmartNodePayload, SWIMLANE_META } from "../../utils/layoutEngine";
import { LARGE_STACK_THRESHOLD } from "../../utils/graphMetrics";
import { useChainStore } from "../../store/useChainStore";

export const SmartFunctionNode: React.FC<NodeProps> = memo(({ data }) => {
  const payload = data as unknown as SmartNodePayload;
  const {
    fn,
    effectiveLayer,
    isEntry,
    isSelected,
    isExpandedSnippet,
    isCollapsedSubtree,
    childCount,
    isOnCriticalStackPath,
    isRecursionNode,
    heatmapEnabled,
    viewMode,
  } = payload;

  const selectNode = useChainStore((s) => s.selectNode);
  const toggleSnippet = useChainStore((s) => s.toggleSnippet);
  const toggleCollapseSubtree = useChainStore((s) => s.toggleCollapseSubtree);

  const meta = SWIMLANE_META[effectiveLayer];
  const isLargeStack =
    fn.stackBytes >= LARGE_STACK_THRESHOLD || (fn.stackWarnings && fn.stackWarnings.length > 0);
  const isDimmed = heatmapEnabled && !isOnCriticalStackPath && !isRecursionNode;

  const globalCount = new Set([...fn.readsGlobals, ...fn.writesGlobals]).size;

  const borderStyle = isRecursionNode
    ? "border-[#a58cc9]/70 shadow-[0_6px_20px_rgba(165,140,201,0.18)]"
    : heatmapEnabled && isOnCriticalStackPath
    ? "border-[#c9858d]/80 shadow-[0_6px_20px_rgba(201,133,141,0.2)]"
    : isSelected
    ? "border-[#7b9acc]/80 shadow-[0_6px_22px_rgba(123,154,204,0.22)]"
    : isLargeStack
    ? "border-[#d2a266]/55"
    : "border-slate-300/12 hover:border-slate-300/28";

  const sourcePos = viewMode === "SWIMLANE" ? Position.Bottom : Position.Right;
  const targetPos = viewMode === "SWIMLANE" ? Position.Top : Position.Left;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectNode(fn.id, false);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        selectNode(fn.id, true);
      }}
      style={{ width: 286, opacity: isDimmed ? 0.34 : 1 }}
      className={`group relative rounded-xl border bg-[#141b26]/95 backdrop-blur-md transition-all duration-200 select-none ${borderStyle}`}
    >
      {/* Top accent bar */}
      <div
        className="h-[3px] w-full rounded-t-[11px]"
        style={{
          backgroundColor: isRecursionNode
            ? "#a58cc9"
            : heatmapEnabled && isOnCriticalStackPath
            ? "#c9858d"
            : meta.accentColor,
        }}
      />

      <Handle
        type="target"
        position={targetPos}
        className="!h-2 !w-2 !border-2 !border-[#141b26] !bg-[#7b9acc]"
      />
      <Handle
        type="source"
        position={sourcePos}
        className="!h-2 !w-2 !border-2 !border-[#141b26] !bg-[#69ad99]"
      />

      {/* Card Body */}
      <div className="p-3">
        {/* Header Row: Layer badge + File:line + quick actions */}
        <div className="mb-1.5 flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider"
              style={{
                backgroundColor: `${meta.accentColor}22`,
                color: meta.accentColor,
                border: `1px solid ${meta.accentColor}50`,
              }}
            >
              {meta.badge}
            </span>
            {isEntry && (
              <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-500/40">
                ENTRY
              </span>
            )}
            {fn.isIsr && (
              <span className="inline-flex items-center gap-0.5 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300 border border-rose-500/40">
                <Zap className="h-2.5 w-2.5" /> ISR
              </span>
            )}
            {fn.isCallback && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/40">
                CB
              </span>
            )}
            {fn.isExternal && (
              <span className="rounded bg-slate-700/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                EXT
              </span>
            )}
          </div>

          <button
            type="button"
            title={isExpandedSnippet ? "收起内嵌代码切片" : "原地展开核心代码切片"}
            onClick={(e) => {
              e.stopPropagation();
              toggleSnippet(fn.id);
            }}
            className={`nodrag rounded-md p-1 transition-colors ${
              isExpandedSnippet
                ? "bg-cyan-500/25 text-cyan-300"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Function Name */}
        <div className="truncate font-mono text-[13px] font-bold text-slate-100 tracking-tight">
          {fn.name}
          <span className="text-slate-500 font-normal">()</span>
        </div>

        {/* File location */}
        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
          {fn.file}:{fn.lineStart}
        </div>

        {/* Brief (expands to full text when card is selected or snippet is open; also shows full text on hover) */}
        <p
          title={fn.brief}
          className={`mt-1.5 text-[11px] leading-relaxed text-slate-300/90 ${
            isSelected || isExpandedSnippet ? "" : "line-clamp-2"
          }`}
        >
          {fn.brief}
        </p>

        {/* Inline Code Snippet (Expanded State - Plan 2 hallmark) */}
        {isExpandedSnippet && (
          <div className="nodrag nowheel mt-2.5 overflow-hidden rounded-lg border border-slate-700/70 bg-[#070b14]">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-2 py-1 text-[10px] text-slate-400">
              <span>核心代码切片 (双击卡片看完整源码)</span>
              <span className="font-mono text-cyan-400">C</span>
            </div>
            <pre className="max-h-[112px] overflow-auto p-2 font-mono text-[10px] leading-[1.45] text-cyan-100/90">
              <code>{fn.snippet}</code>
            </pre>
          </div>
        )}

        {/* Footer Badges: Stack Footprint, Globals, Warnings, Subtree Toggle */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-800/90 pt-2">
          <div className="flex flex-wrap items-center gap-1">
            {/* Stack Frame Size Badge */}
            <span
              title={
                fn.stackWarnings?.join("；") ||
                `静态估算本地栈帧消耗约 ${fn.stackBytes} Bytes`
              }
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                isLargeStack
                  ? "bg-[#c9858d]/15 text-[#e3a8af] border border-[#c9858d]/35"
                  : "bg-[#69ad99]/12 text-[#95c9b9] border border-[#69ad99]/25"
              }`}
            >
              {isLargeStack ? (
                <Flame className="h-3 w-3 text-[#c9858d]" />
              ) : (
                <Cpu className="h-3 w-3 text-[#69ad99]" />
              )}
              ~{fn.stackBytes}B
            </span>

            {isRecursionNode && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-purple-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-purple-200 border border-purple-400/50">
                <RefreshCw className="h-2.5 w-2.5" /> 递归
              </span>
            )}

            {fn.callsHeap && (
              <span className="rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/40">
                Heap
              </span>
            )}

            {fn.hasStateMachine && (
              <span
                title="包含 switch-case 状态机"
                className="inline-flex items-center gap-0.5 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300"
              >
                <GitBranch className="h-2.5 w-2.5" /> FSM
              </span>
            )}

            {globalCount > 0 && (
              <span
                title={`关联 ${globalCount} 个全局/静态变量`}
                className="inline-flex items-center gap-0.5 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300"
              >
                <Globe className="h-2.5 w-2.5 text-slate-400" /> {globalCount}
              </span>
            )}
          </div>

          {childCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapseSubtree(fn.id);
              }}
              className="nodrag inline-flex items-center gap-0.5 rounded-md bg-slate-800/90 px-1.5 py-0.5 text-[10px] font-medium text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
              title={isCollapsedSubtree ? "展开下级调用链" : "折叠下级调用链"}
            >
              {isCollapsedSubtree ? (
                <>
                  <ChevronRight className="h-3 w-3 text-cyan-400" /> +{childCount}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3 text-slate-400" /> {childCount}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

SmartFunctionNode.displayName = "SmartFunctionNode";
