import {
  ArchLayer,
  CallEdgeData,
  EdgeKind,
  FeatureEntry,
  FunctionNodeData,
  PortingBoundaryResult,
  ProjectAnalysis,
  StackMetricsResult,
} from "../types/analysis";

export const LARGE_STACK_THRESHOLD = 256;

const OS_API_PATTERNS = [
  /^usb_osal_(thread|sem|mutex|mq|timer|msleep)/i,
  /^xTask/i,
  /^vTask/i,
  /^xSemaphore/i,
  /^xQueue/i,
  /^osThread/i,
  /^osMutex/i,
  /^osSemaphore/i,
  /^osMessageQueue/i,
  /^rt_thread_/i,
  /^rt_sem_/i,
  /^rt_mutex_/i,
  /^rt_mq_/i,
];

export function isOsKernelApi(fnName: string): boolean {
  return OS_API_PATTERNS.some((re) => re.test(fnName));
}

/**
 * Compute Worst-Case Stack Depth (WCS), critical stack path, recursion cycles,
 * and automatic Bare-Metal (MSP) vs RTOS (PSP) stack budget evaluation.
 */
export function computeStackMetrics(
  entry: FeatureEntry,
  nodes: Record<string, FunctionNodeData>,
  allEdges: CallEdgeData[],
  detectedMspStackBytes = 1024,
  mspStackSource = "默认 MCU 启动主栈 (MSP 0x0400 = 1024B)"
): StackMetricsResult {
  const nodeSet = new Set(entry.nodeIds);
  const subEdges = allEdges.filter(
    (e) => entry.edgeIds.includes(e.id) && nodeSet.has(e.source) && nodeSet.has(e.target)
  );

  // Build adjacency list
  const adj = new Map<string, CallEdgeData[]>();
  for (const id of entry.nodeIds) adj.set(id, []);
  for (const e of subEdges) {
    adj.get(e.source)?.push(e);
  }

  // Detect recursion cycles via DFS back-edges
  const recursionNodeSet = new Set<string>();
  const recursionEdgeSet = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const stackTrace: string[] = [];

  const detectCycles = (u: string) => {
    color.set(u, 1);
    stackTrace.push(u);
    for (const e of adj.get(u) ?? []) {
      const v = e.target;
      const c = color.get(v) ?? 0;
      if (c === 1) {
        // Found a cycle back-edge u -> v
        recursionEdgeSet.add(e.id);
        const idx = stackTrace.indexOf(v);
        if (idx >= 0) {
          for (let i = idx; i < stackTrace.length; i++) {
            recursionNodeSet.add(stackTrace[i]);
          }
        }
      } else if (c === 0) {
        detectCycles(v);
      }
    }
    stackTrace.pop();
    color.set(u, 2);
  };

  // Start from entryNodeId, then check remaining nodes
  if (nodeSet.has(entry.entryNodeId)) {
    detectCycles(entry.entryNodeId);
  }
  for (const id of entry.nodeIds) {
    if ((color.get(id) ?? 0) === 0) {
      detectCycles(id);
    }
  }

  // Find longest stack path (ignoring back-edges that cause infinite recursion)
  interface PathResult {
    stack: number;
    depth: number;
    nodePath: string[];
    edgePath: string[];
  }

  const visitedOnPath = new Set<string>();
  const bestFrom = (u: string): PathResult => {
    const node = nodes[u];
    const selfStack = node ? node.stackBytes : 0;
    visitedOnPath.add(u);

    let bestChild: PathResult = {
      stack: 0,
      depth: 0,
      nodePath: [],
      edgePath: [],
    };

    for (const e of adj.get(u) ?? []) {
      if (visitedOnPath.has(e.target)) continue; // break cycle safely
      const res = bestFrom(e.target);
      if (res.stack > bestChild.stack || (res.stack === bestChild.stack && res.depth > bestChild.depth)) {
        bestChild = {
          stack: res.stack,
          depth: res.depth,
          nodePath: res.nodePath,
          edgePath: [e.id, ...res.edgePath],
        };
      }
    }

    visitedOnPath.delete(u);
    return {
      stack: selfStack + bestChild.stack,
      depth: 1 + bestChild.depth,
      nodePath: [u, ...bestChild.nodePath],
      edgePath: bestChild.edgePath,
    };
  };

  // Evaluate from primary entry; also consider independent ISR roots inside the same feature if larger
  let overallBest = bestFrom(entry.entryNodeId);
  const inDegree = new Map<string, number>();
  for (const id of entry.nodeIds) inDegree.set(id, 0);
  for (const e of subEdges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  for (const id of entry.nodeIds) {
    if ((inDegree.get(id) ?? 0) === 0 && id !== entry.entryNodeId) {
      const candidate = bestFrom(id);
      if (candidate.stack > overallBest.stack) {
        overallBest = candidate;
      }
    }
  }

  const largeStackNodeIds = entry.nodeIds.filter((id) => {
    const n = nodes[id];
    return n && (n.stackBytes >= LARGE_STACK_THRESHOLD || (n.stackWarnings && n.stackWarnings.length > 0));
  });

  // Automatically detect whether this feature call chain actually uses any RTOS / OSAL blocking primitives!
  const osApisUsed = entry.nodeIds.filter((id) => isOsKernelApi(id));
  const isRtosFeature =
    entry.category === "RTOS_TASK" ||
    Boolean(entry.rtosAllocatedStackBytes) ||
    osApisUsed.length > 0;

  const runtimeReq = isRtosFeature ? "RTOS_REQUIRED" : "BARE_METAL_READY";
  const stackKind = isRtosFeature ? "PSP_RTOS_TASK" : "MSP_BARE_METAL";

  const budgetStackBytes = isRtosFeature
    ? entry.rtosAllocatedStackBytes || 2048
    : detectedMspStackBytes || 1024;

  const budgetSourceLabel = isRtosFeature
    ? entry.rtosAllocatedStackBytes
      ? `RTOS 任务分配栈 (PSP: ${entry.rtosAllocatedStackBytes} B)`
      : `RTOS 线程建议栈配额 (PSP: ${budgetStackBytes} B)`
    : mspStackSource;

  const budgetUsagePercent =
    Math.round((overallBest.stack / budgetStackBytes) * 1000) / 10;

  let rtosOverflowRisk: StackMetricsResult["rtosOverflowRisk"] = "SAFE";
  if (recursionNodeSet.size > 0 || budgetUsagePercent >= 85) {
    rtosOverflowRisk = "CRITICAL";
  } else if (budgetUsagePercent >= 60) {
    rtosOverflowRisk = "WARNING";
  }

  return {
    maxStackBytes: overallBest.stack,
    maxDepth: overallBest.depth,
    criticalPathNodeIds: overallBest.nodePath,
    criticalPathEdgeIds: overallBest.edgePath,
    largeStackNodeIds,
    recursionNodeIds: Array.from(recursionNodeSet),
    recursionEdgeIds: Array.from(recursionEdgeSet),
    hasRecursion: recursionNodeSet.size > 0,
    runtimeReq,
    osApisUsed,
    stackKind,
    budgetStackBytes,
    budgetSourceLabel,
    budgetUsagePercent,
    rtosAllocatedBytes: isRtosFeature ? budgetStackBytes : undefined,
    rtosUsagePercent: budgetUsagePercent,
    rtosOverflowRisk,
  };
}

/**
 * Compute Porting Dependency Boundary Closure dynamically, respecting user layer overrides!
 */
export function computePortingBoundary(
  project: ProjectAnalysis,
  entry: FeatureEntry,
  layerOverrides: Record<string, ArchLayer>
): PortingBoundaryResult {
  const nodeSet = new Set(entry.nodeIds);
  const subEdges = project.edges.filter(
    (e) => entry.edgeIds.includes(e.id) && nodeSet.has(e.source) && nodeSet.has(e.target)
  );

  const getLayer = (node: FunctionNodeData): ArchLayer =>
    layerOverrides[node.id] ?? node.layer;

  const fileCounts = new Map<string, { role: "CORE" | "APP_REF" | "HEADER"; count: number }>();
  const halNodesMap = new Map<
    string,
    { node: FunctionNodeData; calledBy: Set<string>; viaKind: EdgeKind }
  >();
  const usedGlobalNames = new Set<string>();
  const heapCallNodes: FunctionNodeData[] = [];

  for (const id of entry.nodeIds) {
    const node = project.nodes[id];
    if (!node) continue;

    const effectiveLayer = getLayer(node);

    // Collect globals
    node.readsGlobals.forEach((g) => usedGlobalNames.add(g));
    node.writesGlobals.forEach((g) => usedGlobalNames.add(g));

    // Collect heap callers
    if (node.callsHeap) {
      heapCallNodes.push(node);
    }

    if (effectiveLayer === "HAL" || node.isExternal) {
      halNodesMap.set(id, {
        node: { ...node, layer: effectiveLayer },
        calledBy: new Set<string>(),
        viaKind: "DIRECT",
      });
    } else {
      const role: "CORE" | "APP_REF" = effectiveLayer === "APP" ? "APP_REF" : "CORE";
      const prev = fileCounts.get(node.file);
      if (!prev) {
        fileCounts.set(node.file, { role, count: 1 });
      } else {
        // CORE takes priority over APP_REF if file contains both
        fileCounts.set(node.file, {
          role: prev.role === "CORE" || role === "CORE" ? "CORE" : "APP_REF",
          count: prev.count + 1,
        });
      }
      // Also attach matching .h if present in project.files
      if (node.file.endsWith(".c") || node.file.endsWith(".cpp")) {
        const headerFile = node.file.replace(/\.(c|cpp)$/, ".h");
        if (project.files[headerFile] && !fileCounts.has(headerFile)) {
          fileCounts.set(headerFile, { role: "HEADER", count: 0 });
        }
      }
    }
  }

  // Transitive #include header closure: recursively pull all local project headers included by core/app files
  if (project.fileIncludes) {
    const queue = Array.from(fileCounts.keys());
    const visitedHeaders = new Set<string>(queue);
    while (queue.length > 0) {
      const currFile = queue.shift()!;
      const incList = project.fileIncludes[currFile] ?? [];
      for (const inc of incList) {
        if (!visitedHeaders.has(inc)) {
          visitedHeaders.add(inc);
          queue.push(inc);
          if (!fileCounts.has(inc)) {
            fileCounts.set(inc, { role: "HEADER", count: 0 });
          }
        }
      }
    }
  }

  for (const e of subEdges) {
    const targetHal = halNodesMap.get(e.target);
    if (targetHal) {
      const srcNode = project.nodes[e.source];
      if (srcNode && getLayer(srcNode) !== "HAL") {
        targetHal.calledBy.add(srcNode.name);
        if (e.kind !== "DIRECT") {
          targetHal.viaKind = e.kind;
        }
      }
    }
  }

  const coreFilesToCopy = Array.from(fileCounts.entries())
    .map(([file, info]) => ({
      file,
      role: info.role,
      functionCount: info.count,
    }))
    .sort((a, b) => {
      const order = { CORE: 0, HEADER: 1, APP_REF: 2 };
      return order[a.role] - order[b.role] || a.file.localeCompare(b.file);
    });

  const halInterfacesToReplace = Array.from(halNodesMap.values()).map((item) => ({
    node: item.node,
    calledBy: Array.from(item.calledBy),
    viaKind: item.viaKind,
  }));

  const globalsUsed = project.globals.filter((g) => usedGlobalNames.has(g.name));
  const totalStaticRamBytes = globalsUsed.reduce((sum, g) => sum + g.bytes, 0);

  return {
    coreFilesToCopy,
    halInterfacesToReplace,
    globalsUsed,
    totalStaticRamBytes,
    heapCallNodes,
    configMacros: entry.configMacros,
  };
}

/**
 * Generate a clean, self-contained AI analysis & porting prompt (Zero API Key workflow).
 */
export function buildAiPortingPrompt(
  project: ProjectAnalysis,
  entry: FeatureEntry,
  stackMetrics: StackMetricsResult,
  porting: PortingBoundaryResult,
  layerOverrides: Record<string, ArchLayer>
): string {
  const subEdges = project.edges.filter((e) => entry.edgeIds.includes(e.id));

  const callLines = subEdges
    .map((e) => {
      const s = project.nodes[e.source]?.name ?? e.source;
      const t = project.nodes[e.target]?.name ?? e.target;
      const tag =
        e.kind === "DIRECT"
          ? "-->"
          : e.kind === "OPS_TABLE"
          ? "--[接口表Ops]-->"
          : e.kind === "ASYNC_CALLBACK"
          ? "==[异步回调]==>"
          : "--[Weak重写]-->";
      return `- ${s} ${tag} ${t}${e.label ? ` (${e.label})` : ""}`;
    })
    .join("\n");

  const halLines = porting.halInterfacesToReplace
    .map((h) => `- ${h.node.signature} (位于 ${h.node.file}, 被 ${h.calledBy.join(", ") || "底层中断"} 调用)`)
    .join("\n");

  const globalLines = porting.globalsUsed
    .map((g) => `- ${g.typeStr} ${g.name} (${g.bytes} B, ${g.file}) — ${g.description}`)
    .join("\n");

  const snippets = entry.nodeIds
    .map((id) => project.nodes[id])
    .filter((n): n is FunctionNodeData => Boolean(n && (layerOverrides[n.id] ?? n.layer) !== "HAL"))
    .slice(0, 6)
    .map((n) => `### ${n.name} (${n.file}:${n.lineStart}, Stack ~${n.stackBytes}B)\n\`\`\`c\n${n.snippet}\n\`\`\``)
    .join("\n\n");

  return `你是一名资深嵌入式架构师。请基于下面由 ChainAnalysis 静态提取的工程调用链、回调关系、堆栈预算与移植边界，为我撰写一份【模块设计思路解析】与【跨 MCU 移植实施步骤】：

## 1. 目标功能信息
- 工程：${project.projectName} (${project.targetMcuHint})
- 功能入口：${entry.displayName} (\`${entry.name}\`, 类型: ${entry.category})
- 运行环境依赖：${
    stackMetrics.runtimeReq === "BARE_METAL_READY"
      ? "🟢 纯裸机可直接移植 (0 RTOS 依赖，中断/前后台轮询即可运行)"
      : `🔵 依赖 RTOS / OSAL 原语 (${stackMetrics.osApisUsed.join(", ") || "线程/队列"})`
  }
- 简介：${entry.summary}

## 2. 完整调用链与隐式回调
${callLines}

## 3. 堆栈与内存体检 (WCS)
- 最坏情况最大栈深估算 (WCS)：~${stackMetrics.maxStackBytes} Bytes (最大调用深度 ${stackMetrics.maxDepth} 层)
- 栈水位基准 (${stackMetrics.budgetSourceLabel})：占用率 ${stackMetrics.budgetUsagePercent}% (风险等级: ${stackMetrics.rtosOverflowRisk})
- 递归风险：${stackMetrics.hasRecursion ? "检测到递归环路！需重点消除" : "无递归环路"}
- 静态 RAM 占用 (.bss/.data)：${porting.totalStaticRamBytes} Bytes
- 动态堆依赖 (Heap)：${porting.heapCallNodes.length > 0 ? porting.heapCallNodes.map((n) => n.name).join(", ") : "无动态内存分配"}

## 4. 需替换的底层硬件接口 (HAL/BSP Porting Boundary)
${halLines || "- 无外部硬件依赖"}

## 5. 关联全局状态变量
${globalLines || "- 无全局状态变量"}

## 6. 核心函数代码切片
${snippets}

请输出：
1. 该功能的核心设计思路、数据流与异步回调触发时序；
2. 针对上述爆栈/递归/内存风险的优化建议；
3. 将此模块迁移到另一款 MCU 平台（例如 GD32 / ESP32 / 裸机环境）时的具体解耦步骤与接口适配模板代码。`;
}

/**
 * Generate a ready-to-compile C Porting Adapter Skeleton (.c) for all HAL / __WEAK boundary functions.
 */
export function buildPortingAdapterSkeleton(
  project: ProjectAnalysis,
  entry: FeatureEntry,
  stackMetrics: StackMetricsResult,
  porting: PortingBoundaryResult
): string {
  const headerIncludes = porting.coreFilesToCopy
    .filter((f) => f.file.endsWith(".h"))
    .map((f) => `#include "${f.file.split("/").pop()}"`)
    .join("\n");

  const macroDefs = porting.configMacros
    .map(
      (m) =>
        `#ifndef ${m.name}\n#define ${m.name} ${m.defaultVal.replace(/[^0-9xXa-fA-F]/g, "") || "1"} /* ${m.purpose} */\n#endif`
    )
    .join("\n\n");

  const stubFunctions = porting.halInterfacesToReplace
    .map(({ node, calledBy, viaKind }) => {
      const cleanSig = node.signature
        .replace(/^__WEAK\s+/, "")
        .replace(/^__weak\s+/, "")
        .replace(/^static\s+/, "");
      const isVoid = /^void\s+[a-zA-Z_]/.test(cleanSig);
      return `/**
 * @brief  [移植适配接口] ${node.brief}
 * @note   原位置: ${node.file}:${node.lineStart} | 调用方式: ${viaKind}
 * @caller 被以下上层函数调用: ${calledBy.join(", ") || "硬件中断/顶层"}
 */
${cleanSig}
{
    /* TODO: 在目标 MCU 平台上实现或对接底层硬件驱动 */
${isVoid ? "    return;" : "    return 0;"}
}`;
    })
    .join("\n\n");

  return `/**
 * ============================================================================
 * @file    port_${entry.name.toLowerCase()}_adapter.c
 * @brief   由 ChainAnalysis 自动生成的【${entry.displayName}】跨平台移植适配层骨架
 * @project ${project.projectName}
 *
 * [迁移内存与栈深预算]
 * - 预计最坏峰值栈深 (WCS): ~${stackMetrics.maxStackBytes} Bytes (最大调用深度 ${stackMetrics.maxDepth} 层)
 * - 关联静态 RAM (.bss/.data): ${porting.totalStaticRamBytes} Bytes
 * - 动态堆依赖 (Heap): ${porting.heapCallNodes.length > 0 ? porting.heapCallNodes.map((n) => n.name).join(", ") : "无 (0 malloc)"}
 *
 * [必拷核心源码清单]
${porting.coreFilesToCopy.map((f) => ` * - [${f.role}] ${f.file}`).join("\n")}
 * ============================================================================
 */

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
${headerIncludes}

/* ==================== 1. 关键移植宏配置开关 ==================== */
${macroDefs || "/* 无特殊必配宏 */"}

/* ==================== 2. 需实现的底层硬件/OS移植接口 (${porting.halInterfacesToReplace.length} 项) ==================== */

${stubFunctions || "/* 当前功能为纯算法/无底层硬件依赖，无需编写额外 HAL 适配代码 */"}
`;
}

