import React, { useMemo } from "react";
import {
  ArrowRight,
  Cpu,
  Flame,
  GitCommitHorizontal,
  Layers,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
import {
  ArchLayer,
  CallEdgeData,
  FeatureEntry,
  StackMetricsResult,
} from "../../types/analysis";
import { SWIMLANE_META, SWIMLANE_ORDER } from "../../utils/layoutEngine";

interface SequenceTimelineViewProps {
  activeEntry: FeatureEntry;
  stackMetrics: StackMetricsResult;
}

interface SequenceHop {
  stepNumber: number;
  edge: CallEdgeData;
  fromLayer: ArchLayer;
  toLayer: ArchLayer;
  sourceName: string;
  targetName: string;
  sourceFileLine: string;
  targetStackBytes: number;
  cumulativeStackBytes: number;
  isCriticalEdge: boolean;
  isRecursionEdge: boolean;
  note: string;
}

export const SequenceTimelineView: React.FC<SequenceTimelineViewProps> = ({
  activeEntry,
  stackMetrics,
}) => {
  const project = useChainStore((s) => s.project);
  const selectedNodeId = useChainStore((s) => s.selectedNodeId);
  const selectNode = useChainStore((s) => s.selectNode);
  const layerOverrides = useChainStore((s) => s.layerOverrides);
  const heatmapEnabled = useChainStore((s) => s.heatmapEnabled);

  const getLayer = (nodeId: string): ArchLayer =>
    layerOverrides[nodeId] ?? project.nodes[nodeId]?.layer ?? "CORE";

  // Build ordered execution trace hops by DFS traversal from entry root
  const hops = useMemo<SequenceHop[]>(() => {
    const nodeSet = new Set(activeEntry.nodeIds);
    const subEdges = project.edges.filter(
      (e) =>
        activeEntry.edgeIds.includes(e.id) &&
        nodeSet.has(e.source) &&
        nodeSet.has(e.target)
    );

    const adj = new Map<string, CallEdgeData[]>();
    for (const id of activeEntry.nodeIds) adj.set(id, []);
    for (const e of subEdges) adj.get(e.source)?.push(e);

    const criticalEdgeSet = new Set(stackMetrics.criticalPathEdgeIds);
    const recursionEdgeSet = new Set(stackMetrics.recursionEdgeIds);

    const result: SequenceHop[] = [];
    const visitedEdges = new Set<string>();
    const activeStackNodes = new Set<string>();

    const rootNode = project.nodes[activeEntry.entryNodeId];
    const rootStack = rootNode?.stackBytes ?? 32;

    const dfs = (u: string, currentCumStack: number) => {
      activeStackNodes.add(u);
      for (const e of adj.get(u) ?? []) {
        if (visitedEdges.has(e.id)) continue;
        visitedEdges.add(e.id);

        const srcNode = project.nodes[e.source];
        const tgtNode = project.nodes[e.target];
        if (!srcNode || !tgtNode) continue;

        const nextCumStack = currentCumStack + tgtNode.stackBytes;
        result.push({
          stepNumber: result.length + 1,
          edge: e,
          fromLayer: getLayer(e.source),
          toLayer: getLayer(e.target),
          sourceName: srcNode.name,
          targetName: tgtNode.name,
          sourceFileLine: `${srcNode.file}:${e.callSiteLine || srcNode.lineStart}`,
          targetStackBytes: tgtNode.stackBytes,
          cumulativeStackBytes: nextCumStack,
          isCriticalEdge: criticalEdgeSet.has(e.id),
          isRecursionEdge:
            recursionEdgeSet.has(e.id) || activeStackNodes.has(e.target),
          note: tgtNode.brief,
        });

        if (!activeStackNodes.has(e.target)) {
          dfs(e.target, nextCumStack);
        }
      }
      activeStackNodes.delete(u);
    };

    if (nodeSet.has(activeEntry.entryNodeId)) {
      dfs(activeEntry.entryNodeId, rootStack);
    }

    // Also include any unvisited ISR / async trigger roots in the feature
    for (const e of subEdges) {
      if (!visitedEdges.has(e.id)) {
        const srcNode = project.nodes[e.source];
        const tgtNode = project.nodes[e.target];
        if (!srcNode || !tgtNode) continue;
        visitedEdges.add(e.id);
        result.push({
          stepNumber: result.length + 1,
          edge: e,
          fromLayer: getLayer(e.source),
          toLayer: getLayer(e.target),
          sourceName: srcNode.name,
          targetName: tgtNode.name,
          sourceFileLine: `${srcNode.file}:${e.callSiteLine || srcNode.lineStart}`,
          targetStackBytes: tgtNode.stackBytes,
          cumulativeStackBytes: srcNode.stackBytes + tgtNode.stackBytes,
          isCriticalEdge: criticalEdgeSet.has(e.id),
          isRecursionEdge: recursionEdgeSet.has(e.id),
          note: tgtNode.brief,
        });
      }
    }

    return result;
  }, [activeEntry, project.edges, project.nodes, layerOverrides, stackMetrics]);

  return (
    <div className="h-full w-full overflow-auto bg-[#070b13] pt-20 pb-16 px-8">
      <div className="mx-auto max-w-5xl rounded-2xl border border-white/10 bg-slate-950/85 backdrop-blur-xl shadow-2xl overflow-hidden">
        {/* Header Banner */}
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/70 px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">
                跨层执行时序与回调生命线视图 · {activeEntry.displayName}
              </span>
              <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-cyan-300 border border-cyan-500/30">
                共 {hops.length} 步调用/回调交互
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              从左至右对应 L1 应用层 ➔ L2 核心协议层 ➔ L3 事件与回调总线 ➔ L4 硬件抽象与移植边界；右侧实时显示每一步压栈后的累计栈深水位。
            </p>
          </div>
          <div className="text-right font-mono text-xs">
            <div className="text-slate-400">入口根栈帧</div>
            <div className="font-bold text-cyan-300">
              {activeEntry.entryNodeId}() (~
              {project.nodes[activeEntry.entryNodeId]?.stackBytes ?? 0}B)
            </div>
          </div>
        </div>

        {/* 4 Lifeline Column Headers */}
        <div className="grid grid-cols-12 border-b border-white/10 bg-slate-900/40 px-6 py-3">
          <div className="col-span-8 grid grid-cols-4 gap-3">
            {SWIMLANE_ORDER.map((layer) => {
              const meta = SWIMLANE_META[layer];
              return (
                <div
                  key={layer}
                  className="rounded-xl border px-3 py-2 text-center"
                  style={{
                    backgroundColor: `${meta.accentColor}12`,
                    borderColor: `${meta.accentColor}45`,
                  }}
                >
                  <div
                    className="text-xs font-bold"
                    style={{ color: meta.accentColor }}
                  >
                    {meta.badge} 层
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-400">
                    {layer === "APP"
                      ? "应用/命令入口"
                      : layer === "CORE"
                      ? "核心协议 (必拷)"
                      : layer === "CALLBACK"
                      ? "事件与回调总线"
                      : "HAL/DCD/OS (需移植)"}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="col-span-4 pl-5 flex items-center justify-between text-xs font-bold text-slate-300">
            <span>函数调用详情 & 触发语义</span>
            <span>累计栈深水位</span>
          </div>
        </div>

        {/* Sequence Hops Rows */}
        <div className="divide-y divide-white/5">
          {hops.map((hop) => {
            const fromIdx = SWIMLANE_ORDER.indexOf(hop.fromLayer);
            const toIdx = SWIMLANE_ORDER.indexOf(hop.toLayer);
            const minCol = Math.min(fromIdx, toIdx);
            const maxCol = Math.max(fromIdx, toIdx);
            const isReverseCallback = toIdx < fromIdx;
            const isSameLayer = fromIdx === toIdx;

            const isSelected =
              selectedNodeId === hop.edge.target ||
              selectedNodeId === hop.edge.source;
            const isHighlightedCritical =
              heatmapEnabled && hop.isCriticalEdge;

            const strokeColor = hop.isRecursionEdge
              ? "#c084fc"
              : isHighlightedCritical
              ? "#ef4444"
              : hop.edge.kind === "ASYNC_CALLBACK"
              ? "#fb923c"
              : hop.edge.kind === "OPS_TABLE"
              ? "#22d3ee"
              : hop.edge.kind === "WEAK_OVERRIDE"
              ? "#a855f7"
              : "#94a3b8";

            // Center percentage of each of the 4 columns (12.5%, 37.5%, 62.5%, 87.5%)
            const leftPct = minCol * 25 + 12.5;
            const widthPct = Math.max(6, (maxCol - minCol) * 25);

            return (
              <div
                key={hop.edge.id}
                onClick={() => selectNode(hop.edge.target, true)}
                className={`grid grid-cols-12 items-center px-6 py-3 cursor-pointer transition-colors ${
                  isHighlightedCritical
                    ? "bg-red-950/25 hover:bg-red-950/40"
                    : isSelected
                    ? "bg-cyan-950/30"
                    : "hover:bg-slate-900/60"
                }`}
              >
                {/* Left 8 cols: Lifeline Graphic */}
                <div className="col-span-8 relative h-12">
                  {/* 4 vertical lifeline guide lines */}
                  <div className="absolute inset-0 grid grid-cols-4 gap-3 pointer-events-none">
                    {SWIMLANE_ORDER.map((layer) => (
                      <div
                        key={layer}
                        className="flex justify-center h-full"
                      >
                        <div className="h-full w-px border-l border-dashed border-slate-700/70" />
                      </div>
                    ))}
                  </div>

                  {/* Horizontal Call / Callback Arrow across lifelines */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center"
                    style={{
                      left: isSameLayer ? `${fromIdx * 25 + 6}%` : `${leftPct}%`,
                      width: isSameLayer ? "13%" : `${widthPct}%`,
                    }}
                  >
                    <div
                      className="mb-1 flex items-center gap-1 rounded px-1.5 py-0.2 font-mono text-[10px] font-bold whitespace-nowrap"
                      style={{
                        backgroundColor: "#0f172a",
                        color: strokeColor,
                        border: `1px solid ${strokeColor}60`,
                      }}
                    >
                      <span>#{hop.stepNumber}</span>
                      <span>
                        {hop.sourceName} ➔ {hop.targetName}()
                      </span>
                    </div>

                    <div className="relative w-full flex items-center">
                      {/* Source dot */}
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{
                          backgroundColor:
                            SWIMLANE_META[hop.fromLayer].accentColor,
                        }}
                      />
                      {/* Connecting bar */}
                      <div
                        className="h-0.5 flex-1"
                        style={{
                          backgroundColor:
                            hop.edge.kind === "DIRECT"
                              ? strokeColor
                              : "transparent",
                          borderTop:
                            hop.edge.kind !== "DIRECT"
                              ? `2px dashed ${strokeColor}`
                              : undefined,
                        }}
                      />
                      {/* Target dot / arrow direction indicator */}
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-slate-950"
                        style={{
                          backgroundColor:
                            SWIMLANE_META[hop.toLayer].accentColor,
                        }}
                      />
                    </div>

                    {isReverseCallback && (
                      <span className="mt-0.5 text-[9px] font-semibold text-amber-300">
                        ◀ 底层反向异步回调上抛
                      </span>
                    )}
                  </div>
                </div>

                {/* Right 4 cols: Metadata & Cumulative Stack Meter */}
                <div className="col-span-4 pl-5 flex items-center justify-between gap-3 border-l border-white/5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {hop.isRecursionEdge ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-bold text-purple-200 border border-purple-400/40">
                          <RefreshCw className="h-2.5 w-2.5" /> 递归调用
                        </span>
                      ) : hop.edge.kind === "ASYNC_CALLBACK" ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-orange-500/20 px-1.5 py-0.5 text-[9px] font-bold text-orange-300 border border-orange-400/40">
                          <Zap className="h-2.5 w-2.5" /> 异步回调
                        </span>
                      ) : hop.edge.kind === "OPS_TABLE" ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9px] font-bold text-cyan-300 border border-cyan-400/40">
                          <Layers className="h-2.5 w-2.5" /> 接口表Ops
                        </span>
                      ) : hop.edge.kind === "WEAK_OVERRIDE" ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-bold text-purple-300 border border-purple-400/40">
                          __WEAK 钩子
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-300">
                          <GitCommitHorizontal className="h-2.5 w-2.5" /> 直接调用
                        </span>
                      )}
                      <span className="truncate font-mono text-[10px] text-slate-400">
                        {hop.sourceFileLine}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-[11px] text-slate-300">
                      {hop.note}
                    </p>
                  </div>

                  <div className="shrink-0 text-right font-mono">
                    <div
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold ${
                        hop.isCriticalEdge && heatmapEnabled
                          ? "bg-red-500/25 text-red-200 border border-red-500/50"
                          : "bg-slate-900 text-emerald-300 border border-white/10"
                      }`}
                    >
                      {hop.isCriticalEdge && heatmapEnabled ? (
                        <Flame className="h-3 w-3 text-red-400" />
                      ) : (
                        <Cpu className="h-3 w-3 text-emerald-400" />
                      )}
                      {hop.cumulativeStackBytes}B
                    </div>
                    <div className="text-[9px] text-slate-400 mt-0.5">
                      (+{hop.targetStackBytes}B)
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
