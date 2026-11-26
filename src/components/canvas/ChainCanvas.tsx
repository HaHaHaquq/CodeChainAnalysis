import React, { useEffect, useMemo, useCallback } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { SmartFunctionNode } from "./SmartFunctionNode";
import { SwimlaneBandNode } from "./SwimlaneBandNode";
import { InteractiveCallEdge } from "./InteractiveCallEdge";
import { useChainStore } from "../../store/useChainStore";
import {
  buildReactFlowGraph,
  detectLayerFromY,
  SWIMLANE_META,
} from "../../utils/layoutEngine";
import { StackMetricsResult } from "../../types/analysis";

const nodeTypes = {
  smartFunction: SmartFunctionNode,
  swimlaneBand: SwimlaneBandNode,
};

const edgeTypes = {
  interactiveCall: InteractiveCallEdge,
};

interface ChainCanvasInnerProps {
  stackMetrics: StackMetricsResult;
}

const ChainCanvasInner: React.FC<ChainCanvasInnerProps> = ({ stackMetrics }) => {
  const project = useChainStore((s) => s.project);
  const activeEntryId = useChainStore((s) => s.activeEntryId);
  const viewMode = useChainStore((s) => s.viewMode);
  const heatmapEnabled = useChainStore((s) => s.heatmapEnabled);
  const showBindEdges = useChainStore((s) => s.showBindEdges);
  const toggleShowBindEdges = useChainStore((s) => s.toggleShowBindEdges);
  const selectedNodeId = useChainStore((s) => s.selectedNodeId);
  const selectedEdgeId = useChainStore((s) => s.selectedEdgeId);
  const selectEdge = useChainStore((s) => s.selectEdge);
  const expandedSnippetIds = useChainStore((s) => s.expandedSnippetIds);
  const collapsedSubtreeIds = useChainStore((s) => s.collapsedSubtreeIds);
  const layerOverrides = useChainStore((s) => s.layerOverrides);
  const setNodeLayerOverride = useChainStore((s) => s.setNodeLayerOverride);

  const { fitView } = useReactFlow();

  const activeEntry = useMemo(
    () => project.entries.find((e) => e.id === activeEntryId) ?? project.entries[0],
    [project.entries, activeEntryId]
  );

  const computed = useMemo(
    () =>
      buildReactFlowGraph({
        entry: activeEntry,
        allNodes: project.nodes,
        allEdges: project.edges,
        viewMode,
        heatmapEnabled,
        showBindEdges,
        selectedNodeId,
        selectedEdgeId,
        expandedSnippetIds,
        collapsedSubtreeIds,
        layerOverrides,
        stackMetrics,
      }),
    [
      activeEntry,
      project.nodes,
      project.edges,
      viewMode,
      heatmapEnabled,
      showBindEdges,
      selectedNodeId,
      selectedEdgeId,
      expandedSnippetIds,
      collapsedSubtreeIds,
      layerOverrides,
      stackMetrics,
    ]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(computed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computed.edges);

  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed.nodes, computed.edges, setNodes, setEdges]);

  // Smooth fitView when switching entry or viewMode
  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: 0.16, duration: 420 });
    }, 60);
    return () => clearTimeout(timer);
  }, [activeEntryId, viewMode, fitView]);

  // In SWIMLANE mode, dragging a function card vertically snaps it to the target architectural layer!
  const handleNodeDragStop = useCallback(
    (_event: React.MouseEvent | MouseEvent | TouchEvent, draggedNode: Node) => {
      if (viewMode !== "SWIMLANE") return;
      if (draggedNode.type !== "smartFunction") return;
      const newLayer = detectLayerFromY(draggedNode.position.y + 60);
      const currentLayer =
        layerOverrides[draggedNode.id] ?? project.nodes[draggedNode.id]?.layer;
      if (newLayer !== currentLayer) {
        setNodeLayerOverride(draggedNode.id, newLayer);
      }
    },
    [viewMode, layerOverrides, project.nodes, setNodeLayerOverride]
  );

  return (
    <div className="h-full w-full relative bg-[#0e131a]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={() => selectEdge(null, false)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.22}
        maxZoom={1.75}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.1}
          color="#1d2736"
        />
        <Controls position="bottom-left" className="!mb-4 !ml-4" />
        <MiniMap
          position="bottom-left"
          className="!mb-4 !ml-16 !h-28 !w-44"
          maskColor="rgba(14, 19, 26, 0.72)"
          nodeColor={(n) => {
            if (n.type === "swimlaneBand") return "transparent";
            const layer =
              layerOverrides[n.id] ?? project.nodes[n.id]?.layer ?? "CORE";
            return SWIMLANE_META[layer].accentColor;
          }}
        />
      </ReactFlow>

      {/* Bottom Interactive Legend & Bind-Edge Filter Pill (Morandi-Slate) */}
      <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-full border border-slate-300/12 bg-[#141b26]/92 px-4 py-1.5 text-[11px] text-[#9aa7b8] backdrop-blur-xl shadow-lg">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-[#62748c]" /> 直接调用
        </span>
        <span className="inline-flex items-center gap-1.5 text-[#9ed0dc]">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-[#68a8b8]" /> 指针绑定
        </span>
        <span className="inline-flex items-center gap-1.5 text-[#e6c494]">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-[#d2a266]" /> 异步回调
        </span>
        <span className="inline-flex items-center gap-1.5 text-[#d2c6ed]">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-[#a58cc9]" /> __weak
        </span>
        <span className="border-l border-slate-300/12 pl-3 text-[#7c8a9e]">
          单击连线可查看分支条件与调用现场源码
        </span>
        <button
          type="button"
          onClick={toggleShowBindEdges}
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
            showBindEdges
              ? "border-[#68a8b8]/40 bg-[#68a8b8]/14 text-[#b4dae3] hover:bg-[#68a8b8]/22"
              : "border-slate-300/12 bg-[#101620] text-[#7c8a9e] hover:text-[#dce4ee]"
          }`}
          title="切换显示/隐藏仅赋值绑定函数指针的边，让主干执行流更清爽"
        >
          {showBindEdges ? "✓ 显示指针绑定边" : "已隐藏指针绑定边"}
        </button>
      </div>
    </div>
  );
};

export const ChainCanvas: React.FC<ChainCanvasInnerProps> = (props) => (
  <ReactFlowProvider>
    <ChainCanvasInner {...props} />
  </ReactFlowProvider>
);
