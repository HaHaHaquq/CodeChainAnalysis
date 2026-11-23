export type ArchLayer = "APP" | "CORE" | "CALLBACK" | "HAL";

export type EntryCategory =
  | "RTOS_TASK"
  | "ISR"
  | "MAIN_LOOP"
  | "PUBLIC_API"
  | "CMD_TABLE";

export type EdgeKind =
  | "DIRECT"
  | "OPS_TABLE"
  | "ASYNC_CALLBACK"
  | "WEAK_OVERRIDE";

export type ViewMode = "CANVAS" | "SWIMLANE" | "SEQUENCE";

/**
 * Project-level and feature-level execution paradigm:
 * - BARE_METAL: Pure bare-metal (super-loop + ISRs, 0 RTOS dependency)
 * - HYBRID_OPTIONAL_OS: Component library with bare-metal modules + optional OSAL/RTOS modules (e.g. CherryUSB)
 * - RTOS: Multi-threaded RTOS firmware (FreeRTOS / RT-Thread / CMSIS-RTOS / Zephyr)
 */
export type ProjectRuntimeParadigm =
  | "BARE_METAL"
  | "HYBRID_OPTIONAL_OS"
  | "RTOS";

export type FeatureRuntimeRequirement = "BARE_METAL_READY" | "RTOS_REQUIRED";

export interface LocalVarInfo {
  name: string;
  typeStr: string;
  bytes: number;
  isArray?: boolean;
  isVla?: boolean;
  isLarge?: boolean;
}

export interface FunctionNodeData {
  id: string;
  name: string;
  signature: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  layer: ArchLayer;
  isExternal?: boolean;
  isCallback?: boolean;
  isIsr?: boolean;
  hasStateMachine?: boolean;
  stackBytes: number;
  frameOverheadBytes?: number;
  localVars: LocalVarInfo[];
  stackWarnings?: string[];
  readsGlobals: string[];
  writesGlobals: string[];
  callsHeap?: boolean;
  heapApis?: string[];
  snippet: string;
  brief: string;
}

export interface CallEdgeData {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  registeredAt?: string;
  callSiteLine?: number;
}

export interface GlobalVarInfo {
  name: string;
  typeStr: string;
  bytes: number;
  file: string;
  line: number;
  isStatic: boolean;
  section: ".bss" | ".data";
  description: string;
}

export interface FlowStep {
  id: string;
  stage: string;
  title: string;
  nodeId: string;
  detail: string;
  tag?: "INIT" | "FSM" | "CALLBACK" | "HAL" | "WARN";
}

export interface ConfigMacroInfo {
  name: string;
  defaultVal: string;
  file: string;
  purpose: string;
}

export interface FeatureEntry {
  id: string;
  name: string;
  displayName: string;
  category: EntryCategory;
  entryNodeId: string;
  summary: string;
  rtosAllocatedStackBytes?: number;
  nodeIds: string[];
  edgeIds: string[];
  staticFlowOutline: FlowStep[];
  configMacros: ConfigMacroInfo[];
}

export interface ProjectAnalysis {
  projectName: string;
  archBits: 8 | 16 | 32 | 64;
  targetMcuHint: string;
  sourceKind: "DEMO" | "LOCAL_WORKSPACE";
  runtimeParadigm?: ProjectRuntimeParadigm;
  detectedMspStackBytes?: number;
  mspStackSource?: string;
  fileIncludes?: Record<string, string[]>;
  files: Record<string, string>;
  nodes: Record<string, FunctionNodeData>;
  edges: CallEdgeData[];
  globals: GlobalVarInfo[];
  entries: FeatureEntry[];
}

export interface StackMetricsResult {
  maxStackBytes: number;
  maxDepth: number;
  criticalPathNodeIds: string[];
  criticalPathEdgeIds: string[];
  largeStackNodeIds: string[];
  recursionNodeIds: string[];
  recursionEdgeIds: string[];
  hasRecursion: boolean;
  runtimeReq: FeatureRuntimeRequirement;
  osApisUsed: string[];
  stackKind: "MSP_BARE_METAL" | "PSP_RTOS_TASK";
  budgetStackBytes: number;
  budgetSourceLabel: string;
  budgetUsagePercent: number;
  rtosAllocatedBytes?: number;
  rtosUsagePercent?: number;
  rtosOverflowRisk: "SAFE" | "WARNING" | "CRITICAL" | "UNKNOWN";
}

export interface PortingBoundaryResult {
  coreFilesToCopy: { file: string; role: "CORE" | "APP_REF" | "HEADER"; functionCount: number }[];
  halInterfacesToReplace: {
    node: FunctionNodeData;
    calledBy: string[];
    viaKind: EdgeKind;
  }[];
  globalsUsed: GlobalVarInfo[];
  totalStaticRamBytes: number;
  heapCallNodes: FunctionNodeData[];
  configMacros: ConfigMacroInfo[];
}
