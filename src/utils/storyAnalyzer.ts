import {
  CallEdgeData,
  FeatureEntry,
  FunctionNodeData,
  GlobalVarInfo,
  ProjectAnalysis,
} from "../types/analysis";

export type StoryStageKind = "INIT" | "EVENT_ISR" | "FSM_HANDSHAKE" | "RUNTIME_COMM";

export interface StoryMilestone {
  node: FunctionNodeData;
  roleNote: string;
  viaEdge?: CallEdgeData;
  isCallback?: boolean;
  hasConditions?: boolean;
  childCount: number;
}

export interface StateMachineStep {
  stateName: string;
  ownerFnId: string;
  ownerFnName: string;
  line?: number;
  triggeredTargets: {
    node: FunctionNodeData;
    edge?: CallEdgeData;
  }[];
}

export interface StateMachineTimeline {
  ownerFn: FunctionNodeData;
  switchExpr: string;
  steps: StateMachineStep[];
}

export interface StoryStage {
  kind: StoryStageKind;
  stepNumber: number;
  title: string;
  subtitle: string;
  accentHex: string;
  milestones: StoryMilestone[];
  stateMachines: StateMachineTimeline[];
  bindings: {
    edge: CallEdgeData;
    source: FunctionNodeData;
    target: FunctionNodeData;
  }[];
  focusEntryId?: string;
}

export interface DataRelayItem {
  name: string;
  typeStr: string;
  bytes: number;
  file: string;
  line: number;
  description: string;
  writers: FunctionNodeData[];
  readers: FunctionNodeData[];
  isCrossContext: boolean; // written in ISR/Init and read in main/FSM
}

export interface ProjectStoryOverview {
  headline: string;
  executiveSummary: string;
  domainTags: string[];
  stages: StoryStage[];
  dataRelays: DataRelayItem[];
  fileGroups: {
    appFiles: string[];
    coreFiles: string[];
    halFiles: string[];
  };
  stats: {
    totalFiles: number;
    totalFunctions: number;
    involvedFunctions: number;
    callbackCount: number;
    stateMachineCount: number;
  };
}

const BOILERPLATE_RE =
  /^(RCC_|USART_Config|UART_Config|SystemClock_Config|MPU_Config|CPU_CACHE_Enable|Error_Handler|SysTick_Handler|TIM\d+_IRQHandler|EXTI\d|_exit|SER_PutChar|fputc|assert_failed|HAL_Init)/i;

export function isBoilerplateEntry(entry: FeatureEntry): boolean {
  if (entry.entryNodeId === "main") return false;
  if (BOILERPLATE_RE.test(entry.entryNodeId) || BOILERPLATE_RE.test(entry.name)) {
    return true;
  }
  if (entry.nodeIds.length <= 2 && entry.category !== "ISR") {
    return true;
  }
  return false;
}

export function classifyProjectEntries(project: ProjectAnalysis): {
  coreEntries: FeatureEntry[];
  supportEntries: FeatureEntry[];
} {
  const coreEntries: FeatureEntry[] = [];
  const supportEntries: FeatureEntry[] = [];
  for (const e of project.entries) {
    if (isBoilerplateEntry(e)) {
      supportEntries.push(e);
    } else {
      coreEntries.push(e);
    }
  }
  if (coreEntries.length === 0 && supportEntries.length > 0) {
    return { coreEntries: supportEntries, supportEntries: [] };
  }
  return { coreEntries, supportEntries };
}

/**
 * Extract ordered `case XXX:` sequences directly from a function's source file range,
 * preserving the real protocol/state-machine chronological order written by the author.
 */
function extractStateMachineFromSource(
  fn: FunctionNodeData,
  project: ProjectAnalysis,
  outEdges: CallEdgeData[]
): StateMachineTimeline | null {
  const fileContent = project.files[fn.file];
  if (!fileContent) return null;
  const lines = fileContent.split(/\r?\n/);
  const start = Math.max(0, fn.lineStart - 1);
  const end = Math.min(lines.length, fn.lineEnd);
  const bodyLines = lines.slice(start, end);

  let switchExpr = "";
  const casesInOrder: { stateName: string; line: number }[] = [];
  const seenCases = new Set<string>();

  for (let idx = 0; idx < bodyLines.length; idx++) {
    const raw = bodyLines[idx];
    const clean = raw.split("//")[0].trim();
    if (!switchExpr) {
      const sw = clean.match(/\bswitch\s*\(([^)]+)\)/);
      if (sw) {
        switchExpr = sw[1].trim();
      }
    }
    const cm = clean.match(/\bcase\s+([A-Za-z0-9_]+)\s*:/);
    if (cm && !seenCases.has(cm[1])) {
      seenCases.add(cm[1]);
      casesInOrder.push({ stateName: cm[1], line: start + idx + 1 });
    }
  }

  if (casesInOrder.length < 2) return null;

  const steps: StateMachineStep[] = casesInOrder.map((c, idx) => {
    const nextLine = casesInOrder[idx + 1]?.line ?? fn.lineEnd;
    const matchedEdges = outEdges.filter((e) => {
      if (e.relationType === "BIND") return false;
      const condMatch = (e.conditions ?? []).some(
        (cond) => cond.includes(`case ${c.stateName}`) || cond.includes(c.stateName)
      );
      const lineMatch =
        typeof e.callSiteLine === "number" &&
        e.callSiteLine >= c.line &&
        e.callSiteLine < nextLine;
      return condMatch || lineMatch;
    });

    const seenTargets = new Set<string>();
    const triggeredTargets: { node: FunctionNodeData; edge?: CallEdgeData }[] = [];
    for (const e of matchedEdges) {
      const targetNode = project.nodes[e.target];
      if (targetNode && !seenTargets.has(targetNode.id)) {
        seenTargets.add(targetNode.id);
        triggeredTargets.push({ node: targetNode, edge: e });
      }
    }

    return {
      stateName: c.stateName,
      ownerFnId: fn.id,
      ownerFnName: fn.name,
      line: c.line,
      triggeredTargets: triggeredTargets.slice(0, 5),
    };
  });

  // Keep states that either trigger meaningful calls or are part of a compact protocol FSM
  const meaningful = steps.filter((s) => s.triggeredTargets.length > 0);
  if (meaningful.length === 0) return null;

  return {
    ownerFn: fn,
    switchExpr: switchExpr || "state",
    steps: steps.slice(0, 10),
  };
}

function classifyFunctionStage(
  fn: FunctionNodeData,
  incomingEdge?: CallEdgeData
): StoryStageKind {
  const n = fn.name.toLowerCase();
  const f = fn.file.toLowerCase();

  if (
    fn.isIsr ||
    n.includes("irqhandler") ||
    n.includes("_isr") ||
    n.includes("wkup") ||
    n.includes("connected") ||
    n.includes("disconnected") ||
    n.includes("portenabled") ||
    n.includes("reset_handler") ||
    n.includes("sof")
  ) {
    return "EVENT_ISR";
  }

  if (
    n === "main" ||
    n.endsWith("_init") ||
    n.includes("init") ||
    n.includes("config") ||
    n.includes("register") ||
    n.includes("add_interface") ||
    n.includes("add_endpoint") ||
    n.includes("bsp_init") ||
    n.includes("mspinit") ||
    incomingEdge?.relationType === "BIND"
  ) {
    return "INIT";
  }

  if (
    n.includes("enum") ||
    n.includes("desc") ||
    n.includes("std_device") ||
    n.includes("std_req") ||
    n.includes("classrequest") ||
    n.includes("class_request") ||
    n.includes("set_address") ||
    n.includes("setaddress") ||
    n.includes("set_configuration") ||
    n.includes("set_idle") ||
    n.includes("set_protocol") ||
    n.includes("setup") ||
    n.includes("ctlreq") ||
    n.includes("handlecontrol") ||
    fn.hasStateMachine
  ) {
    return "FSM_HANDSHAKE";
  }

  if (
    n.includes("decode") ||
    n.includes("bulk_") ||
    n.includes("ep_start_") ||
    n.includes("receive") ||
    n.includes("transmit") ||
    n.includes("send") ||
    n.includes("write") ||
    n.includes("read") ||
    n.includes("encrypt") ||
    n.includes("decrypt") ||
    n.includes("handle") ||
    n.includes("process") ||
    n.includes("poll") ||
    n.includes("mouse") ||
    n.includes("keybd") ||
    n.includes("keybrd") ||
    n.includes("callback") ||
    f.includes("class/") ||
    f.includes("demo/")
  ) {
    return "RUNTIME_COMM";
  }

  return "RUNTIME_COMM";
}

function inferDomainTags(project: ProjectAnalysis, nodes: FunctionNodeData[]): string[] {
  const tags: string[] = [];
  const corpus = [
    project.projectName,
    ...nodes.map((n) => `${n.name} ${n.file}`),
  ]
    .join(" ")
    .toLowerCase();

  if (corpus.includes("usbh") || corpus.includes("usb_host")) tags.push("USB Host 主机协议栈");
  if (corpus.includes("usbd") || corpus.includes("cdc_acm")) tags.push("USB Device / CDC 通信");
  if (corpus.includes("hid")) tags.push("HID 人机交互类");
  if (corpus.includes("msc")) tags.push("MSC 大容量存储");
  if (corpus.includes("cryp") || corpus.includes("aes")) tags.push("硬件加解密 (CRYP/AES)");
  if (corpus.includes("ymodem")) tags.push("Ymodem 固件传输");
  if (corpus.includes("foc")) tags.push("电机 FOC 控制");
  if (corpus.includes("zephyr") || corpus.includes("z_cstart") || corpus.includes("k_thread")) {
    tags.push("Zephyr RTOS 内核");
  }
  if (tags.length === 0) tags.push("嵌入式 C 模块");
  return tags.slice(0, 4);
}

/**
 * Pure-offline lifecycle story builder: combines the active entry with closely-related
 * companion entries (e.g., matching ISR / protocol class handlers) so the user sees the
 * COMPLETE Init -> Event/ISR -> FSM/Negotiation -> Runtime Communication storyline.
 */
export function buildFeatureStory(
  project: ProjectAnalysis,
  activeEntry: FeatureEntry
): ProjectStoryOverview {
  // 1. Gather active entry nodes + companion subsystem nodes when viewing main/core entry
  const scopeNodeIds = new Set<string>(activeEntry.nodeIds);
  const relatedEntryIds = new Set<string>([activeEntry.id]);

  // Pull in companion ISR or ops-table class entries that belong to the same subsystem
  const entryKeywords = activeEntry.name
    .toLowerCase()
    .split("_")
    .filter((w) => w.length >= 3 && !["main", "init", "handle", "process"].includes(w));

  for (const e of project.entries) {
    if (e.id === activeEntry.id) continue;
    const isCompanion =
      activeEntry.entryNodeId === "main" ||
      e.nodeIds.some((id) => scopeNodeIds.has(id)) ||
      (entryKeywords.length > 0 &&
        entryKeywords.some((kw) => e.name.toLowerCase().includes(kw)));

    // Don't pull in pure board boilerplate (RCC / USART / TIM) into the story
    if (isCompanion && !isBoilerplateEntry(e)) {
      relatedEntryIds.add(e.id);
      for (const nid of e.nodeIds) {
        scopeNodeIds.add(nid);
      }
    }
  }

  const scopeNodes: FunctionNodeData[] = Array.from(scopeNodeIds)
    .map((id) => project.nodes[id])
    .filter((n): n is FunctionNodeData => Boolean(n));

  const scopeEdges: CallEdgeData[] = project.edges.filter(
    (e) => scopeNodeIds.has(e.source) && scopeNodeIds.has(e.target)
  );

  // Build adjacency for child counts & incoming edge lookup
  const outMap = new Map<string, CallEdgeData[]>();
  const inMap = new Map<string, CallEdgeData[]>();
  for (const e of scopeEdges) {
    if (!outMap.has(e.source)) outMap.set(e.source, []);
    outMap.get(e.source)!.push(e);
    if (!inMap.has(e.target)) inMap.set(e.target, []);
    inMap.get(e.target)!.push(e);
  }

  // 2. Extract ordered state machines from all FSM functions in scope
  const allStateMachines: StateMachineTimeline[] = [];
  for (const fn of scopeNodes) {
    if (fn.hasStateMachine || fn.name.toLowerCase().includes("process") || fn.name.toLowerCase().includes("enum") || fn.name.toLowerCase().includes("classrequest") || fn.name.toLowerCase().includes("handle")) {
      const fsm = extractStateMachineFromSource(fn, project, outMap.get(fn.id) ?? []);
      if (fsm) {
        allStateMachines.push(fsm);
      }
    }
  }
  allStateMachines.sort((a, b) => b.steps.length - a.steps.length);

  // 3. Bucket milestones into 4 chronological lifecycle stages (filtering out boilerplate noise!)
  const buckets: Record<StoryStageKind, StoryMilestone[]> = {
    INIT: [],
    EVENT_ISR: [],
    FSM_HANDSHAKE: [],
    RUNTIME_COMM: [],
  };
  const initBindings: {
    edge: CallEdgeData;
    source: FunctionNodeData;
    target: FunctionNodeData;
  }[] = [];

  for (const e of scopeEdges) {
    if (e.relationType === "BIND") {
      const s = project.nodes[e.source];
      const t = project.nodes[e.target];
      if (s && t) {
        initBindings.push({ edge: e, source: s, target: t });
      }
    }
  }

  // Prioritize functions with meaningful structural role (entry, callbacks, FSM, high fan-out, user/protocol code)
  const scoreNode = (fn: FunctionNodeData): number => {
    let sc = 0;
    if (fn.id === activeEntry.entryNodeId) sc += 50;
    if (fn.id === "main") sc += 45;
    if (fn.hasStateMachine) sc += 32;
    if (fn.isIsr) sc += 28;
    if (fn.isCallback) sc += 24;
    if (fn.layer === "APP" || fn.layer === "CALLBACK") sc += 14;
    if (fn.layer === "CORE") sc += 10;
    const outCount = (outMap.get(fn.id) ?? []).filter((e) => e.relationType !== "BIND").length;
    const inEdges = inMap.get(fn.id) ?? [];
    if (inEdges.some((e) => e.relationType === "INVOKE_CB")) sc += 22;
    sc += Math.min(20, outCount * 3);
    if (BOILERPLATE_RE.test(fn.name)) sc -= 60;
    return sc;
  };

  const rankedNodes = [...scopeNodes]
    .filter((fn) => !BOILERPLATE_RE.test(fn.name))
    .sort((a, b) => scoreNode(b) - scoreNode(a));

  for (const fn of rankedNodes) {
    const inEdges = inMap.get(fn.id) ?? [];
    const primaryIn =
      inEdges.find((e) => e.relationType === "INVOKE_CB") ??
      inEdges.find((e) => e.relationType === "WEAK_HOOK") ??
      inEdges.find((e) => e.relationType !== "BIND") ??
      inEdges[0];

    const stageKind = classifyFunctionStage(fn, primaryIn);
    if (buckets[stageKind].length >= 8) continue;

    const outNonBind = (outMap.get(fn.id) ?? []).filter((e) => e.relationType !== "BIND");
    let roleNote = fn.brief;
    if (primaryIn?.relationType === "INVOKE_CB" && primaryIn.label) {
      roleNote = `通过 ${primaryIn.label} 回调触发 · ${fn.brief}`;
    } else if (primaryIn?.conditions && primaryIn.conditions.length > 0) {
      const lastCond = primaryIn.conditions[primaryIn.conditions.length - 1];
      roleNote = `在 ${lastCond} 分支触发 · ${fn.brief}`;
    }

    buckets[stageKind].push({
      node: fn,
      roleNote,
      viaEdge: primaryIn,
      isCallback: fn.isCallback || primaryIn?.relationType === "INVOKE_CB",
      hasConditions: Boolean(primaryIn?.conditions && primaryIn.conditions.length > 0),
      childCount: outNonBind.length,
    });
  }

  // Helper to find best matching entryId for a stage's "在调用图谱中深挖" button
  const findBestEntryForStage = (milestones: StoryMilestone[]): string => {
    for (const m of milestones) {
      const exact = project.entries.find((e) => e.entryNodeId === m.node.id);
      if (exact) return exact.id;
    }
    return activeEntry.id;
  };

  // Assemble stages (keep non-empty stages, number them sequentially 1..N)
  const rawStageDefs: {
    kind: StoryStageKind;
    title: string;
    subtitle: string;
    accentHex: string;
    fsms: StateMachineTimeline[];
    bindings: typeof initBindings;
  }[] = [
    {
      kind: "INIT",
      title: "系统初始化与回调注册",
      subtitle: "外设/协议栈启动、关键参数配置以及函数指针回调表绑定",
      accentHex: "#7b9acc", // Soft Steel Blue
      fsms: [],
      bindings: initBindings.slice(0, 6),
    },
    {
      kind: "EVENT_ISR",
      title: "硬件中断与事件驱动",
      subtitle: "物理插拔、总线复位或传输完成时由硬件中断唤醒并更新状态",
      accentHex: "#c9858d", // Dusty Rose / Terracotta
      fsms: [],
      bindings: [],
    },
    {
      kind: "FSM_HANDSHAKE",
      title: "状态机演进与枚举 / 协议协商",
      subtitle: "按源码 switch-case 顺序追踪握手、描述符解析与类请求交互",
      accentHex: "#9e8bc7", // Soft Wisteria
      fsms: allStateMachines.filter(
        (f) =>
          !f.ownerFn.name.toLowerCase().includes("hid_handle") &&
          !f.ownerFn.name.toLowerCase().includes("decode")
      ).slice(0, 3),
      bindings: [],
    },
    {
      kind: "RUNTIME_COMM",
      title: "就绪后的业务通信与数据处理",
      subtitle: "协议就绪后的周期轮询、数据收发回调与应用层业务解码",
      accentHex: "#69ad99", // Celadon Sage
      fsms: allStateMachines.filter((f) =>
        f.ownerFn.name.toLowerCase().includes("hid_handle")
      ).slice(0, 2),
      bindings: [],
    },
  ];

  const stages: StoryStage[] = [];
  let seq = 1;
  for (const def of rawStageDefs) {
    const milestones = buckets[def.kind];
    if (milestones.length === 0 && def.fsms.length === 0 && def.bindings.length === 0) {
      continue;
    }
    stages.push({
      kind: def.kind,
      stepNumber: seq++,
      title: def.title,
      subtitle: def.subtitle,
      accentHex: def.accentHex,
      milestones,
      stateMachines: def.fsms,
      bindings: def.bindings,
      focusEntryId: findBestEntryForStage(milestones),
    });
  }

  // 4. Build Cross-Entry Global State & Buffer Relay Tracker
  const globalMap = new Map<string, GlobalVarInfo>();
  for (const g of project.globals) {
    globalMap.set(g.name, g);
  }
  const relayWriters = new Map<string, Set<string>>();
  const relayReaders = new Map<string, Set<string>>();

  for (const fn of scopeNodes) {
    for (const g of fn.writesGlobals) {
      if (!relayWriters.has(g)) relayWriters.set(g, new Set());
      relayWriters.get(g)!.add(fn.id);
    }
    for (const g of fn.readsGlobals) {
      if (!relayReaders.has(g)) relayReaders.set(g, new Set());
      relayReaders.get(g)!.add(fn.id);
    }
  }

  const allGlobalNames = new Set<string>([
    ...relayWriters.keys(),
    ...relayReaders.keys(),
  ]);
  const dataRelays: DataRelayItem[] = [];
  for (const gName of allGlobalNames) {
    const writers = Array.from(relayWriters.get(gName) ?? [])
      .map((id) => project.nodes[id])
      .filter((n): n is FunctionNodeData => Boolean(n));
    const readers = Array.from(relayReaders.get(gName) ?? [])
      .map((id) => project.nodes[id])
      .filter((n): n is FunctionNodeData => Boolean(n));

    if (writers.length + readers.length < 2) continue;

    const meta = globalMap.get(gName);
    const hasIsrOrInitWriter = writers.some(
      (w) => w.isIsr || w.name.toLowerCase().includes("init")
    );
    const hasNonInitReader = readers.some(
      (r) => !r.isIsr && !r.name.toLowerCase().includes("init")
    );

    dataRelays.push({
      name: gName,
      typeStr: meta?.typeStr ?? "global",
      bytes: meta?.bytes ?? 0,
      file: meta?.file ?? writers[0]?.file ?? readers[0]?.file ?? "",
      line: meta?.line ?? 1,
      description: meta?.description ?? "跨函数共享全局状态/缓冲区",
      writers: writers.slice(0, 4),
      readers: readers.slice(0, 4),
      isCrossContext: hasIsrOrInitWriter && hasNonInitReader,
    });
  }

  dataRelays.sort((a, b) => {
    if (a.isCrossContext !== b.isCrossContext) return a.isCrossContext ? -1 : 1;
    return b.writers.length + b.readers.length - (a.writers.length + a.readers.length);
  });

  // 5. Lightweight file-architecture overview (app / core / hal)
  const appSet = new Set<string>();
  const coreSet = new Set<string>();
  const halSet = new Set<string>();
  for (const fn of scopeNodes) {
    if (!fn.file) continue;
    if (fn.layer === "APP" || fn.layer === "CALLBACK") appSet.add(fn.file);
    else if (fn.layer === "HAL") halSet.add(fn.file);
    else coreSet.add(fn.file);
  }

  const domainTags = inferDomainTags(project, scopeNodes);
  const callbackCount = scopeEdges.filter(
    (e) => e.relationType === "INVOKE_CB" || e.relationType === "WEAK_HOOK"
  ).length;

  const stageNames = stages.map((s) => s.title).join(" ➔ ");
  const executiveSummary =
    activeEntry.summary && activeEntry.summary.length > 20
      ? activeEntry.summary
      : `围绕 ${activeEntry.name}() 自动串联了 ${scopeNodes.length} 个核心函数与 ${allStateMachines.length} 个状态机，完整覆盖「${stageNames}」运行脉络。`;

  return {
    headline: activeEntry.displayName,
    executiveSummary,
    domainTags,
    stages,
    dataRelays: dataRelays.slice(0, 8),
    fileGroups: {
      appFiles: Array.from(appSet).sort(),
      coreFiles: Array.from(coreSet).sort(),
      halFiles: Array.from(halSet).sort(),
    },
    stats: {
      totalFiles: Object.keys(project.files).length,
      totalFunctions: Object.keys(project.nodes).length,
      involvedFunctions: scopeNodes.length,
      callbackCount,
      stateMachineCount: allStateMachines.length,
    },
  };
}
