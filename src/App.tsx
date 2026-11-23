import React, { useEffect, useMemo } from "react";
import { useChainStore } from "./store/useChainStore";
import {
  buildAiPortingPrompt,
  buildPortingAdapterSkeleton,
  computePortingBoundary,
  computeStackMetrics,
} from "./utils/graphMetrics";
import { ChainCanvas } from "./components/canvas/ChainCanvas";
import { SequenceTimelineView } from "./components/canvas/SequenceTimelineView";
import { TopTelemetryBar } from "./components/hud/TopTelemetryBar";
import { FeatureSelectorHud } from "./components/hud/FeatureSelectorHud";
import { RightAnalysisDrawer } from "./components/drawer/RightAnalysisDrawer";
import { AiPromptModal } from "./components/hud/AiPromptModal";
import { OpenProjectModal } from "./components/hud/OpenProjectModal";
import { PortingCodeModal } from "./components/hud/PortingCodeModal";

export function App() {
  const project = useChainStore((s) => s.project);
  const activeEntryId = useChainStore((s) => s.activeEntryId);
  const viewMode = useChainStore((s) => s.viewMode);
  const rightDrawerLayout = useChainStore((s) => s.rightDrawerLayout);
  const layerOverrides = useChainStore((s) => s.layerOverrides);
  const aiPromptModalOpen = useChainStore((s) => s.aiPromptModalOpen);
  const setAiPromptModalOpen = useChainStore((s) => s.setAiPromptModalOpen);
  const portingCodeModalOpen = useChainStore((s) => s.portingCodeModalOpen);
  const setPortingCodeModalOpen = useChainStore(
    (s) => s.setPortingCodeModalOpen
  );
  const isLoadingProject = useChainStore((s) => s.isLoadingProject);
  const analysisProgress = useChainStore((s) => s.analysisProgress);
  const openProjectModalOpen = useChainStore((s) => s.openProjectModalOpen);
  const loadLocalProject = useChainStore((s) => s.loadLocalProject);

  const isStandaloneDrawerWindow = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("standalone") === "drawer"
    );
  }, []);

  // Auto-load real local CherryUSB-1.6.1 repository on startup
  useEffect(() => {
    loadLocalProject("D:\\3-code\\USB\\CherryUSB-1.6.1");
  }, [loadLocalProject]);

  // If this is the popped-out standalone drawer window, notify main window when closed
  useEffect(() => {
    if (!isStandaloneDrawerWindow) return;
    document.title = "ChainAnalysis — 独立源码与移植分析副窗口";
    const onUnload = () => {
      try {
        const ch = new BroadcastChannel("chain_analysis_sync_v1");
        ch.postMessage({ type: "POPUP_CLOSED" });
        ch.close();
      } catch {
        // ignore
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [isStandaloneDrawerWindow]);

  const activeEntry = useMemo(
    () =>
      project.entries.find((e) => e.id === activeEntryId) ?? project.entries[0],
    [project.entries, activeEntryId]
  );

  const stackMetrics = useMemo(
    () =>
      computeStackMetrics(
        activeEntry,
        project.nodes,
        project.edges,
        project.detectedMspStackBytes,
        project.mspStackSource
      ),
    [
      activeEntry,
      project.nodes,
      project.edges,
      project.detectedMspStackBytes,
      project.mspStackSource,
    ]
  );

  const portingBoundary = useMemo(
    () => computePortingBoundary(project, activeEntry, layerOverrides),
    [project, activeEntry, layerOverrides]
  );

  const aiPromptText = useMemo(
    () =>
      buildAiPortingPrompt(
        project,
        activeEntry,
        stackMetrics,
        portingBoundary,
        layerOverrides
      ),
    [project, activeEntry, stackMetrics, portingBoundary, layerOverrides]
  );

  const portingAdapterCode = useMemo(
    () =>
      buildPortingAdapterSkeleton(
        project,
        activeEntry,
        stackMetrics,
        portingBoundary
      ),
    [project, activeEntry, stackMetrics, portingBoundary]
  );

  const filesToCopyList = useMemo(
    () => portingBoundary.coreFilesToCopy.map((f) => f.file),
    [portingBoundary]
  );

  // Standalone Pop-Out Window Mode: 100% dedicated to Source Reader, Porting Checklist & Flow Outline
  if (isStandaloneDrawerWindow) {
    return (
      <main className="h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
        <RightAnalysisDrawer
          activeEntry={activeEntry}
          stackMetrics={stackMetrics}
          porting={portingBoundary}
          isStandaloneWindow={true}
        />
        <AiPromptModal
          open={aiPromptModalOpen}
          promptText={aiPromptText}
          onClose={() => setAiPromptModalOpen(false)}
        />
        <PortingCodeModal
          open={portingCodeModalOpen}
          featureName={activeEntry.name.toLowerCase()}
          fileName={`port_${activeEntry.name.toLowerCase()}_adapter.c`}
          adapterCode={portingAdapterCode}
          filesToCopy={filesToCopyList}
          portingGuideMd={aiPromptText}
          onClose={() => setPortingCodeModalOpen(false)}
        />
      </main>
    );
  }

  return (
    <main className="relative flex h-screen w-screen overflow-hidden bg-[#070b13] text-slate-100">
      {/* Top Floating Telemetry & 3-Way View Switcher */}
      <TopTelemetryBar
        stackMetrics={stackMetrics}
        porting={portingBoundary}
      />

      {/* Left / Center Canvas Area (automatically expands when right panel is closed, detached, or resized in SPLIT mode!) */}
      <div className="relative flex-1 h-full min-w-0 overflow-hidden">
        {viewMode === "SEQUENCE" ? (
          <SequenceTimelineView
            activeEntry={activeEntry}
            stackMetrics={stackMetrics}
          />
        ) : (
          <ChainCanvas stackMetrics={stackMetrics} />
        )}

        {/* Top-Left Floating Feature Entry Pill / Drawer */}
        <FeatureSelectorHud />

        {/* If right drawer is in FLOATING mode, render it inside the canvas container */}
        {rightDrawerLayout === "FLOATING" && (
          <RightAnalysisDrawer
            activeEntry={activeEntry}
            stackMetrics={stackMetrics}
            porting={portingBoundary}
          />
        )}
      </div>

      {/* If right drawer is in SPLIT mode, dock it side-by-side so it NEVER obscures the center canvas */}
      {rightDrawerLayout === "SPLIT" && (
        <RightAnalysisDrawer
          activeEntry={activeEntry}
          stackMetrics={stackMetrics}
          porting={portingBoundary}
        />
      )}

      {/* Zero-API-Key AI Prompt Export Modal */}
      <AiPromptModal
        open={aiPromptModalOpen}
        promptText={aiPromptText}
        onClose={() => setAiPromptModalOpen(false)}
      />

      {/* 1-Click Porting Adapter C Skeleton, Package Exporter & GCC .su Calibration Modal */}
      <PortingCodeModal
        open={portingCodeModalOpen}
        featureName={activeEntry.name.toLowerCase()}
        fileName={`port_${activeEntry.name.toLowerCase()}_adapter.c`}
        adapterCode={portingAdapterCode}
        filesToCopy={filesToCopyList}
        portingGuideMd={aiPromptText}
        onClose={() => setPortingCodeModalOpen(false)}
      />

      {/* Local Repository Path Switcher Modal */}
      <OpenProjectModal />

      {/* Global Floating Analysis Progress Banner (when loading outside modal) */}
      {isLoadingProject && !openProjectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="w-[420px] rounded-2xl border border-white/15 bg-slate-950/95 p-5 shadow-2xl space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-100">
                {analysisProgress.stage || "正在静态解析 C/C++ 工程..."}
              </span>
              <span className="font-mono font-bold text-cyan-300">
                {analysisProgress.percent}%
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400 transition-all duration-150"
                style={{
                  width: `${Math.max(8, Math.min(100, analysisProgress.percent))}%`,
                }}
              />
            </div>
            {analysisProgress.detail && (
              <div className="truncate font-mono text-[11px] text-slate-400">
                📄 {analysisProgress.detail}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
