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

    const [edgePath, labelX, labelY] =
      viewMode === "SWIMLANE"
        ? getBezierPath({
            sourceX,
            sourceY,
            sourcePosition,
            targetX,
            targetY,
            targetPosition,
          })
        : getSmoothStepPath({
            sourceX,
            sourceY,
            sourcePosition,
            targetX,
            targetY,
            targetPosition,
            borderRadius: 14,
          });

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
                  borderColor: isSelected ? "#38bdf8" : `${strokeColor}99`,
                  color: isSelected
                    ? "#ffffff"
                    : isRecursion
                    ? "#e9d5ff"
                    : isCritical
                    ? "#fecaca"
                    : relType === "BIND"
                    ? "#67e8f9"
                    : relType === "INVOKE_CB"
                    ? "#fdba74"
                    : relType === "WEAK_HOOK"
                    ? "#d8b4fe"
                    : "#cbd5e1",
                  backgroundColor: isSelected ? "#0369a1" : "#0b1222",
                  boxShadow: isSelected
                    ? "0 0 16px rgba(56, 189, 248, 0.75)"
                    : "0 2px 8px rgba(0, 0, 0, 0.75)",
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
