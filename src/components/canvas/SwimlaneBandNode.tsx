import React, { memo } from "react";
import { NodeProps } from "@xyflow/react";
import { SwimlaneBandPayload, SWIMLANE_META } from "../../utils/layoutEngine";

export const SwimlaneBandNode: React.FC<NodeProps> = memo(({ data }) => {
  const { layer, width, height, nodeCount } = data as unknown as SwimlaneBandPayload;
  const meta = SWIMLANE_META[layer];

  return (
    <div
      style={{ width, height }}
      className={`pointer-events-none rounded-2xl border border-dashed ${meta.bgClass} ${meta.borderClass} px-5 py-3 transition-colors`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="h-3 w-3 rounded-full"
            style={{
              backgroundColor: meta.accentColor,
              boxShadow: `0 0 12px ${meta.accentColor}`,
            }}
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tracking-wide text-slate-100">
                {meta.title}
              </span>
              <span className="rounded-full bg-slate-900/70 px-2 py-0.5 text-[10px] font-mono text-slate-400 border border-white/10">
                {nodeCount} 个函数
              </span>
            </div>
            <div className="text-[11px] text-slate-400">{meta.subtitle}</div>
          </div>
        </div>

        <div
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium"
          style={{
            backgroundColor: `${meta.accentColor}16`,
            color: meta.accentColor,
            border: `1px solid ${meta.accentColor}38`,
          }}
        >
          {meta.portingHint}
        </div>
      </div>
    </div>
  );
});

SwimlaneBandNode.displayName = "SwimlaneBandNode";
