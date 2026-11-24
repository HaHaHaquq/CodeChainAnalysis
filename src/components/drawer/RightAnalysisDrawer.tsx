import React, { useCallback, useEffect, useRef } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Columns2,
  Cpu,
  ExternalLink,
  FileCode2,
  Flame,
  GitMerge,
  Globe,
  Layers,
  Maximize2,
  Minimize2,
  Package,
  Plug,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useChainStore, isTauriDesktop } from "../../store/useChainStore";
import {
  FeatureEntry,
  PortingBoundaryResult,
  StackMetricsResult,
} from "../../types/analysis";
import { SWIMLANE_META, computeUpstreamPathToNode } from "../../utils/layoutEngine";

interface RightAnalysisDrawerProps {
  activeEntry: FeatureEntry;
  stackMetrics: StackMetricsResult;
  porting: PortingBoundaryResult;
  isStandaloneWindow?: boolean;
}

export const RightAnalysisDrawer: React.FC<RightAnalysisDrawerProps> = ({
  activeEntry,
  stackMetrics,
  porting,
  isStandaloneWindow = false,
}) => {
  const project = useChainStore((s) => s.project);
  const rightDrawerOpen = useChainStore((s) => s.rightDrawerOpen);
  const rightDrawerLayout = useChainStore((s) => s.rightDrawerLayout);
  const setRightDrawerLayout = useChainStore((s) => s.setRightDrawerLayout);
  const rightDrawerWidth = useChainStore((s) => s.rightDrawerWidth);
  const setRightDrawerWidth = useChainStore((s) => s.setRightDrawerWidth);
  const activeSourceFile = useChainStore((s) => s.activeSourceFile);
  const openFileInEditor = useChainStore((s) => s.openFileInEditor);
  const rightTab = useChainStore((s) => s.rightTab);
  const setRightTab = useChainStore((s) => s.setRightTab);
  const selectedNodeId = useChainStore((s) => s.selectedNodeId);
  const selectedEdgeId = useChainStore((s) => s.selectedEdgeId);
  const edgeViewSide = useChainStore((s) => s.edgeViewSide);
  const setEdgeViewSide = useChainStore((s) => s.setEdgeViewSide);
  const selectNode = useChainStore((s) => s.selectNode);
  const selectEdge = useChainStore((s) => s.selectEdge);
  const layerOverrides = useChainStore((s) => s.layerOverrides);
  const setAiPromptModalOpen = useChainStore((s) => s.setAiPromptModalOpen);
  const setPortingCodeModalOpen = useChainStore(
    (s) => s.setPortingCodeModalOpen
  );
  const suCalibratedCount = useChainStore((s) => s.suCalibratedCount);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const selectedEdge = selectedEdgeId
    ? project.edges.find((e) => e.id === selectedEdgeId)
    : undefined;
  const edgeCallerNode = selectedEdge ? project.nodes[selectedEdge.source] : undefined;
  const edgeTargetNode = selectedEdge ? project.nodes[selectedEdge.target] : undefined;

  const selectedNode = selectedNodeId ? project.nodes[selectedNodeId] : undefined;
  const currentFile =
    activeSourceFile ||
    (selectedEdge
      ? edgeViewSide === "CALLER"
        ? edgeCallerNode?.file
        : edgeTargetNode?.file
      : selectedNode?.file) ||
    Object.keys(project.files)[0] ||
    "";
  const isViewingSelectedNodeFile =
    Boolean(selectedNode && currentFile === selectedNode.file);

  const sourceCode =
    (currentFile && project.files[currentFile]) ||
    (selectedNode
      ? `/* 外部库或头声明符号: ${selectedNode.file} */\n${selectedNode.signature}\n\n${selectedNode.snippet}`
      : "// 点击画布上任意函数卡片或连线以查看完整 C/H 源码");

  const highlightTargetLines = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Priority 1: If an edge is selected and we are viewing the caller's file at callSiteLine
    if (
      selectedEdge &&
      edgeViewSide === "CALLER" &&
      edgeCallerNode &&
      currentFile === edgeCallerNode.file &&
      selectedEdge.callSiteLine &&
      selectedEdge.callSiteLine > 0
    ) {
      const targetLine = selectedEdge.callSiteLine;
      editor.revealLineInCenter(targetLine);
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range: {
            startLineNumber: targetLine,
            startColumn: 1,
            endLineNumber: targetLine,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: "chain-monaco-active-line",
          },
        },
      ]);
      return;
    }

    // Priority 2: If an edge is selected and we switched to viewing the target function definition
    if (
      selectedEdge &&
      edgeViewSide === "TARGET" &&
      edgeTargetNode &&
      currentFile === edgeTargetNode.file
    ) {
      const start = Math.max(1, edgeTargetNode.lineStart);
      const end = Math.max(start, edgeTargetNode.lineEnd);
      editor.revealLineInCenter(start);
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range: {
            startLineNumber: start,
            startColumn: 1,
            endLineNumber: end,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: "chain-monaco-active-line",
          },
        },
      ]);
      return;
    }

    if (!selectedNode || !isViewingSelectedNodeFile) {
      decorationsRef.current = editor.deltaDecorations(
        decorationsRef.current,
        []
      );
      editor.setScrollTop(0);
      return;
    }
    const start = Math.max(1, selectedNode.lineStart);
    const end = Math.max(start, selectedNode.lineEnd);
    editor.revealLineInCenter(start);
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
      {
        range: {
          startLineNumber: start,
          startColumn: 1,
          endLineNumber: end,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "chain-monaco-active-line",
        },
      },
    ]);
  }, [
    selectedEdge,
    edgeViewSide,
    edgeCallerNode,
    edgeTargetNode,
    selectedNode,
    isViewingSelectedNodeFile,
    currentFile,
  ]);

  useEffect(() => {
    if (rightTab === "SOURCE") {
      const t = setTimeout(highlightTargetLines, 80);
      return () => clearTimeout(t);
    }
  }, [selectedNodeId, selectedEdgeId, edgeViewSide, currentFile, rightTab, highlightTargetLines]);

  const handleStartResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = rightDrawerWidth;

      const onMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        setRightDrawerWidth(startWidth + delta);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [rightDrawerWidth, setRightDrawerWidth]
  );

  const handlePopOutWindow = async () => {
    if (isTauriDesktop()) {
      try {
        await invoke("open_standalone_drawer");
        setRightDrawerLayout("DETACHED");
        return;
      } catch {
        // fallback to window.open
      }
    }
    const popup = window.open(
      "/?standalone=drawer",
      "ChainAnalysisDrawerWindow",
      "width=780,height=920,menubar=no,toolbar=no,location=no,status=no"
    );
    if (popup) {
      setRightDrawerLayout("DETACHED");
    }
  };

  const handleDockBackToMain = () => {
    try {
      const ch = new BroadcastChannel("chain_analysis_sync_v1");
      ch.postMessage({ type: "POPUP_CLOSED" });
      ch.close();
    } catch {
      // ignore
    }
    window.close();
  };

  if (!isStandaloneWindow && (!rightDrawerOpen || rightDrawerLayout === "DETACHED")) {
    return null;
  }

  const allFileList = Object.keys(project.files).sort();

  const containerClass = isStandaloneWindow
    ? "h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden"
    : rightDrawerLayout === "SPLIT"
    ? "relative h-full shrink-0 flex flex-col border-l border-white/10 bg-slate-950/95 backdrop-blur-2xl shadow-2xl overflow-hidden z-20 pt-16"
    : "absolute top-20 right-3 bottom-4 z-20 flex flex-col rounded-2xl border border-white/10 bg-slate-950/90 backdrop-blur-2xl shadow-2xl overflow-hidden";

  return (
    <aside
      style={isStandaloneWindow ? undefined : { width: rightDrawerWidth }}
      className={containerClass}
    >
      {/* Left edge drag-to-resize handle */}
      {!isStandaloneWindow && (
        <div
          onMouseDown={handleStartResize}
          title="左右拖拽调整面板宽度"
          className="absolute left-0 top-0 bottom-0 z-30 w-1.5 cursor-col-resize hover:bg-cyan-400/60 transition-colors"
        />
      )}

      {/* Window / Layout Toolbar */}
      <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/90 px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-bold text-slate-200 truncate">
            {activeEntry.displayName}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {!isStandaloneWindow ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setRightDrawerLayout(
                    rightDrawerLayout === "SPLIT" ? "FLOATING" : "SPLIT"
                  )
                }
                title={
                  rightDrawerLayout === "SPLIT"
                    ? "当前为并排分屏（不遮挡画布），点击切为悬浮抽屉"
                    : "当前为悬浮抽屉，点击切为并排分屏（完全不遮挡中间画布）"
                }
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-semibold border transition-colors ${
                  rightDrawerLayout === "SPLIT"
                    ? "bg-cyan-500/20 text-cyan-200 border-cyan-500/40"
                    : "bg-slate-800 text-slate-300 border-white/10 hover:text-white"
                }`}
              >
                <Columns2 className="h-3 w-3" />
                {rightDrawerLayout === "SPLIT" ? "分屏固定" : "悬浮模式"}
              </button>

              <button
                type="button"
                onClick={() =>
                  setRightDrawerWidth(rightDrawerWidth >= 680 ? 450 : 720)
                }
                title={rightDrawerWidth >= 680 ? "恢复标准宽度" : "一键加宽面板以查看长源码"}
                className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300 hover:text-white"
              >
                {rightDrawerWidth >= 680 ? (
                  <>
                    <Minimize2 className="h-3 w-3" /> 标准宽
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3 w-3" /> 加宽
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handlePopOutWindow}
                title="将此面板弹出为独立窗口（主窗口 100% 留给中间画布，双窗实时联动！）"
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-400/40 bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-200 hover:bg-indigo-500/35"
              >
                <ExternalLink className="h-3 w-3" />
                独立成窗
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleDockBackToMain}
              className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-2.5 py-1 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/30"
            >
              ↙ 收回主窗口分屏
            </button>
          )}
        </div>
      </div>
      {/* Top Tabs */}
      <div className="flex items-center border-b border-white/10 bg-slate-900/60 p-1.5 gap-1">
        <button
          type="button"
          onClick={() => setRightTab("PORTING")}
          className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition-all ${
            rightTab === "PORTING"
              ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/40"
              : "text-slate-400 hover:text-slate-200 border border-transparent"
          }`}
        >
          <Package className="h-3.5 w-3.5" />
          移植边界 & 堆栈
        </button>
        <button
          type="button"
          onClick={() => setRightTab("FLOW")}
          className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition-all ${
            rightTab === "FLOW"
              ? "bg-amber-500/20 text-amber-200 border border-amber-500/40"
              : "text-slate-400 hover:text-slate-200 border border-transparent"
          }`}
        >
          <GitMerge className="h-3.5 w-3.5" />
          执行思路大纲
        </button>
        <button
          type="button"
          onClick={() => setRightTab("SOURCE")}
          className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition-all ${
            rightTab === "SOURCE"
              ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40"
              : "text-slate-400 hover:text-slate-200 border border-transparent"
          }`}
        >
          <Code2 className="h-3.5 w-3.5" />
          源码联动
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto">
        {/* ================= TAB 1: PORTING BOUNDARY & STACK ================= */}
        {rightTab === "PORTING" && (
          <div className="p-3.5 space-y-4">
            {/* Memory & Stack Budget Card */}
            <section className="rounded-xl border border-white/10 bg-slate-900/75 p-3">
              <div className="flex items-center justify-between mb-2.5">
                <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-100">
                  <Flame className="h-4 w-4 text-orange-400" />
                  迁移堆栈与 RAM 体检预算
                </h3>
                <div className="flex items-center gap-1.5">
                  {suCalibratedCount > 0 && (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                      .su 已校准
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setPortingCodeModalOpen(true)}
                    className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300 hover:bg-slate-700"
                  >
                    .su 校准 / 导出适配层
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-lg bg-slate-950/80 p-2 border border-white/5">
                  <div className="text-[10px] text-slate-400">最坏峰值栈深</div>
                  <div
                    className={`mt-0.5 font-mono text-sm font-bold ${
                      stackMetrics.rtosOverflowRisk === "CRITICAL"
                        ? "text-red-400"
                        : "text-emerald-300"
                    }`}
                  >
                    ~{stackMetrics.maxStackBytes} B
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/80 p-2 border border-white/5">
                  <div className="text-[10px] text-slate-400">静态 RAM (.bss)</div>
                  <div className="mt-0.5 font-mono text-sm font-bold text-indigo-300">
                    {porting.totalStaticRamBytes} B
                  </div>
                </div>
                <div className="rounded-lg bg-slate-950/80 p-2 border border-white/5">
                  <div className="text-[10px] text-slate-400">动态堆 (Heap)</div>
                  <div
                    className={`mt-0.5 text-xs font-bold ${
                      porting.heapCallNodes.length > 0
                        ? "text-amber-300"
                        : "text-emerald-400"
                    }`}
                  >
                    {porting.heapCallNodes.length > 0
                      ? `⚠️ ${porting.heapCallNodes.length} 处调用`
                      : "✓ 0 malloc"}
                  </div>
                </div>
              </div>

              {/* Runtime Dependency Banner: Bare-Metal Ready vs RTOS Required */}
              {stackMetrics.runtimeReq === "BARE_METAL_READY" ? (
                <div className="mb-2.5 rounded-lg border border-emerald-500/35 bg-emerald-950/25 px-2.5 py-2 text-[11px] text-emerald-200">
                  <div className="font-bold flex items-center justify-between">
                    <span>🟢 纯裸机可直接移植 (0 RTOS 依赖)</span>
                    <span className="font-mono text-[10px] text-emerald-300">
                      MSP 主栈模式
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-emerald-200/80 leading-relaxed">
                    该功能整条调用链未调用任何 RTOS 线程/信号量 API，在裸机中断或 while(1) 前后台工程中可直接运行。
                  </p>
                </div>
              ) : (
                <div className="mb-2.5 rounded-lg border border-sky-500/35 bg-sky-950/25 px-2.5 py-2 text-[11px] text-sky-200">
                  <div className="font-bold flex items-center justify-between">
                    <span>🔵 依赖 RTOS / OSAL 线程与同步原语</span>
                    <span className="font-mono text-[10px] text-sky-300">
                      PSP 线程栈模式
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-sky-200/80 leading-relaxed">
                    检测到调用了{" "}
                    <span className="font-mono text-white">
                      {stackMetrics.osApisUsed.join(", ") || "RTOS 任务调度"}
                    </span>
                    。若想迁移至纯裸机工程，需将阻塞等待改造为非阻塞状态机轮询。
                  </p>
                </div>
              )}

              {/* Adaptive Stack Budget Bar: MSP (Bare-Metal) OR PSP (RTOS Task) */}
              <div className="mb-2.5 rounded-lg bg-slate-950/70 p-2 border border-white/5">
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="text-slate-300 truncate">
                    {stackMetrics.budgetSourceLabel}
                  </span>
                  <span
                    className={`font-mono font-bold ${
                      stackMetrics.rtosOverflowRisk === "CRITICAL"
                        ? "text-red-400"
                        : stackMetrics.rtosOverflowRisk === "WARNING"
                        ? "text-amber-300"
                        : "text-emerald-300"
                    }`}
                  >
                    {stackMetrics.budgetUsagePercent}%
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      stackMetrics.rtosOverflowRisk === "CRITICAL"
                        ? "bg-gradient-to-r from-orange-500 to-red-500"
                        : stackMetrics.rtosOverflowRisk === "WARNING"
                        ? "bg-gradient-to-r from-amber-500 to-orange-400"
                        : "bg-gradient-to-r from-cyan-500 to-emerald-400"
                    }`}
                    style={{
                      width: `${Math.min(100, stackMetrics.budgetUsagePercent)}%`,
                    }}
                  />
                </div>
                {stackMetrics.stackKind === "MSP_BARE_METAL" ? (
                  <p className="mt-1.5 text-[10px] leading-snug text-slate-400">
                    💡 裸机评估提示：单条链路峰值耗栈 ~{stackMetrics.maxStackBytes}B，请确保启动文件{" "}
                    <code className="text-slate-300">startup_*.s</code> 的{" "}
                    <code className="text-slate-300">Stack_Size</code> 留足【main主循环 + 此中断链】的嵌套余量。
                  </p>
                ) : (
                  stackMetrics.rtosOverflowRisk === "CRITICAL" && (
                    <p className="mt-1.5 text-[11px] leading-snug text-red-300/95">
                      ⚠️ 线程栈余量不足 15%，极易触发 HardFault！建议优化局部大数组或将任务栈扩大至 &ge;{" "}
                      {Math.ceil((stackMetrics.maxStackBytes * 1.45) / 256) * 256} B。
                    </p>
                  )
                )}
              </div>

              {/* Large Stack / Recursion Warnings */}
              {stackMetrics.largeStackNodeIds.map((id) => {
                const n = project.nodes[id];
                if (!n) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectNode(id, true)}
                    className="mt-1.5 w-full text-left flex items-start gap-2 rounded-lg border border-orange-500/35 bg-orange-500/10 px-2.5 py-2 text-[11px] text-orange-200 hover:bg-orange-500/20 transition-colors"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-400 mt-0.5" />
                    <div>
                      <span className="font-mono font-bold">{n.name}()</span>{" "}
                      <span className="text-orange-300">
                        (~{n.stackBytes}B)
                      </span>
                      <div className="text-[10px] text-orange-200/80 mt-0.5">
                        {n.stackWarnings?.[0] || "局部栈帧较大，建议检查数组定义"}
                      </div>
                    </div>
                  </button>
                );
              })}

              {stackMetrics.hasRecursion && (
                <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-purple-500/40 bg-purple-500/15 px-2.5 py-2 text-[11px] text-purple-200">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-purple-300 mt-0.5" />
                  <div>
                    <span className="font-bold">检测到递归环路：</span>
                    {stackMetrics.recursionNodeIds.join(" ⇄ ")}。嵌入式移植前建议改为非递归状态机或显式队列！
                  </div>
                </div>
              )}
            </section>

            {/* Section 2: HAL Interfaces to Replace */}
            <section className="rounded-xl border border-rose-500/25 bg-rose-950/15 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-1.5 text-xs font-bold text-rose-200">
                  <Plug className="h-3.5 w-3.5 text-rose-400" />
                  需替换的底层接口 (HAL / BSP / OS)
                </h3>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPortingCodeModalOpen(true)}
                    className="rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-200 hover:bg-emerald-500/30"
                  >
                    🛠️ 生成适配层 .c 模板
                  </button>
                  <span className="rounded-full bg-rose-500/20 px-2 py-0.5 font-mono text-[10px] text-rose-300">
                    {porting.halInterfacesToReplace.length} 项
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-slate-400 mb-2">
                移植到新芯片时，以下落在 L4 泳道的接口需替换为目标平台实现（切到泳道视图拖动节点可实时增减）：
              </p>
              <div className="space-y-1.5">
                {porting.halInterfacesToReplace.map(({ node, calledBy, viaKind }) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => selectNode(node.id, true)}
                    className="w-full text-left rounded-lg border border-rose-500/20 bg-slate-950/75 px-2.5 py-2 hover:border-rose-400/50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-rose-200 truncate">
                        {node.name}()
                      </span>
                      {viaKind === "OPS_TABLE" && (
                        <span className="shrink-0 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-300">
                          已解耦 Ops
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                      {node.file}
                    </div>
                    {calledBy.length > 0 && (
                      <div className="mt-1 text-[10px] text-slate-400">
                        调用方：<span className="font-mono text-slate-300">{calledBy.join(", ")}</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>

            {/* Section 3: Core Files to Copy */}
            <section className="rounded-xl border border-emerald-500/25 bg-emerald-950/15 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-1.5 text-xs font-bold text-emerald-200">
                  <FileCode2 className="h-3.5 w-3.5 text-emerald-400" />
                  必拷核心文件闭包 (Files to Copy)
                </h3>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
                  {porting.coreFilesToCopy.length} 文件
                </span>
              </div>
              <div className="space-y-1.5">
                {porting.coreFilesToCopy.map((f) => (
                  <button
                    key={f.file}
                    type="button"
                    onClick={() => openFileInEditor(f.file)}
                    title="点击直接在源码阅读器中打开此文件全文"
                    className="w-full flex items-center justify-between rounded-lg border border-white/5 bg-slate-950/70 px-2.5 py-1.5 text-xs hover:border-emerald-400/50 transition-colors"
                  >
                    <span className="font-mono text-[11px] text-slate-200 truncate hover:text-emerald-300">
                      {f.file}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        f.role === "CORE"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : f.role === "HEADER"
                          ? "bg-cyan-500/20 text-cyan-300"
                          : "bg-indigo-500/20 text-indigo-300"
                      }`}
                    >
                      {f.role === "CORE"
                        ? "核心必拷"
                        : f.role === "HEADER"
                        ? "配套头文件"
                        : "入口参考"}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Section 4: Global Variables & Macros */}
            <section className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-200 mb-2">
                <Globe className="h-3.5 w-3.5 text-indigo-400" />
                关联全局状态与配置宏
              </h3>
              <div className="space-y-1.5">
                {porting.globalsUsed.map((g) => (
                  <div
                    key={g.name}
                    className="rounded-lg bg-slate-950/75 px-2.5 py-1.5 border border-white/5"
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono font-bold text-indigo-200">
                        {g.name}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400">
                        {g.bytes} B · {g.section}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      {g.description}
                    </div>
                  </div>
                ))}
                {porting.configMacros.length > 0 && (
                  <div className="pt-2 border-t border-white/5 space-y-1">
                    {porting.configMacros.map((m) => (
                      <div
                        key={m.name}
                        className="flex items-center justify-between text-[10px] font-mono text-amber-200/90"
                      >
                        <span>
                          #define {m.name} {m.defaultVal}
                        </span>
                        <span className="text-slate-400 font-sans truncate max-w-[160px]">
                          {m.purpose}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* ================= TAB 2: STATIC EXECUTION FLOW & AI PROMPT ================= */}
        {rightTab === "FLOW" && (
          <div className="p-3.5 space-y-4">
            <div className="rounded-xl border border-cyan-500/25 bg-cyan-950/15 p-3">
              <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-200">
                <CheckCircle2 className="h-4 w-4 text-cyan-400" />
                纯静态 AST 提炼执行流（0 API Key 离线秒出）
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                {activeEntry.summary}
              </p>
            </div>

            {/* Flow Timeline */}
            <div className="relative pl-4 space-y-3 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
              {activeEntry.staticFlowOutline.map((step) => {
                const tagColor =
                  step.tag === "WARN"
                    ? "bg-red-500/20 text-red-300 border-red-500/40"
                    : step.tag === "CALLBACK"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : step.tag === "HAL"
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                    : "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";

                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => selectNode(step.nodeId, false)}
                    className="relative w-full text-left rounded-xl border border-white/10 bg-slate-900/75 p-3 hover:border-cyan-400/50 transition-all group"
                  >
                    <span className="absolute -left-[13px] top-4 h-2.5 w-2.5 rounded-full bg-cyan-400 ring-4 ring-slate-950" />
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] font-bold text-slate-200">
                        {step.stage}
                      </span>
                      {step.tag && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${tagColor}`}
                        >
                          {step.tag}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xs font-semibold text-cyan-300 group-hover:underline">
                      {step.title}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-300/90">
                      {step.detail}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Zero-Key AI Export Banner */}
            <div className="rounded-xl border border-indigo-400/35 bg-gradient-to-br from-indigo-950/60 to-slate-900/90 p-3.5">
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-100">
                <Sparkles className="h-4 w-4 text-cyan-300" />
                想要更深度的自然语言移植教程？
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                无需在软件里配置任何付费 API Key！点击下方按钮，自动把当前功能的**完整调用链、回调闭环、爆栈预警与核心 C 代码切片**打包成结构化 Prompt，一键粘贴给网页版 DeepSeek / Kimi / ChatGPT 即可秒出移植方案。
              </p>
              <button
                type="button"
                onClick={() => setAiPromptModalOpen(true)}
                className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-indigo-600 py-2 text-xs font-bold text-white hover:from-cyan-500 hover:to-indigo-500 shadow-lg transition-all"
              >
                <Sparkles className="h-3.5 w-3.5" />
                一键生成并复制 AI 深度分析 Prompt
              </button>
            </div>
          </div>
        )}

        {/* ================= TAB 3: MONACO SOURCE & LOCAL STACK BREAKDOWN ================= */}
        {rightTab === "SOURCE" && (
          <div className="flex h-full flex-col">
            {/* Full-Project File Switcher Bar */}
            <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-slate-950 px-3 py-2">
              <span className="shrink-0 text-[10px] font-semibold text-slate-400">
                📄 浏览工程文件 ({allFileList.length}):
              </span>
              <select
                value={currentFile}
                onChange={(e) => openFileInEditor(e.target.value)}
                className="flex-1 rounded-lg border border-white/15 bg-slate-900 px-2 py-1 font-mono text-[11px] text-cyan-200 focus:border-cyan-400 focus:outline-none"
              >
                {allFileList.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            {/* ================= CALL-SITE EDGE INSPECTOR (when an edge is clicked) ================= */}
            {selectedEdge && edgeCallerNode && edgeTargetNode && (() => {
              const relType =
                selectedEdge.relationType ??
                (selectedEdge.kind === "WEAK_OVERRIDE"
                  ? "WEAK_HOOK"
                  : selectedEdge.kind === "ASYNC_CALLBACK"
                  ? "INVOKE_CB"
                  : selectedEdge.kind === "OPS_TABLE"
                  ? "BIND"
                  : "CALL");

              const relMeta =
                relType === "BIND"
                  ? {
                      badge: "📌 指针绑定 / 注册（此时不执行目标函数）",
                      cls: "border-cyan-500/45 bg-cyan-500/15 text-cyan-200",
                    }
                  : relType === "INVOKE_CB"
                  ? {
                      badge: "⚡ 异步回调触发（经由函数指针执行）",
                      cls: "border-orange-500/45 bg-orange-500/15 text-orange-200",
                    }
                  : relType === "WEAK_HOOK"
                  ? {
                      badge: "🟣 __weak 弱函数钩子（可被用户强重写）",
                      cls: "border-purple-500/45 bg-purple-500/15 text-purple-200",
                    }
                  : {
                      badge: "▶ 直接函数调用（同步顺序执行）",
                      cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
                    };

              const subEdges = project.edges.filter((e) =>
                activeEntry.edgeIds.includes(e.id)
              );
              const upPath = computeUpstreamPathToNode(
                activeEntry.entryNodeId,
                selectedEdge.source,
                subEdges
              );
              const fullChain = [...upPath.nodeIds, selectedEdge.target];

              return (
                <div className="border-b border-cyan-500/30 bg-slate-900/90 p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center rounded-lg border px-2 py-0.5 text-[11px] font-bold ${relMeta.cls}`}
                    >
                      {relMeta.badge}
                    </span>
                    <button
                      type="button"
                      onClick={() => selectEdge(null, false)}
                      className="text-[10px] text-slate-400 hover:text-white"
                    >
                      ✕ 关闭关系透视
                    </button>
                  </div>

                  {/* Upstream Full Call-Chain Breadcrumb */}
                  <div className="rounded-lg bg-slate-950/90 px-2.5 py-1.5 border border-white/5">
                    <div className="text-[10px] font-semibold text-slate-400 mb-1">
                      完整到达链路（点击任意节点跳转）：
                    </div>
                    <div className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
                      {fullChain.map((nid, idx) => (
                        <React.Fragment key={`${nid}_${idx}`}>
                          {idx > 0 && (
                            <span className="text-slate-500">➔</span>
                          )}
                          <button
                            type="button"
                            onClick={() => selectNode(nid, true)}
                            className={`rounded px-1.5 py-0.5 hover:underline ${
                              nid === selectedEdge.target
                                ? "bg-amber-500/20 text-amber-200 font-bold"
                                : nid === selectedEdge.source
                                ? "bg-cyan-500/20 text-cyan-200 font-bold"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            {nid}()
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>

                  {/* Enclosing #if / if / switch-case Trigger Conditions Tree */}
                  <div className="rounded-lg bg-slate-950/90 px-2.5 py-2 border border-white/5">
                    <div className="text-[10px] font-semibold text-amber-300 mb-1">
                      ⑂ 触发分支与宏条件栈：
                    </div>
                    {selectedEdge.conditions &&
                    selectedEdge.conditions.length > 0 ? (
                      <div className="space-y-1 font-mono text-[10px]">
                        {selectedEdge.conditions.map((cond, idx) => (
                          <div
                            key={idx}
                            style={{ paddingLeft: `${idx * 10}px` }}
                            className={`break-all ${
                              cond.startsWith("#")
                                ? "text-purple-300"
                                : cond.startsWith("case") ||
                                  cond.startsWith("default")
                                ? "text-amber-200"
                                : "text-cyan-200"
                            }`}
                          >
                            {idx > 0 ? "└─ " : ""}
                            {cond}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-emerald-300/90">
                        ✓ 无分支守卫（主干顺序必经路径）
                      </div>
                    )}
                  </div>

                  {/* Full Untruncated Call/Bind Statement */}
                  {selectedEdge.callSiteExpr && (
                    <div className="rounded-lg bg-[#050810] px-2.5 py-1.5 border border-cyan-500/25 font-mono text-[11px] text-cyan-100 break-all">
                      <span className="text-slate-500 mr-2">
                        L{selectedEdge.callSiteLine || "?"}:
                      </span>
                      {selectedEdge.callSiteExpr}
                    </div>
                  )}

                  {/* 2-Way Source Jump Toggle: Call Site in Caller vs Target Definition */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEdgeViewSide("CALLER")}
                      className={`flex-1 rounded-lg border py-1.5 text-[11px] font-bold transition-colors ${
                        edgeViewSide === "CALLER"
                          ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                          : "border-white/10 bg-slate-800/80 text-slate-300 hover:text-white"
                      }`}
                    >
                      📍 调用现场 ({edgeCallerNode.name}:L
                      {selectedEdge.callSiteLine || edgeCallerNode.lineStart})
                    </button>
                    <button
                      type="button"
                      onClick={() => setEdgeViewSide("TARGET")}
                      className={`flex-1 rounded-lg border py-1.5 text-[11px] font-bold transition-colors ${
                        edgeViewSide === "TARGET"
                          ? "border-amber-400/60 bg-amber-500/20 text-amber-100"
                          : "border-white/10 bg-slate-800/80 text-slate-300 hover:text-white"
                      }`}
                    >
                      🎯 目标定义 ({edgeTargetNode.name}:L
                      {edgeTargetNode.lineStart})
                    </button>
                  </div>
                </div>
              );
            })()}

            {!selectedEdge && selectedNode && isViewingSelectedNodeFile && (
              <div className="border-b border-white/10 bg-slate-900/80 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-bold text-cyan-300">
                      {selectedNode.name}()
                    </div>
                    <div className="truncate font-mono text-[10px] text-slate-400">
                      {selectedNode.file} : L{selectedNode.lineStart}-L
                      {selectedNode.lineEnd}
                    </div>
                  </div>
                  <span
                    className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold"
                    style={{
                      backgroundColor: `${
                        SWIMLANE_META[
                          layerOverrides[selectedNode.id] ?? selectedNode.layer
                        ].accentColor
                      }22`,
                      color:
                        SWIMLANE_META[
                          layerOverrides[selectedNode.id] ?? selectedNode.layer
                        ].accentColor,
                    }}
                  >
                    <Layers className="h-3 w-3" />
                    {layerOverrides[selectedNode.id] ?? selectedNode.layer}
                  </span>
                </div>

                {/* Full Function Description & Extracted Flow Summary */}
                <div className="rounded-lg border border-cyan-500/25 bg-cyan-950/20 px-2.5 py-2 text-[11px] leading-relaxed text-slate-200">
                  {selectedNode.brief}
                </div>

                {/* Local Stack Frame Breakdown */}
                <div className="rounded-lg bg-slate-950/90 p-2 border border-white/5">
                  <div className="flex items-center justify-between text-[10px] mb-1">
                    <span className="flex items-center gap-1 font-semibold text-slate-300">
                      <Cpu className="h-3 w-3 text-orange-400" />
                      单函数局部栈帧明细（含压栈开销）
                    </span>
                    <span className="font-mono font-bold text-orange-300">
                      总计 ~{selectedNode.stackBytes} B
                    </span>
                  </div>
                  { selectedNode.localVars.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {selectedNode.localVars.map((v) => (
                        <span
                          key={v.name}
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                            v.isLarge
                              ? "bg-red-500/20 text-red-200 border border-red-500/40"
                              : "bg-slate-800/90 text-slate-300"
                          }`}
                        >
                          {v.typeStr} {v.name}: {v.bytes}B
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-slate-500">
                      无显式局部大变量（仅基础寄存器/返回地址压栈开销）
                    </div>
                  )}
                </div>

                {/* Upstream Callers & Downstream Callees Quick-Jump Bar */}
                {(() => {
                  const callers = project.edges
                    .filter((e) => e.target === selectedNode.id)
                    .map((e) => ({
                      id: e.source,
                      kind: e.kind,
                      name: project.nodes[e.source]?.name ?? e.source,
                    }));
                  const callees = project.edges
                    .filter((e) => e.source === selectedNode.id)
                    .map((e) => ({
                      id: e.target,
                      kind: e.kind,
                      name: project.nodes[e.target]?.name ?? e.target,
                    }));
                  return (
                    <div className="rounded-lg bg-slate-950/90 p-2 border border-white/5 space-y-1.5">
                      <div className="flex items-center gap-1.5 overflow-x-auto">
                        <span className="shrink-0 text-[10px] font-semibold text-slate-400">
                          ↑ 调用方 ({callers.length}):
                        </span>
                        {callers.length > 0 ? (
                          callers.map((c) => (
                            <button
                              key={`in_${c.id}`}
                              type="button"
                              onClick={() => selectNode(c.id, true)}
                              className="shrink-0 rounded bg-slate-800/90 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 hover:bg-cyan-500/20 border border-white/5"
                            >
                              {c.name}()
                            </button>
                          ))
                        ) : (
                          <span className="text-[10px] text-slate-500">
                            顶层入口 / 中断向量
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 overflow-x-auto">
                        <span className="shrink-0 text-[10px] font-semibold text-slate-400">
                          ↓ 子调用 ({callees.length}):
                        </span>
                        {callees.length > 0 ? (
                          callees.map((c) => (
                            <button
                              key={`out_${c.id}`}
                              type="button"
                              onClick={() => selectNode(c.id, true)}
                              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] border ${
                                c.kind !== "DIRECT"
                                  ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                                  : "bg-slate-800/90 text-emerald-300 border-white/5"
                              } hover:opacity-80`}
                            >
                              {c.kind !== "DIRECT" ? "⚡ " : ""}
                              {c.name}()
                            </button>
                          ))
                        ) : (
                          <span className="text-[10px] text-slate-500">
                            末端叶函数
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="flex-1 min-h-[300px]">
              <Editor
                height="100%"
                language="c"
                theme="vs-dark"
                value={sourceCode}
                onMount={(editor) => {
                  editorRef.current = editor;
                  highlightTargetLines();
                }}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  padding: { top: 10 },
                  renderLineHighlight: "all",
                }}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
