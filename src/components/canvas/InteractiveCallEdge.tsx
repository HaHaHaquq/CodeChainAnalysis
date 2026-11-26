import React, { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";
import { CallEdgeData, ViewMode } from "../../types/analysis";
import { useChainStore } from "../../store/useChainStore";

export interface InteractiveEdgePayload extends Record<string, unknown> {
  edgeData: CallEdgeData;
  isSelected: boolean;
  isOnSelectedPath: boolean;
  isCritical: boolean;
  isRecursion: boolean;
  dimmed: boolean;
  strokeColor: string;
  viewMode: ViewMode;
  waypoints?: Array<{ x: number; y: number }>;
  inIndex?: number;
  inTotal?: number;
}

/**
 * Build a smooth rounded polyline SVG path through Dagre's obstacle-avoiding waypoints
 * so cross-rank edges flow cleanly through empty inter-column channels instead of cutting through nodes.
 */
function buildSmoothWaypointPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypoints: Array<{ x: number; y: number }>
): string {
  // Replace first & last Dagre points with exact React Flow handle coordinates
  const interior = waypoints.slice(1, -1);
  // Add a clean horizontal exit stub and horizontal approach stub so arrow enters cleanly
  const pts: Array<{ x: number; y: number }> = [
    { x: sourceX, y: sourceY },
    { x: sourceX + 26, y: sourceY },
    ...interior,
    { x: targetX - 30, y: targetY },
    { x: targetX, y: targetY },
  ];

  // Filter out near-duplicate consecutive points
  const clean: Array<{ x: number; y: number }> = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = clean[clean.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) > 4) {
      clean.push(pts[i]);
    }
  }
  if (clean.length < 2) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  let d = `M ${clean[0].x.toFixed(1)} ${clean[0].y.toFixed(1)}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1];
    const curr = clean[i];
    const next = clean[i + 1];
    const d1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const d2 = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(22, d1 * 0.42, d2 * 0.42);
    const x1 = curr.x - ((curr.x - prev.x) / d1) * r;
    const y1 = curr.y - ((curr.y - prev.y) / d1) * r;
    const x2 = curr.x + ((next.x - curr.x) / d2) * r;
    const y2 = curr.y + ((next.y - curr.y) / d2) * r;
    d += ` L ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  const last = clean[clean.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

export const InteractiveCallEdge: React.FC<EdgeProps> = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    data,
  }) => {
    const selectEdge = useChainStore((s) => s.selectEdge);
    const payload = data as unknown as InteractiveEdgePayload | undefined;
    const edgeData = payload?.edgeData;
    const isSelected = Boolean(payload?.isSelected);
    const isCritical = Boolean(payload?.isCritical);
    const isRecursion = Boolean(payload?.isRecursion);
    const dimmed = Boolean(payload?.dimmed);
    const strokeColor = payload?.strokeColor ?? "#64748b";
    const viewMode = payload?.viewMode ?? "CANVAS";
    const waypoints = payload?.waypoints;
    const inIndex = payload?.inIndex ?? 0;
    const inTotal = payload?.inTotal ?? 1;

    const dx = targetX - sourceX;
    const isCrossRankJump = viewMode === "CANVAS" && dx > 360;
    const waypointsValid =
      Boolean(waypoints && waypoints.length >= 3) &&
      Math.hypot(waypoints![0].x - sourceX, waypoints![0].y - sourceY) < 90 &&
      Math.hypot(
        waypoints![waypoints!.length - 1].x - targetX,
        waypoints![waypoints!.length - 1].y - targetY
      ) < 90;

    let edgePath: string;
    let labelX: number;
    let labelY: number;

    if (viewMode === "SWIMLANE") {
      [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
    } else if (isCrossRankJump && waypointsValid) {
      // Follow Dagre's obstacle-avoiding corridor waypoints around intermediate columns!
      edgePath = buildSmoothWaypointPath(sourceX, sourceY, targetX, targetY, waypoints!);
      // Dock badge cleanly in the empty left gutter right before target node
      const staggerX = inTotal > 1 ? (inIndex % 2) * 62 : 0;
      const staggerY = inTotal > 1 ? (inIndex - (inTotal - 1) / 2) * 20 : 0;
      labelX = targetX - 64 - staggerX;
      labelY = targetY + staggerY;
    } else if (isCrossRankJump) {
      // Fallback for manually dragged long edges
      [edgePath] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      const staggerX = inTotal > 1 ? (inIndex % 2) * 62 : 0;
      const staggerY = inTotal > 1 ? (inIndex - (inTotal - 1) / 2) * 20 : 0;
      labelX = targetX - 64 - staggerX;
      labelY = targetY + staggerY;
    } else if (dx > 0) {
      // Adjacent-column edge: route vertical stem cleanly inside the 240px empty gutter
      const gutterCenterX = targetX - 138 - (inIndex % 3) * 14;
      [edgePath] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 14,
        centerX: Math.max(sourceX + 24, gutterCenterX),
      });
      // Dock badge on the clean horizontal incoming stub in the empty gutter (never over any node!)
      const staggerX = inTotal > 1 ? (inIndex % 2) * 64 : 0;
      const staggerY = inTotal > 1 ? (inIndex - (inTotal - 1) / 2) * 20 : 0;
      labelX = targetX - 64 - staggerX;
      labelY = targetY + staggerY;
    } else {
      // Backward / recursion edge: smooth curved loop
      [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
    }

    const hasConditions = Boolean(
      edgeData?.conditions && edgeData.conditions.length > 0
    );
    const relType =
      edgeData?.relationType ??
      (edgeData?.kind === "WEAK_OVERRIDE"
        ? "WEAK_HOOK"
        : edgeData?.kind === "ASYNC_CALLBACK"
        ? "INVOKE_CB"
        : edgeData?.kind === "OPS_TABLE"
        ? "BIND"
        : "CALL");

    // Clean, ultra-concise short badge text so it NEVER overflows or gets pierced by dashed lines
    let badgeText = "";
    if (isRecursion) {
      badgeText = "🔄 递归";
    } else if (relType === "BIND") {
      badgeText = hasConditions ? "📌 绑定 ⑂" : "📌 绑定";
    } else if (relType === "INVOKE_CB") {
      badgeText = hasConditions ? "⚡ 回调 ⑂" : "⚡ 回调";
    } else if (relType === "WEAK_HOOK") {
      badgeText = hasConditions ? "🟣 weak ⑂" : "🟣 weak";
    } else if (hasConditions) {
      badgeText = "⑂ 条件调用";
    } else if (isSelected) {
      badgeText = "▶ 调用";
    }

    const tooltip = [
      edgeData?.callSiteExpr || edgeData?.label || "",
      edgeData?.conditions?.length
        ? `触发条件: ${edgeData.conditions.join(" -> ")}`
        : "",
      "单击连线可在右侧查看完整分支条件与调用现场源码",
    ]
      .filter(Boolean)
      .join("\n");

    return (
      <>
        {/* Invisible wide hit-area path so clicking thin lines is effortless */}
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={18}
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            selectEdge(id, true);
          }}
        />

        <BaseEdge
          id={id}
          path={edgePath}
          markerEnd={markerEnd}
          style={{
            ...style,
            cursor: "pointer",
          }}
        />

        {badgeText && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: "absolute",
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                pointerEvents: "all",
                opacity: dimmed ? 0.25 : 1,
                zIndex: isSelected ? 40 : 15,
              }}
              className="nodrag nopan"
            >
              <button
                type="button"
                title={tooltip}
                onClick={(e) => {
                  e.stopPropagation();
                  selectEdge(id, true);
                }}
                style={{
                  borderColor: isSelected ? "#7b9acc" : `${strokeColor}75`,
                  color: isSelected
                    ? "#f1f5f9"
                    : isRecursion
                    ? "#d2c6ed"
                    : isCritical
                    ? "#e8b4ba"
                    : relType === "BIND"
                    ? "#9ed0dc"
                    : relType === "INVOKE_CB"
                    ? "#e6c494"
                    : relType === "WEAK_HOOK"
                    ? "#d2c6ed"
                    : "#cbd5e1",
                  backgroundColor: isSelected ? "#263852" : "#121822",
                  boxShadow: isSelected
                    ? "0 0 12px rgba(123, 154, 204, 0.35)"
                    : "0 2px 6px rgba(0, 0, 0, 0.55)",
                }}
                className="rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold leading-tight whitespace-nowrap transition-transform hover:scale-110 cursor-pointer"
              >
                {badgeText}
              </button>
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
);

InteractiveCallEdge.displayName = "InteractiveCallEdge";
