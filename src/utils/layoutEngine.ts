import dagre from "@dagrejs/dagre";
import { Edge, MarkerType, Node } from "@xyflow/react";
import {
  ArchLayer,
  CallEdgeData,
  FeatureEntry,
  FunctionNodeData,
  StackMetricsResult,
  ViewMode,
} from "../types/analysis";

export const SWIMLANE_ORDER: ArchLayer[] = ["APP", "CORE", "CALLBACK", "HAL"];

export const SWIMLANE_META: Record<
  ArchLayer,
  {
    title: string;
    subtitle: string;
    badge: string;
    portingHint: string;
    accentColor: string;
    bgClass: string;
    borderClass: string;
  }
> = {
  APP: {
    title: "L1 · 应用与任务层 (Application)",
    subtitle: "RTOS Tasks / Main Loop / 顶层业务调度",
    badge: "APP",
    portingHint: "参考调用方式，按需接入新工程业务",
    accentColor: "#859ce0",
    bgClass: "bg-[#171f31]/40",
    borderClass: "border-[#859ce0]/20",
  },
  CORE: {
    title: "L2 · 核心模块与协议层 (Middleware / Core)",
    subtitle: "算法 / 状态机 / 协议解析 / 缓冲区",
    badge: "CORE",
    portingHint: "核心协议区（通常可整体复用）",
    accentColor: "#69ad99",
    bgClass: "bg-[#152424]/40",
    borderClass: "border-[#69ad99]/20",
  },
  CALLBACK: {
    title: "L3 · 事件与回调总线 (Callback / Event Bus)",
    subtitle: "异步回调 / __weak 钩子 / 命令表处理器",
    badge: "CALLBACK",
    portingHint: "异步解耦桥梁（确认回调注册与触发时序）",
    accentColor: "#d2a266",
    bgClass: "bg-[#241f18]/40",
    borderClass: "border-[#d2a266]/20",
  },
  HAL: {
    title: "L4 · 硬件抽象与驱动层 (HAL / BSP / OS)",
    subtitle: "芯片外设驱动 / 中断向量 / OS 原语",
    badge: "HAL",
    portingHint: "硬件适配边界（跨芯片需按板级调整）",
    accentColor: "#c9858d",
    bgClass: "bg-[#261a1f]/40",
    borderClass: "border-[#c9858d]/20",
  },
};

export const SWIMLANE_BAND_HEIGHT = 275;
export const SWIMLANE_BAND_GAP = 22;
export const SWIMLANE_START_Y = 20;

export function getSwimlaneY(index: number): number {
  return SWIMLANE_START_Y + index * (SWIMLANE_BAND_HEIGHT + SWIMLANE_BAND_GAP);
}

export function detectLayerFromY(y: number): ArchLayer {
  let closestLayer: ArchLayer = "CORE";
  let minDist = Infinity;
  SWIMLANE_ORDER.forEach((layer, idx) => {
    const centerY = getSwimlaneY(idx) + SWIMLANE_BAND_HEIGHT / 2;
    const dist = Math.abs(y - centerY);
    if (dist < minDist) {
      minDist = dist;
      closestLayer = layer;
    }
  });
  return closestLayer;
}

export interface SmartNodePayload extends Record<string, unknown> {
  fn: FunctionNodeData;
  effectiveLayer: ArchLayer;
  isEntry: boolean;
  isSelected: boolean;
  isExpandedSnippet: boolean;
  isCollapsedSubtree: boolean;
  childCount: number;
  isOnCriticalStackPath: boolean;
  isRecursionNode: boolean;
  heatmapEnabled: boolean;
  viewMode: ViewMode;
}

export interface SwimlaneBandPayload extends Record<string, unknown> {
  layer: ArchLayer;
  width: number;
  height: number;
  nodeCount: number;
}

interface BuildGraphParams {
  entry: FeatureEntry;
  allNodes: Record<string, FunctionNodeData>;
  allEdges: CallEdgeData[];
  viewMode: ViewMode;
  heatmapEnabled: boolean;
  showBindEdges: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  expandedSnippetIds: Record<string, boolean>;
  collapsedSubtreeIds: Record<string, boolean>;
  layerOverrides: Record<string, ArchLayer>;
  stackMetrics: StackMetricsResult;
}

export function computeUpstreamPathToNode(
  rootId: string,
  targetId: string,
  edges: CallEdgeData[]
): { nodeIds: string[]; edgeIds: string[] } {
  if (rootId === targetId) return { nodeIds: [rootId], edgeIds: [] };
  const adj = new Map<string, CallEdgeData[]>();
  for (const e of edges) {
    const arr = adj.get(e.source) ?? [];
    arr.push(e);
    adj.set(e.source, arr);
  }
  const visited = new Set<string>([rootId]);
  const parentEdge = new Map<string, CallEdgeData>();
  const queue = [rootId];
  let found = false;

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const e of adj.get(curr) ?? []) {
      if (!visited.has(e.target)) {
        visited.add(e.target);
        parentEdge.set(e.target, e);
        if (e.target === targetId) {
          found = true;
          break;
        }
        queue.push(e.target);
      }
    }
    if (found) break;
  }

  if (!found) return { nodeIds: [targetId], edgeIds: [] };
  const nodeIds: string[] = [targetId];
  const edgeIds: string[] = [];
  let cur = targetId;
  while (cur !== rootId) {
    const pe = parentEdge.get(cur);
    if (!pe) break;
    edgeIds.push(pe.id);
    nodeIds.push(pe.source);
    cur = pe.source;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  return { nodeIds, edgeIds };
}

export function buildReactFlowGraph(params: BuildGraphParams): {
  nodes: Node[];
  edges: Edge[];
} {
  const {
    entry,
    allNodes,
    allEdges,
    viewMode,
    heatmapEnabled,
    showBindEdges,
    selectedNodeId,
    selectedEdgeId,
    expandedSnippetIds,
    collapsedSubtreeIds,
    layerOverrides,
    stackMetrics,
  } = params;

  const entryNodeSet = new Set(entry.nodeIds);
  const subEdges = allEdges.filter((e) => {
    if (!entry.edgeIds.includes(e.id)) return false;
    if (!entryNodeSet.has(e.source) || !entryNodeSet.has(e.target)) return false;
    if (!showBindEdges && e.relationType === "BIND") return false;
    return true;
  });

  // Build adjacency & child count
  const childrenMap = new Map<string, string[]>();
  const parentsMap = new Map<string, string[]>();
  for (const id of entry.nodeIds) {
    childrenMap.set(id, []);
    parentsMap.set(id, []);
  }
  for (const e of subEdges) {
    childrenMap.get(e.source)?.push(e.target);
    parentsMap.get(e.target)?.push(e.source);
  }

  // Compute hidden nodes due to collapsed subtrees
  const hiddenSet = new Set<string>();
  const hideDescendants = (rootId: string) => {
    const queue = [...(childrenMap.get(rootId) ?? [])];
    const seen = new Set<string>([rootId]);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (seen.has(curr)) continue;
      seen.add(curr);
      // Only hide if all parents are either rootId or already hidden
      const parents = parentsMap.get(curr) ?? [];
      const hasVisibleOutsideParent = parents.some(
        (p) => p !== rootId && !hiddenSet.has(p) && !collapsedSubtreeIds[p]
      );
      if (!hasVisibleOutsideParent) {
        hiddenSet.add(curr);
        for (const next of childrenMap.get(curr) ?? []) {
          if (!seen.has(next)) queue.push(next);
        }
      }
    }
  };

  for (const collapsedId of Object.keys(collapsedSubtreeIds)) {
    if (collapsedSubtreeIds[collapsedId] && entryNodeSet.has(collapsedId)) {
      hideDescendants(collapsedId);
    }
  }

  const visibleNodeIds = entry.nodeIds.filter((id) => !hiddenSet.has(id) && Boolean(allNodes[id]));
  const visibleNodeSet = new Set(visibleNodeIds);
  const visibleEdges = subEdges.filter(
    (e) => visibleNodeSet.has(e.source) && visibleNodeSet.has(e.target)
  );

  // If an edge is selected, highlight the full upstream path from entry -> edge.source -> edge.target
  const selectedEdgeObj = selectedEdgeId
    ? visibleEdges.find((e) => e.id === selectedEdgeId)
    : undefined;
  const highlightedEdgeSet = new Set<string>();
  const highlightedNodeSet = new Set<string>();
  if (selectedEdgeObj) {
    highlightedEdgeSet.add(selectedEdgeObj.id);
    highlightedNodeSet.add(selectedEdgeObj.source);
    highlightedNodeSet.add(selectedEdgeObj.target);
    const up = computeUpstreamPathToNode(
      entry.entryNodeId,
      selectedEdgeObj.source,
      visibleEdges
    );
    up.edgeIds.forEach((eid) => highlightedEdgeSet.add(eid));
    up.nodeIds.forEach((nid) => highlightedNodeSet.add(nid));
  }

  const criticalNodes = new Set(stackMetrics.criticalPathNodeIds);
  const criticalEdges = new Set(stackMetrics.criticalPathEdgeIds);
  const recursionNodes = new Set(stackMetrics.recursionNodeIds);
  const recursionEdges = new Set(stackMetrics.recursionEdgeIds);

  const NODE_WIDTH = 286;
  const getNodeHeight = (id: string) => (expandedSnippetIds[id] ? 236 : 122);

  const rfNodes: Node[] = [];
  const dagreWaypoints = new Map<string, Array<{ x: number; y: number }>>();

  if (viewMode === "CANVAS") {
    // Dagre hierarchical left-to-right layout for spatial canvas
    // Extra generous ranksep (225px) and nodesep (58px) so edge paths and callback labels are never cramped
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
      rankdir: "LR",
      nodesep: 68,
      ranksep: 240,
      edgesep: 32,
      marginx: 50,
      marginy: 50,
    });

    for (const id of visibleNodeIds) {
      g.setNode(id, { width: NODE_WIDTH, height: getNodeHeight(id) });
    }
    for (const e of visibleEdges) {
      if (!recursionEdges.has(e.id)) {
        g.setEdge(e.source, e.target);
      }
    }
    dagre.layout(g);

    // Save Dagre obstacle-avoiding waypoints for cross-rank edges
    for (const e of visibleEdges) {
      if (!recursionEdges.has(e.id)) {
        const de = g.edge(e.source, e.target);
        if (de && Array.isArray(de.points) && de.points.length >= 2) {
          dagreWaypoints.set(e.id, de.points.map((pt) => ({ x: pt.x, y: pt.y })));
        }
      }
    }

    for (const id of visibleNodeIds) {
      const fn = allNodes[id];
      const pos = g.node(id);
      const h = getNodeHeight(id);
      const effectiveLayer = layerOverrides[id] ?? fn.layer;

      const payload: SmartNodePayload = {
        fn,
        effectiveLayer,
        isEntry: id === entry.entryNodeId,
        isSelected: id === selectedNodeId,
        isExpandedSnippet: Boolean(expandedSnippetIds[id]),
        isCollapsedSubtree: Boolean(collapsedSubtreeIds[id]),
        childCount: (childrenMap.get(id) ?? []).length,
        isOnCriticalStackPath: criticalNodes.has(id),
        isRecursionNode: recursionNodes.has(id),
        heatmapEnabled,
        viewMode,
      };

      rfNodes.push({
        id,
        type: "smartFunction",
        position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - h / 2 },
        zIndex: id === selectedNodeId ? 25 : 20,
        data: payload,
      });
    }
  } else {
    // SWIMLANE MODE (Plan 3): 4 horizontal architectural layers
    const layerBuckets: Record<ArchLayer, string[]> = {
      APP: [],
      CORE: [],
      CALLBACK: [],
      HAL: [],
    };

    for (const id of visibleNodeIds) {
      const effectiveLayer = layerOverrides[id] ?? allNodes[id].layer;
      layerBuckets[effectiveLayer].push(id);
    }

    const maxCols = Math.max(
      3,
      ...SWIMLANE_ORDER.map((l) => layerBuckets[l].length)
    );
    const colSpacing = NODE_WIDTH + 96;
    const bandWidth = Math.max(1320, 120 + maxCols * colSpacing + 80);

    // Background swimlane bands
    SWIMLANE_ORDER.forEach((layer, idx) => {
      const bandPayload: SwimlaneBandPayload = {
        layer,
        width: bandWidth,
        height: SWIMLANE_BAND_HEIGHT,
        nodeCount: layerBuckets[layer].length,
      };
      rfNodes.push({
        id: `__swimlane_${layer}`,
        type: "swimlaneBand",
        position: { x: 20, y: getSwimlaneY(idx) },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -10,
        data: bandPayload,
      });
    });

    // Place function cards inside their respective swimlanes
    SWIMLANE_ORDER.forEach((layer, idx) => {
      const ids = layerBuckets[layer];
      const bandTopY = getSwimlaneY(idx);
      ids.forEach((id, colIdx) => {
        const fn = allNodes[id];
        const h = getNodeHeight(id);
        const yOffset = Math.max(54, (SWIMLANE_BAND_HEIGHT - h) / 2 + 18);
        const payload: SmartNodePayload = {
          fn,
          effectiveLayer: layer,
          isEntry: id === entry.entryNodeId,
          isSelected: id === selectedNodeId,
          isExpandedSnippet: Boolean(expandedSnippetIds[id]),
          isCollapsedSubtree: Boolean(collapsedSubtreeIds[id]),
          childCount: (childrenMap.get(id) ?? []).length,
          isOnCriticalStackPath: criticalNodes.has(id),
          isRecursionNode: recursionNodes.has(id),
          heatmapEnabled,
          viewMode,
        };

        rfNodes.push({
          id,
          type: "smartFunction",
          position: { x: 64 + colIdx * colSpacing, y: bandTopY + yOffset },
          zIndex: id === selectedNodeId ? 25 : 20,
          data: payload,
        });
      });
    });
  }

  // Track incoming-edge index per target so multi-parent badges never stack on top of each other
  const targetInTotals = new Map<string, number>();
  for (const e of visibleEdges) {
    targetInTotals.set(e.target, (targetInTotals.get(e.target) ?? 0) + 1);
  }
  const targetInCursor = new Map<string, number>();

  // Build interactive semantic edges using custom InteractiveCallEdge
  const rfEdges: Edge[] = visibleEdges.map((e) => {
    const isCritical = heatmapEnabled && criticalEdges.has(e.id);
    const isRecursion = recursionEdges.has(e.id);
    const isSelected = e.id === selectedEdgeId;
    const isOnSelectedPath = highlightedEdgeSet.has(e.id);
    const inIndex = targetInCursor.get(e.target) ?? 0;
    targetInCursor.set(e.target, inIndex + 1);
    const inTotal = targetInTotals.get(e.target) ?? 1;

    let stroke = "#5c6d84";
    let strokeWidth = 1.75;
    let strokeDasharray: string | undefined = undefined;
    let animated = false;
    let className = "";

    if (isSelected) {
      stroke = "#7b9acc";
      strokeWidth = 3.0;
      animated = true;
    } else if (isOnSelectedPath) {
      stroke = "#8eb0e0";
      strokeWidth = 2.4;
      animated = true;
    } else if (isRecursion) {
      stroke = "#a58cc9";
      strokeWidth = 2.4;
      strokeDasharray = "6 4";
      animated = true;
      className = "edge-recursion-glow";
    } else if (isCritical) {
      stroke = "#c9858d";
      strokeWidth = 2.8;
      animated = true;
      className = "edge-heatmap-glow";
    } else if (e.kind === "ASYNC_CALLBACK" || e.relationType === "INVOKE_CB") {
      stroke = "#d2a266";
      strokeWidth = 2.0;
      strokeDasharray = "6 4";
      className = "edge-callback-animated";
    } else if (e.kind === "OPS_TABLE" || e.relationType === "BIND") {
      stroke = "#68a8b8";
      strokeWidth = 1.85;
      strokeDasharray = "5 4";
      className = "edge-callback-animated";
    } else if (e.kind === "WEAK_OVERRIDE") {
      stroke = "#a58cc9";
      strokeWidth = 2.0;
      strokeDasharray = "4 4";
    }

    const dimmed =
      (heatmapEnabled && !isCritical && !isRecursion) ||
      (Boolean(selectedEdgeObj) && !isOnSelectedPath);

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "interactiveCall",
      animated,
      className,
      // Always keep edges strictly below function node cards (zIndex 20/25) so lines never cover card text
      zIndex: isSelected ? 10 : isOnSelectedPath ? 8 : 2,
      data: {
        edgeData: e,
        isSelected,
        isOnSelectedPath,
        isCritical,
        isRecursion,
        dimmed,
        strokeColor: stroke,
        viewMode,
        waypoints: dagreWaypoints.get(e.id),
        inIndex,
        inTotal,
      },
      style: {
        stroke,
        strokeWidth,
        strokeDasharray,
        opacity: dimmed ? 0.2 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: 16,
        height: 16,
      },
    };
  });

  return { nodes: rfNodes, edges: rfEdges };
}
