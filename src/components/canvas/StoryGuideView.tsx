import React, { useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Compass,
  Database,
  FileCode2,
  GitBranch,
  Layers,
  Network,
  Sparkles,
  Zap,
} from "lucide-react";
import { useChainStore } from "../../store/useChainStore";
import { FeatureEntry } from "../../types/analysis";
import { buildFeatureStory, StoryStage } from "../../utils/storyAnalyzer";
import { SWIMLANE_META } from "../../utils/layoutEngine";

interface StoryGuideViewProps {
  activeEntry: FeatureEntry;
}

export const StoryGuideView: React.FC<StoryGuideViewProps> = ({ activeEntry }) => {
  const project = useChainStore((s) => s.project);
  const selectedNodeId = useChainStore((s) => s.selectedNodeId);
  const selectNode = useChainStore((s) => s.selectNode);
  const selectEdge = useChainStore((s) => s.selectEdge);
  const setViewMode = useChainStore((s) => s.setViewMode);
  const setActiveEntry = useChainStore((s) => s.setActiveEntry);
  const openFileInEditor = useChainStore((s) => s.openFileInEditor);
  const leftHudOpen = useChainStore((s) => s.leftHudOpen);

  const [expandedFileOverview, setExpandedFileOverview] = useState(false);

  const story = useMemo(
    () => buildFeatureStory(project, activeEntry),
    [project, activeEntry]
  );

  const handleDrillToCanvas = (stage: StoryStage) => {
    if (stage.focusEntryId && stage.focusEntryId !== activeEntry.id) {
      setActiveEntry(stage.focusEntryId);
    }
    setViewMode("CANVAS");
  };

  return (
    <div
      className={`h-full w-full overflow-y-auto bg-[#0e131a] pt-20 pb-14 pr-6 transition-all duration-200 ${
        leftHudOpen ? "pl-[318px]" : "pl-6"
      }`}
    >
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Hero Overview Banner — Refined Editorial Slate */}
        <section className="rounded-2xl border border-slate-300/10 bg-[#141b26] p-6 shadow-[0_8px_30px_rgba(0,0,0,0.28)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#7b9acc]/35 bg-[#7b9acc]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#a9c2eb]">
                  <BookOpen className="h-3 w-3" />
                  离线源码导览
                </span>
                {story.domainTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-slate-300/10 bg-slate-800/70 px-2.5 py-0.5 text-[11px] text-slate-300"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <h1 className="text-lg font-semibold tracking-tight text-[#e8eef5]">
                {story.headline}
              </h1>
              <p className="text-[13px] leading-relaxed text-[#9aa7b8]">
                {story.executiveSummary}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setViewMode("CANVAS")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#7b9acc]/35 bg-[#7b9acc]/15 px-3.5 py-2 text-xs font-medium text-[#c5d7f2] hover:bg-[#7b9acc]/25 transition-colors cursor-pointer"
            >
              <Network className="h-3.5 w-3.5" />
              切换到完整调用图谱
            </button>
          </div>

          {/* Subtle Key Metrics Strip */}
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5 border-t border-slate-300/10 pt-4">
            <div className="rounded-xl bg-[#101620] px-3 py-2 border border-slate-300/[0.06]">
              <div className="text-[10px] text-[#7c8a9e]">关联核心函数</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#dce4ee]">
                {story.stats.involvedFunctions}{" "}
                <span className="text-[11px] font-normal text-[#6f7e92]">
                  / {story.stats.totalFunctions}
                </span>
              </div>
            </div>
            <div className="rounded-xl bg-[#101620] px-3 py-2 border border-slate-300/[0.06]">
              <div className="text-[10px] text-[#7c8a9e]">生命周期阶段</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#a9c2eb]">
                {story.stages.length} 阶段
              </div>
            </div>
            <div className="rounded-xl bg-[#101620] px-3 py-2 border border-slate-300/[0.06]">
              <div className="text-[10px] text-[#7c8a9e]">识别状态机</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#bfb0df]">
                {story.stats.stateMachineCount} 个 FSM
              </div>
            </div>
            <div className="rounded-xl bg-[#101620] px-3 py-2 border border-slate-300/[0.06]">
              <div className="text-[10px] text-[#7c8a9e]">函数指针 / 回调跳转</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#dfba89]">
                {story.stats.callbackCount} 处
              </div>
            </div>
          </div>

          {/* Horizontal Lifecycle Ribbon */}
          {story.stages.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {story.stages.map((st, idx) => (
                <React.Fragment key={st.kind}>
                  <a
                    href={`#story-stage-${st.kind}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300/10 bg-[#101620] px-2.5 py-1.5 text-xs text-slate-200 hover:border-slate-300/25 transition-colors"
                  >
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-[#0e131a]"
                      style={{ backgroundColor: st.accentHex }}
                    >
                      {st.stepNumber}
                    </span>
                    <span className="font-medium">{st.title}</span>
                  </a>
                  {idx < story.stages.length - 1 && (
                    <ArrowRight className="h-3.5 w-3.5 text-slate-600 shrink-0" />
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </section>

        {/* Chronological Lifecycle Stages */}
        <div className="space-y-4">
          {story.stages.map((stage) => (
            <section
              key={stage.kind}
              id={`story-stage-${stage.kind}`}
              className="rounded-2xl border border-slate-300/10 bg-[#141b26] overflow-hidden shadow-[0_4px_20px_rgba(0,0,0,0.22)]"
            >
              {/* Stage Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300/[0.08] bg-[#17202d] px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold text-[#0e131a]"
                    style={{ backgroundColor: stage.accentHex }}
                  >
                    0{stage.stepNumber}
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-[#e6edf3]">
                      {stage.title}
                    </h2>
                    <p className="text-[11px] text-[#8b98a9]">{stage.subtitle}</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleDrillToCanvas(stage)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300/12 bg-[#101620] px-2.5 py-1 text-[11px] text-[#b4c2d4] hover:border-[#7b9acc]/40 hover:text-[#e6edf3] transition-colors cursor-pointer"
                >
                  <Compass className="h-3 w-3" />
                  在调用图谱中展开
                </button>
              </div>

              <div className="p-5 space-y-4">
                {/* 1. Ordered State Machine Flow (if this stage contains switch-case FSMs!) */}
                {stage.stateMachines.length > 0 && (
                  <div className="space-y-3">
                    {stage.stateMachines.map((fsm) => (
                      <div
                        key={fsm.ownerFn.id}
                        className="rounded-xl border border-[#9e8bc7]/25 bg-[#101620] p-3.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                          <div className="flex items-center gap-2">
                            <GitBranch className="h-3.5 w-3.5 text-[#b5a4db]" />
                            <span className="text-xs font-semibold text-[#e2e8f0]">
                              状态机流转：
                            </span>
                            <button
                              type="button"
                              onClick={() => selectNode(fsm.ownerFn.id, true)}
                              className="font-mono text-xs font-semibold text-[#b5a4db] hover:underline cursor-pointer"
                            >
                              {fsm.ownerFn.name}()
                            </button>
                            <span className="rounded bg-slate-800/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                              switch ({fsm.switchExpr})
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-slate-500">
                            {fsm.ownerFn.file}:{fsm.ownerFn.lineStart}
                          </span>
                        </div>

                        <div className="space-y-2">
                          {fsm.steps.map((step, sIdx) => (
                            <div
                              key={`${fsm.ownerFn.id}_${step.stateName}`}
                              className="flex flex-wrap items-start gap-2.5 rounded-lg border border-slate-300/[0.06] bg-[#151d29] px-3 py-2"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  selectNode(fsm.ownerFn.id, true);
                                  if (step.line) {
                                    openFileInEditor(fsm.ownerFn.file, step.line);
                                  }
                                }}
                                title="点击在右侧直接定位到此 case 源码行"
                                className="inline-flex items-center gap-1.5 rounded-md border border-[#9e8bc7]/30 bg-[#9e8bc7]/12 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#d2c6ed] hover:bg-[#9e8bc7]/25 transition-colors cursor-pointer shrink-0"
                              >
                                <span className="text-[10px] opacity-65">
                                  {sIdx + 1}.
                                </span>
                                {step.stateName}
                              </button>

                              {step.triggeredTargets.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                  <ArrowRight className="h-3 w-3 text-slate-500 shrink-0" />
                                  {step.triggeredTargets.map(({ node, edge }) => {
                                    const isCb =
                                      edge?.relationType === "INVOKE_CB" ||
                                      node.isCallback;
                                    return (
                                      <button
                                        key={`${step.stateName}_${node.id}`}
                                        type="button"
                                        onClick={() => {
                                          if (edge) {
                                            selectEdge(edge.id, true);
                                          } else {
                                            selectNode(node.id, true);
                                          }
                                        }}
                                        title={
                                          edge
                                            ? `点击透视调用现场与分支条件：${edge.callSiteExpr || node.name}`
                                            : node.brief
                                        }
                                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer ${
                                          isCb
                                            ? "border-[#d2a266]/35 bg-[#d2a266]/12 text-[#e6c494] hover:bg-[#d2a266]/22"
                                            : "border-slate-300/10 bg-[#101620] text-[#cbd5e1] hover:border-[#7b9acc]/40 hover:text-white"
                                        }`}
                                      >
                                        {isCb && <Zap className="h-2.5 w-2.5 text-[#d2a266]" />}
                                        {node.name}()
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : (
                                <span className="text-[11px] text-slate-500 pt-0.5">
                                  状态切换 / 等待条件就绪
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 2. Callback Table Registrations (in INIT stage) */}
                {stage.bindings.length > 0 && (
                  <div className="rounded-xl border border-[#68a8b8]/25 bg-[#101620] p-3">
                    <div className="mb-2 text-[11px] font-semibold text-[#97c9d6]">
                      📌 本阶段绑定的回调接口 / 函数指针
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {stage.bindings.map(({ edge, target }) => (
                        <button
                          key={edge.id}
                          type="button"
                          onClick={() => selectEdge(edge.id, true)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#68a8b8]/25 bg-[#151e2b] px-2.5 py-1 font-mono text-[11px] text-[#b4dae3] hover:border-[#68a8b8]/55 transition-colors cursor-pointer"
                        >
                          <span>{edge.label || target.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 3. Milestone Functions Grid (Clean 2-Column Reading Cards) */}
                {stage.milestones.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {stage.milestones.map((m) => {
                      const layerMeta = SWIMLANE_META[m.node.layer];
                      const isSel = selectedNodeId === m.node.id;
                      return (
                        <button
                          key={m.node.id}
                          type="button"
                          onClick={() => {
                            if (m.viaEdge && (m.isCallback || m.hasConditions)) {
                              selectEdge(m.viaEdge.id, true);
                            } else {
                              selectNode(m.node.id, true);
                            }
                          }}
                          className={`group text-left rounded-xl border p-3 transition-all cursor-pointer ${
                            isSel
                              ? "border-[#7b9acc]/60 bg-[#1a2536]"
                              : "border-slate-300/[0.08] bg-[#101620] hover:border-slate-300/20 hover:bg-[#161f2d]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
                                style={{
                                  backgroundColor: `${layerMeta.accentColor}20`,
                                  color: layerMeta.accentColor,
                                }}
                              >
                                {layerMeta.badge}
                              </span>
                              {m.isCallback && (
                                <span className="rounded bg-[#d2a266]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#e3be8c]">
                                  ⚡ 回调
                                </span>
                              )}
                              {m.hasConditions && (
                                <span className="rounded bg-[#9e8bc7]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#c5b6e3]">
                                  ⑂ 条件触发
                                </span>
                              )}
                            </div>
                            {m.childCount > 0 && (
                              <span className="font-mono text-[10px] text-slate-500">
                                {m.childCount} 子调用
                              </span>
                            )}
                          </div>

                          <div className="mt-1.5 font-mono text-[13px] font-semibold text-[#e6edf3] truncate group-hover:text-[#b7cff2]">
                            {m.node.name}
                            <span className="font-normal text-slate-500">()</span>
                          </div>
                          <div className="font-mono text-[10px] text-[#738296] truncate">
                            {m.node.file}:{m.node.lineStart}
                          </div>
                          <p className="mt-1.5 text-[11px] leading-relaxed text-[#9aa7b8] line-clamp-2">
                            {m.roleNote}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>

        {/* Cross-Entry Global State & Buffer Relay Tracker */}
        {story.dataRelays.length > 0 && (
          <section className="rounded-2xl border border-slate-300/10 bg-[#141b26] p-5 shadow-[0_4px_20px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between gap-2 mb-3.5">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[#69ad99]" />
                <div>
                  <h2 className="text-sm font-semibold text-[#e6edf3]">
                    跨函数共享状态与数据接力
                  </h2>
                  <p className="text-[11px] text-[#8b98a9]">
                    追踪全局变量/结构体句柄的写入方与消费方，看懂初始化、中断与主循环如何协作
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              {story.dataRelays.map((relay) => (
                <div
                  key={relay.name}
                  className="rounded-xl border border-slate-300/[0.08] bg-[#101620] px-3.5 py-2.5 flex flex-wrap items-center gap-2.5 text-xs"
                >
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => openFileInEditor(relay.file, relay.line)}
                      className="rounded-md border border-[#69ad99]/35 bg-[#69ad99]/12 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#9ed1c2] hover:bg-[#69ad99]/22 cursor-pointer"
                    >
                      {relay.name}
                    </button>
                    {relay.bytes > 0 && (
                      <span className="font-mono text-[10px] text-slate-500">
                        {relay.bytes}B
                      </span>
                    )}
                    {relay.isCrossContext && (
                      <span className="rounded bg-[#d2a266]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#e3be8c]">
                        跨上下文接力
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    {relay.writers.length > 0 && (
                      <>
                        <span className="text-[10px] text-slate-500">写入:</span>
                        {relay.writers.map((w) => (
                          <button
                            key={`w_${relay.name}_${w.id}`}
                            type="button"
                            onClick={() => selectNode(w.id, true)}
                            className="rounded bg-[#1a2333] px-1.5 py-0.5 font-mono text-[10px] text-[#e0b885] hover:bg-[#243146] cursor-pointer"
                          >
                            {w.name}()
                          </button>
                        ))}
                      </>
                    )}
                    {relay.writers.length > 0 && relay.readers.length > 0 && (
                      <ArrowRight className="h-3 w-3 text-slate-600" />
                    )}
                    {relay.readers.length > 0 && (
                      <>
                        <span className="text-[10px] text-slate-500">读取:</span>
                        {relay.readers.map((r) => (
                          <button
                            key={`r_${relay.name}_${r.id}`}
                            type="button"
                            onClick={() => selectNode(r.id, true)}
                            className="rounded bg-[#1a2333] px-1.5 py-0.5 font-mono text-[10px] text-[#a9c2eb] hover:bg-[#243146] cursor-pointer"
                          >
                            {r.name}()
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Collapsible Lightweight Porting / File Architecture Frame */}
        <section className="rounded-2xl border border-slate-300/10 bg-[#141b26] overflow-hidden">
          <button
            type="button"
            onClick={() => setExpandedFileOverview(!expandedFileOverview)}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-[#182130] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#7b9acc]" />
              <span className="text-xs font-semibold text-[#dce4ee]">
                模块文件框架概览（应用 / 协议核心 / 硬件适配）
              </span>
              <span className="text-[11px] text-[#7c8a9e]">
                共{" "}
                {story.fileGroups.appFiles.length +
                  story.fileGroups.coreFiles.length +
                  story.fileGroups.halFiles.length}{" "}
                个核心文件
              </span>
            </div>
            {expandedFileOverview ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )}
          </button>

          {expandedFileOverview && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 border-t border-slate-300/[0.08] p-4">
              <div className="rounded-xl bg-[#101620] p-3 border border-slate-300/[0.06]">
                <div className="text-[11px] font-semibold text-[#a5b4e8] mb-2 flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" /> 应用入口与回调
                </div>
                <div className="space-y-1">
                  {story.fileGroups.appFiles.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => openFileInEditor(f)}
                      className="block w-full truncate text-left font-mono text-[10px] text-[#9aa7b8] hover:text-[#e6edf3] cursor-pointer"
                    >
                      <FileCode2 className="inline h-3 w-3 mr-1 text-slate-500" />
                      {f}
                    </button>
                  ))}
                  {story.fileGroups.appFiles.length === 0 && (
                    <div className="text-[10px] text-slate-500">无</div>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-[#101620] p-3 border border-slate-300/[0.06]">
                <div className="text-[11px] font-semibold text-[#88c4b2] mb-2 flex items-center gap-1.5">
                  <Layers className="h-3 w-3" /> 协议核心（可整体复用）
                </div>
                <div className="space-y-1">
                  {story.fileGroups.coreFiles.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => openFileInEditor(f)}
                      className="block w-full truncate text-left font-mono text-[10px] text-[#9aa7b8] hover:text-[#e6edf3] cursor-pointer"
                    >
                      <FileCode2 className="inline h-3 w-3 mr-1 text-slate-500" />
                      {f}
                    </button>
                  ))}
                  {story.fileGroups.coreFiles.length === 0 && (
                    <div className="text-[10px] text-slate-500">无</div>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-[#101620] p-3 border border-slate-300/[0.06]">
                <div className="text-[11px] font-semibold text-[#d99ca3] mb-2 flex items-center gap-1.5">
                  <Zap className="h-3 w-3" /> 硬件驱动 / BSP 边界
                </div>
                <div className="space-y-1">
                  {story.fileGroups.halFiles.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => openFileInEditor(f)}
                      className="block w-full truncate text-left font-mono text-[10px] text-[#9aa7b8] hover:text-[#e6edf3] cursor-pointer"
                    >
                      <FileCode2 className="inline h-3 w-3 mr-1 text-slate-500" />
                      {f}
                    </button>
                  ))}
                  {story.fileGroups.halFiles.length === 0 && (
                    <div className="text-[10px] text-slate-500">无</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
