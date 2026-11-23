import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  ArchLayer,
  EntryCategory,
  FeatureEntry,
  FlowStep,
  ProjectAnalysis,
  ViewMode,
} from "../types/analysis";
import { DEMO_PROJECT } from "../data/demoProject";

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface AnalysisProgressInfo {
  percent: number;
  stage: string;
  detail: string;
}

export type RightPanelTab = "SOURCE" | "PORTING" | "FLOW";
export type RightDrawerLayout = "SPLIT" | "FLOATING" | "DETACHED";

const SYNC_CHANNEL_NAME = "chain_analysis_sync_v1";
const syncChannel =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel(SYNC_CHANNEL_NAME)
    : null;

function broadcastState(payload: Record<string, unknown>) {
  try {
    syncChannel?.postMessage(payload);
  } catch {
    // ignore
  }
}

interface ChainStore {
  project: ProjectAnalysis;
  currentRepoPath: string;
  isLoadingProject: boolean;
  analysisProgress: AnalysisProgressInfo;
  loadError: string | null;
  activeEntryId: string;
  viewMode: ViewMode;
  heatmapEnabled: boolean;
  selectedNodeId: string | null;
  expandedSnippetIds: Record<string, boolean>;
  collapsedSubtreeIds: Record<string, boolean>;
  layerOverrides: Record<string, ArchLayer>;
  suCalibratedCount: number;

  // Panels & Modals
  leftHudOpen: boolean;
  rightDrawerOpen: boolean;
  rightDrawerLayout: RightDrawerLayout;
  rightDrawerWidth: number;
  activeSourceFile: string | null;
  rightTab: RightPanelTab;
  aiPromptModalOpen: boolean;
  portingCodeModalOpen: boolean;
  openProjectModalOpen: boolean;

  // Actions
  setProject: (project: ProjectAnalysis, repoPath?: string) => void;
  loadLocalProject: (repoPath?: string) => Promise<void>;
  loadBuiltinDemo: () => void;
  createCustomEntryFromNode: (rootNodeId: string) => void;
  applySuStackCalibration: (suText: string) => number;
  setActiveEntry: (entryId: string) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleHeatmap: () => void;
  selectNode: (nodeId: string | null, openDrawer?: boolean) => void;
  openFileInEditor: (filePath: string, line?: number) => void;
  toggleSnippet: (nodeId: string) => void;
  toggleCollapseSubtree: (nodeId: string) => void;
  setNodeLayerOverride: (nodeId: string, layer: ArchLayer) => void;
  resetLayerOverrides: () => void;
  setLeftHudOpen: (open: boolean) => void;
  setRightDrawerOpen: (open: boolean) => void;
  setRightDrawerLayout: (layout: RightDrawerLayout) => void;
  setRightDrawerWidth: (width: number) => void;
  setRightTab: (tab: RightPanelTab) => void;
  setAiPromptModalOpen: (open: boolean) => void;
  setPortingCodeModalOpen: (open: boolean) => void;
  setOpenProjectModalOpen: (open: boolean) => void;
  applyRemoteSync: (payload: Record<string, unknown>) => void;
}

export const useChainStore = create<ChainStore>((set) => ({
  project: DEMO_PROJECT,
  currentRepoPath: "D:\\3-code\\USB\\CherryUSB-1.6.1",
  isLoadingProject: false,
  analysisProgress: { percent: 0, stage: "", detail: "" },
  loadError: null,
  activeEntryId: DEMO_PROJECT.entries[0].id,
  viewMode: "CANVAS",
  heatmapEnabled: false,
  selectedNodeId: DEMO_PROJECT.entries[0].entryNodeId,
  expandedSnippetIds: {
    Ymodem_Parse_Packet: true,
    usbh_enumerate: true,
    cdc_acm_class_interface_request_handler: true,
  },
  collapsedSubtreeIds: {},
  layerOverrides: {},
  suCalibratedCount: 0,

  leftHudOpen: true,
  rightDrawerOpen: true,
  rightDrawerLayout: "SPLIT",
  rightDrawerWidth: 460,
  activeSourceFile: null,
  rightTab: "PORTING",
  aiPromptModalOpen: false,
  portingCodeModalOpen: false,
  openProjectModalOpen: false,

  setProject: (project, repoPath) =>
    set((state) => {
      const firstEntry = project.entries[0];
      return {
        project,
        currentRepoPath: repoPath ?? state.currentRepoPath,
        activeEntryId: firstEntry?.id ?? "",
        selectedNodeId: firstEntry?.entryNodeId ?? null,
        collapsedSubtreeIds: {},
        layerOverrides: {},
        suCalibratedCount: 0,
        loadError: null,
      };
    }),

  loadLocalProject: async (repoPath) => {
    const target = repoPath || "D:\\3-code\\USB\\CherryUSB-1.6.1";
    set({
      isLoadingProject: true,
      loadError: null,
      analysisProgress: {
        percent: 8,
        stage: "正在启动静态解析引擎...",
        detail: target,
      },
    });

    let unlisten: UnlistenFn | null = null;
    let fakeTimer: ReturnType<typeof setInterval> | null = null;

    try {
      let proj: ProjectAnalysis;

      if (isTauriDesktop()) {
        // Listen to real-time progress events emitted by Rust analyzer thread
        try {
          unlisten = await listen<AnalysisProgressInfo>(
            "analysis-progress",
            (event) => {
              if (event.payload) {
                set({ analysisProgress: event.payload });
              }
            }
          );
        } catch {
          // ignore listener error
        }

        // Direct Rust IPC call first (0 network timeout delay!)
        try {
          proj = await invoke<ProjectAnalysis>("analyze_c_project", {
            path: target,
          });
        } catch (ipcErr) {
          // Fallback to dev server if running inside tauri dev with vite
          const resp = await fetch(
            `/api/analyze?path=${encodeURIComponent(target)}`
          );
          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            throw ipcErr;
          }
          proj = data.project;
        }
      } else {
        // Browser mode: smooth simulated progress steps while /api/analyze runs
        const stages = [
          { percent: 22, stage: "正在扫描工程目录与 .c/.h 源文件...", detail: target },
          { percent: 48, stage: "正在构建 #include 头文件级联闭包...", detail: "解析宏常量与头文件树" },
          { percent: 74, stage: "正在解析函数 AST 与局部栈帧大小...", detail: "计算最坏栈深 WCS 与递归环" },
          { percent: 90, stage: "正在缝合调用链与结构体函数指针回调...", detail: "生成四层架构泳道与移植清单" },
        ];
        let stepIdx = 0;
        fakeTimer = setInterval(() => {
          if (stepIdx < stages.length) {
            set({ analysisProgress: stages[stepIdx] });
            stepIdx++;
          }
        }, 90);

        const resp = await fetch(
          `/api/analyze?path=${encodeURIComponent(target)}`
        );
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || "加载工程失败");
        }
        proj = data.project;
      }

      set({
        analysisProgress: {
          percent: 100,
          stage: "静态解析完成！",
          detail: `共提取 ${Object.keys(proj.nodes).length} 个函数符号`,
        },
      });

      const firstEntry = proj.entries[0];
      set({
        project: proj,
        currentRepoPath: target,
        activeEntryId: firstEntry?.id ?? "",
        selectedNodeId: firstEntry?.entryNodeId ?? null,
        activeSourceFile: null,
        collapsedSubtreeIds: {},
        layerOverrides: {},
        suCalibratedCount: 0,
        isLoadingProject: false,
        loadError: null,
        openProjectModalOpen: false,
      });
    } catch (err: unknown) {
      set({
        isLoadingProject: false,
        loadError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (unlisten) unlisten();
      if (fakeTimer) clearInterval(fakeTimer);
    }
  },

  loadBuiltinDemo: () =>
    set({
      project: DEMO_PROJECT,
      currentRepoPath: "内置 Demo (STM32F4 + FreeRTOS + Ymodem/FOC)",
      activeEntryId: DEMO_PROJECT.entries[0].id,
      selectedNodeId: DEMO_PROJECT.entries[0].entryNodeId,
      collapsedSubtreeIds: {},
      layerOverrides: {},
      suCalibratedCount: 0,
      loadError: null,
      openProjectModalOpen: false,
    }),

  /**
   * Dynamically build a custom call-chain entry rooted at ANY function in the repository
   * (includes direct upstream callers + full downstream call/callback tree!)
   */
  createCustomEntryFromNode: (rootNodeId) =>
    set((state) => {
      const rootNode = state.project.nodes[rootNodeId];
      if (!rootNode) return state;

      const existingId = `custom_${rootNodeId}`;
      const existing = state.project.entries.find((e) => e.id === existingId);
      if (existing) {
        return {
          activeEntryId: existingId,
          selectedNodeId: rootNodeId,
          collapsedSubtreeIds: {},
        };
      }

      const outAdj = new Map<string, string[]>();
      const inAdj = new Map<string, string[]>();
      for (const id of Object.keys(state.project.nodes)) {
        outAdj.set(id, []);
        inAdj.set(id, []);
      }
      for (const e of state.project.edges) {
        outAdj.get(e.source)?.push(e.target);
        inAdj.get(e.target)?.push(e.source);
      }

      const collected = new Set<string>([rootNodeId]);
      // Include direct upstream callers (1 hop) so user sees who calls/triggers this function
      for (const caller of (inAdj.get(rootNodeId) ?? []).slice(0, 4)) {
        collected.add(caller);
      }
      // BFS downstream up to 24 nodes
      const queue = [rootNodeId];
      while (queue.length > 0 && collected.size < 24) {
        const curr = queue.shift()!;
        for (const nxt of outAdj.get(curr) ?? []) {
          if (!collected.has(nxt) && collected.size < 24) {
            collected.add(nxt);
            queue.push(nxt);
          }
        }
      }

      const nodeIds = Array.from(collected);
      const edgeIds = state.project.edges
        .filter((e) => collected.has(e.source) && collected.has(e.target))
        .map((e) => e.id);

      const category: EntryCategory = rootNode.isIsr
        ? "ISR"
        : rootNode.name.includes("thread") || rootNode.name.includes("task")
        ? "RTOS_TASK"
        : rootNode.name.includes("init")
        ? "MAIN_LOOP"
        : "PUBLIC_API";

      const outline: FlowStep[] = nodeIds.slice(0, 6).map((nid, idx) => {
        const fn = state.project.nodes[nid];
        return {
          id: `cust_step_${nid}_${idx}`,
          stage:
            nid === rootNodeId
              ? "★ 目标焦点入口"
              : (inAdj.get(rootNodeId) ?? []).includes(nid)
              ? "↑ 上游调用/触发方"
              : `↓ 下游链路 ${idx}`,
          title: `${fn.name}()`,
          nodeId: nid,
          detail: fn.brief,
          tag:
            fn.layer === "HAL"
              ? "HAL"
              : fn.isCallback
              ? "CALLBACK"
              : fn.hasStateMachine
              ? "FSM"
              : "INIT",
        };
      });

      const newEntry: FeatureEntry = {
        id: existingId,
        name: rootNode.name,
        displayName: `[自定义追踪] ${rootNode.name}()`,
        category,
        entryNodeId: rootNodeId,
        summary: `以 ${rootNode.file}:${rootNode.lineStart} 的 ${rootNode.name}() 为核心自动生成的上下游调用与回调闭包（共 ${nodeIds.length} 个关联函数）。`,
        nodeIds,
        edgeIds,
        configMacros: [],
        staticFlowOutline: outline,
      };

      return {
        project: {
          ...state.project,
          entries: [newEntry, ...state.project.entries],
        },
        activeEntryId: existingId,
        selectedNodeId: rootNodeId,
        collapsedSubtreeIds: {},
      };
    }),

  /**
   * Parse GCC -fstack-usage (.su) lines to calibrate function stackBytes with compiler-exact numbers.
   * Format example: core/usbd_core.c:986:6:usbd_event_reset_handler	48	static
   */
  applySuStackCalibration: (suText) => {
    let matchedCount = 0;
    set((state) => {
      const updatedNodes = { ...state.project.nodes };
      const lines = suText.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Match either "file:line:col:funcName  bytes  type" or "funcName bytes"
        const m =
          trimmed.match(/:([a-zA-Z_]\w*)\s+(\d+)\s+(?:static|dynamic|bounded)/) ||
          trimmed.match(/^([a-zA-Z_]\w*)\s+(\d+)\b/);
        if (m) {
          const fnName = m[1];
          const exactBytes = parseInt(m[2], 10);
          if (updatedNodes[fnName] && !Number.isNaN(exactBytes)) {
            updatedNodes[fnName] = {
              ...updatedNodes[fnName],
              stackBytes: exactBytes,
            };
            matchedCount++;
          }
        }
      }
      return {
        project: {
          ...state.project,
          nodes: updatedNodes,
        },
        suCalibratedCount: state.suCalibratedCount + matchedCount,
      };
    });
    return matchedCount;
  },

  setActiveEntry: (entryId) =>
    set((state) => {
      const entry = state.project.entries.find((e) => e.id === entryId);
      const nextNodeId = entry?.entryNodeId ?? null;
      broadcastState({
        type: "SYNC_SELECTION",
        activeEntryId: entryId,
        selectedNodeId: nextNodeId,
        activeSourceFile: null,
      });
      return {
        activeEntryId: entryId,
        selectedNodeId: nextNodeId,
        activeSourceFile: null,
        collapsedSubtreeIds: {},
      };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleHeatmap: () =>
    set((state) => ({ heatmapEnabled: !state.heatmapEnabled })),
  selectNode: (nodeId, openDrawer = false) =>
    set((state) => {
      const fn = nodeId ? state.project.nodes[nodeId] : undefined;
      const nextTab = openDrawer ? "SOURCE" : state.rightTab;
      broadcastState({
        type: "SYNC_SELECTION",
        activeEntryId: state.activeEntryId,
        selectedNodeId: nodeId,
        activeSourceFile: fn?.file ?? null,
        rightTab: nextTab,
      });
      return {
        selectedNodeId: nodeId,
        activeSourceFile: fn?.file ?? state.activeSourceFile,
        rightDrawerOpen: openDrawer ? true : state.rightDrawerOpen,
        rightTab: nextTab,
      };
    }),
  openFileInEditor: (filePath) =>
    set((state) => {
      broadcastState({
        type: "SYNC_FILE",
        activeSourceFile: filePath,
        rightTab: "SOURCE",
      });
      return {
        activeSourceFile: filePath,
        rightTab: "SOURCE",
        rightDrawerOpen: true,
      };
    }),
  toggleSnippet: (nodeId) =>
    set((state) => ({
      expandedSnippetIds: {
        ...state.expandedSnippetIds,
        [nodeId]: !state.expandedSnippetIds[nodeId],
      },
    })),
  toggleCollapseSubtree: (nodeId) =>
    set((state) => ({
      collapsedSubtreeIds: {
        ...state.collapsedSubtreeIds,
        [nodeId]: !state.collapsedSubtreeIds[nodeId],
      },
    })),
  setNodeLayerOverride: (nodeId, layer) =>
    set((state) => {
      const next = {
        ...state.layerOverrides,
        [nodeId]: layer,
      };
      broadcastState({ type: "SYNC_OVERRIDES", layerOverrides: next });
      return { layerOverrides: next };
    }),
  resetLayerOverrides: () => {
    broadcastState({ type: "SYNC_OVERRIDES", layerOverrides: {} });
    set({ layerOverrides: {} });
  },
  setLeftHudOpen: (open) => set({ leftHudOpen: open }),
  setRightDrawerOpen: (open: boolean) => set({ rightDrawerOpen: open }),
  setRightDrawerLayout: (layout) => set({ rightDrawerLayout: layout }),
  setRightDrawerWidth: (width) =>
    set({ rightDrawerWidth: Math.max(360, Math.min(980, width)) }),
  setRightTab: (tab) => set({ rightTab: tab, rightDrawerOpen: true }),
  setAiPromptModalOpen: (open) => set({ aiPromptModalOpen: open }),
  setPortingCodeModalOpen: (open) => set({ portingCodeModalOpen: open }),
  setOpenProjectModalOpen: (open) => set({ openProjectModalOpen: open }),
  applyRemoteSync: (payload) =>
    set((state) => {
      if (payload.type === "SYNC_SELECTION") {
        return {
          activeEntryId:
            (payload.activeEntryId as string) ?? state.activeEntryId,
          selectedNodeId:
            (payload.selectedNodeId as string | null) ?? state.selectedNodeId,
          activeSourceFile:
            (payload.activeSourceFile as string | null) ??
            state.activeSourceFile,
          rightTab:
            (payload.rightTab as RightPanelTab | undefined) ?? state.rightTab,
        };
      }
      if (payload.type === "SYNC_FILE") {
        return {
          activeSourceFile:
            (payload.activeSourceFile as string | null) ??
            state.activeSourceFile,
          rightTab: "SOURCE",
        };
      }
      if (payload.type === "SYNC_OVERRIDES") {
        return {
          layerOverrides:
            (payload.layerOverrides as Record<string, ArchLayer>) ?? {},
        };
      }
      if (payload.type === "POPUP_CLOSED") {
        return {
          rightDrawerLayout: "SPLIT",
          rightDrawerOpen: true,
        };
      }
      return state;
    }),
}));

if (syncChannel) {
  syncChannel.onmessage = (ev) => {
    if (ev.data && typeof ev.data === "object") {
      useChainStore.getState().applyRemoteSync(ev.data);
    }
  };
}
