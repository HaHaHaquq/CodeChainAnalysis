import fs from "node:fs";
import path from "node:path";
import {
  ArchLayer,
  CallEdgeData,
  EntryCategory,
  FeatureEntry,
  FlowStep,
  FunctionNodeData,
  GlobalVarInfo,
  LocalVarInfo,
  ProjectAnalysis,
} from "../types/analysis";

export const DEFAULT_CHERRYUSB_PATH = "D:\\3-code\\USB\\CherryUSB-1.6.1";

const C_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "return",
  "sizeof",
  "typeof",
  "alignof",
  "defined",
  "do",
  "goto",
  "break",
  "continue",
  "struct",
  "union",
  "enum",
  "typedef",
  "static",
  "inline",
  "const",
  "volatile",
  "extern",
  "void",
  "int",
  "char",
  "short",
  "long",
  "float",
  "double",
  "bool",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "size_t",
  "uintptr_t",
]);

const HEAP_APIS = new Set([
  "malloc",
  "calloc",
  "realloc",
  "free",
  "pvPortMalloc",
  "vPortFree",
  "rt_malloc",
  "rt_free",
  "usb_osal_malloc",
  "usb_osal_free",
]);

const TYPE_SIZE_MAP: Record<string, number> = {
  uint8_t: 1,
  int8_t: 1,
  char: 1,
  bool: 1,
  uint16_t: 2,
  int16_t: 2,
  short: 2,
  uint32_t: 4,
  int32_t: 4,
  int: 4,
  long: 4,
  float: 4,
  uintptr_t: 4,
  size_t: 4,
  uint64_t: 8,
  int64_t: 8,
  double: 8,
  usb_setup_packet: 8,
  usb_endpoint_descriptor: 8,
  usb_device_descriptor: 18,
  usb_configuration_descriptor: 9,
  usb_interface_descriptor: 9,
  cdc_line_coding: 8,
  hub_port_status: 4,
  usbd_endpoint: 8,
  usbd_interface: 24,
  usbh_urb: 64,
  CBW: 31,
  CSW: 13,
  video_payload_header: 12,
};

interface InlinePhase {
  title: string;
  calls: string[];
  configs: string[];
}

interface ParsedFileFunc {
  name: string;
  signature: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  isWeak: boolean;
  isStatic: boolean;
  isUserSrc: boolean;
  docBrief?: string;
  inlinePhases: InlinePhase[];
  configAssignments: string[];
  body: string;
  snippet: string;
  hasSwitch: boolean;
  switchCases: string[];
  localVars: LocalVarInfo[];
  stackBytes: number;
  stackWarnings: string[];
  callsHeap: boolean;
  heapApis: string[];
  directCalls: { callee: string; line: number; argsText: string }[];
  fieldAssignments: { field: string; targetFn: string; line: number }[];
  fieldCalls: { field: string; line: number }[];
}

const TRIVIAL_STD_CALLS = new Set([
  "memcpy",
  "memset",
  "memcmp",
  "memmove",
  "strlen",
  "strcmp",
  "strncmp",
  "strcpy",
  "strncpy",
  "snprintf",
  "sprintf",
  "printf",
  "strtol",
  "strchr",
  "MIN",
  "MAX",
  "LO_BYTE",
  "HI_BYTE",
  "assert_param",
  "UNUSED",
  "ARG_UNUSED",
  "USB_LOG_DBG",
  "USB_LOG_INFO",
  "USB_LOG_WRN",
  "USB_LOG_ERR",
  "USB_LOG_RAW",
  "USB_ASSERT",
  "USB_ASSERT_MSG",
]);

function isSyscallBoilerplate(relFile: string, fnName = ""): boolean {
  const lowF = relFile.toLowerCase();
  if (lowF.endsWith("syscalls.c") || lowF.endsWith("sysmem.c")) return true;
  return [
    "_exit",
    "_sbrk",
    "_write",
    "_read",
    "_close",
    "_fstat",
    "_isatty",
    "_lseek",
    "_kill",
    "_getpid",
    "__io_putchar",
    "__io_getchar",
  ].includes(fnName);
}

function extractPrecedingDocBrief(
  lines: string[],
  fnStartIdx: number
): string | undefined {
  let idx = fnStartIdx;
  const commentLines: string[] = [];
  let inBlock = false;

  while (idx > 0 && fnStartIdx - idx <= 35) {
    idx--;
    const t = lines[idx].trim();
    if (!t) {
      if (commentLines.length > 0 && !inBlock) break;
      continue;
    }
    if (t.endsWith("*/")) inBlock = true;
    if (inBlock) {
      const cleaned = t
        .replace(/^\/\*+/, "")
        .replace(/\*+\/$/, "")
        .replace(/^\*+/, "")
        .trim();
      if (cleaned && !/^[-*=]+$/.test(cleaned)) {
        commentLines.push(cleaned);
      }
      if (t.startsWith("/*")) break;
    } else if (t.startsWith("//")) {
      const cleaned = t.replace(/^\/+/, "").trim();
      if (cleaned) commentLines.push(cleaned);
    } else {
      break;
    }
  }

  if (commentLines.length === 0) return undefined;
  commentLines.reverse();

  const briefParts: string[] = [];
  let collecting = false;
  for (const l of commentLines) {
    const bIdx = l.indexOf("@brief");
    if (bIdx >= 0) {
      collecting = true;
      const rest = l.slice(bIdx + 6).trim();
      if (rest) briefParts.push(rest);
    } else if (collecting) {
      if (l.startsWith("@") || l.startsWith("This software")) break;
      briefParts.push(l);
      if (briefParts.length >= 3) break;
    }
  }

  const raw =
    briefParts.length > 0
      ? briefParts.join(" ")
      : commentLines
          .filter((l) => !l.startsWith("@") && !l.includes("Copyright"))
          .slice(0, 2)
          .join(" ");
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact || undefined;
}

function synthesizeMeaningfulBrief(
  pf: ParsedFileFunc,
  layer: ArchLayer
): string {
  const parts: string[] = [];
  if (
    pf.docBrief &&
    pf.docBrief.toLowerCase() !== "main program" &&
    pf.docBrief.toLowerCase() !== "hal msp module."
  ) {
    parts.push(
      pf.docBrief.length > 88 ? pf.docBrief.slice(0, 86) + "…" : pf.docBrief
    );
  }
  if (pf.inlinePhases.length > 0) {
    parts.push(
      `流程阶段: ${pf.inlinePhases
        .slice(0, 4)
        .map((p) => p.title)
        .join(" ➔ ")}`
    );
  }
  if (pf.configAssignments.length > 0 && parts.length < 2) {
    parts.push(`配置: ${pf.configAssignments.slice(0, 3).join(", ")}`);
  }
  if (parts.length === 0) {
    const keyCalls = pf.directCalls
      .map((c) => c.callee)
      .filter((c) => !TRIVIAL_STD_CALLS.has(c) && c !== "Error_Handler")
      .slice(0, 4);
    if (keyCalls.length > 0) {
      parts.push(`调用 ${keyCalls.join(" / ")}`);
    }
  }
  if (parts.length === 0) {
    if (pf.switchCases.length > 0) {
      return `状态机分支 (${pf.switchCases.slice(0, 3).join(", ")}) — ${pf.file}:${pf.lineStart}`;
    }
    return `${pf.signature} (${layer} 层实现，位于 ${pf.file}:${pf.lineStart})`;
  }
  return parts.join(" | ");
}

function normalizeRelPath(rootDir: string, fullPath: string): string {
  return path.relative(rootDir, fullPath).replace(/\\/g, "/");
}

function classifyLayerByFileAndName(
  relFile: string,
  fnName: string,
  isWeak: boolean
): ArchLayer {
  const lowFile = relFile.toLowerCase();
  const lowName = fnName.toLowerCase();

  if (
    lowName.endsWith("mspinit") ||
    lowName.endsWith("mspdeinit") ||
    lowName.includes("callback") ||
    lowName.endsWith("_cb") ||
    lowName.includes("_event_") ||
    lowName.includes("_notify_") ||
    lowName.endsWith("_request_handler") ||
    lowName.endsWith("_bulk_out") ||
    lowName.endsWith("_bulk_in")
  ) {
    return "CALLBACK";
  }

  if (
    lowFile.startsWith("port/") ||
    lowFile.startsWith("osal/") ||
    lowFile.startsWith("platform/") ||
    lowFile.startsWith("drivers/") ||
    lowFile.includes("hal_driver/") ||
    lowFile.includes("/bsp/") ||
    lowName.startsWith("usb_dc_") ||
    lowName.startsWith("usb_hc_") ||
    lowName.startsWith("usb_osal_") ||
    lowName.startsWith("hal_") ||
    lowName.startsWith("__hal_") ||
    lowName.startsWith("ll_") ||
    lowName.startsWith("bsp_") ||
    lowName.startsWith("scb_") ||
    lowName.endsWith("_irqhandler") ||
    lowName.startsWith("fsdev_") ||
    lowName.startsWith("dwc2_") ||
    lowName === "usbd_ep_open" ||
    lowName === "usbd_ep_close" ||
    lowName === "usbd_ep_start_write" ||
    lowName === "usbd_ep_start_read" ||
    lowName === "usbd_ep_set_stall" ||
    lowName === "usbd_ep_clear_stall" ||
    lowName === "usbd_set_address"
  ) {
    return "HAL";
  }

  if (isWeak) {
    return "CALLBACK";
  }

  if (
    lowFile.startsWith("demo/") ||
    lowFile.startsWith("app/") ||
    lowFile.startsWith("tests/") ||
    lowName === "main" ||
    lowName === "lsusb" ||
    lowName === "error_handler"
  ) {
    return "APP";
  }

  return "CORE";
}

function analyzeFunctionStack(
  body: string,
  macros: Record<string, number>,
  isIsr: boolean
): {
  localVars: LocalVarInfo[];
  stackBytes: number;
  stackWarnings: string[];
} {
  const localVars: LocalVarInfo[] = [];
  const stackWarnings: string[] = [];
  const seenNames = new Set<string>();

  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("*") || line.startsWith("#")) continue;
    if (/^(if|for|while|switch|return|case|goto)\b/.test(line)) continue;

    const arrMatch = line.match(
      /^(?:static\s+)?(?:const\s+)?(?:volatile\s+)?(?:struct\s+)?([a-zA-Z_]\w*)\s+(\*?\s*[a-zA-Z_]\w*)\s*\[\s*([a-zA-Z0-9_+-]+)\s*\]/
    );
    if (arrMatch && !line.startsWith("static ")) {
      const baseType = arrMatch[1];
      const varName = arrMatch[2].replace(/\*/g, "").trim();
      const dimRaw = arrMatch[3].trim();
      if (!C_KEYWORDS.has(varName) && !seenNames.has(varName)) {
        seenNames.add(varName);
        const isPtrElem = arrMatch[2].includes("*");
        const elemSize = isPtrElem ? 4 : TYPE_SIZE_MAP[baseType] ?? 4;
        let count = parseInt(dimRaw, 10);
        let isVla = false;
        if (Number.isNaN(count)) {
          if (macros[dimRaw] !== undefined) {
            count = macros[dimRaw];
          } else {
            count = 64;
            isVla = true;
          }
        }
        const totalBytes = Math.max(4, elemSize * count);
        const isLarge = totalBytes >= 128;
        localVars.push({
          name: varName,
          typeStr: `${baseType}[${dimRaw}]`,
          bytes: totalBytes,
          isArray: true,
          isVla,
          isLarge,
        });
        if (totalBytes >= 128) {
          stackWarnings.push(
            `局部数组 ${varName}[${dimRaw}] 占用 ${totalBytes} Bytes 栈空间`
          );
        }
        continue;
      }
    }

    const varMatch = line.match(
      /^(?:const\s+)?(?:volatile\s+)?(struct\s+[a-zA-Z_]\w*|[a-zA-Z_]\w*)\s+(\*?\s*[a-zA-Z_]\w*)\s*(?:=|;)/
    );
    if (varMatch && !line.startsWith("static ") && !line.includes("(")) {
      const rawType = varMatch[1].replace(/\s+/g, " ").trim();
      const rawName = varMatch[2].trim();
      const isPtr = rawName.startsWith("*");
      const varName = rawName.replace(/\*/g, "").trim();
      const cleanType = rawType.replace(/^struct\s+/, "");

      if (
        !C_KEYWORDS.has(varName) &&
        (!C_KEYWORDS.has(cleanType) || cleanType in TYPE_SIZE_MAP) &&
        !seenNames.has(varName)
      ) {
        seenNames.add(varName);
        const bytes = isPtr ? 4 : TYPE_SIZE_MAP[cleanType] ?? 4;
        localVars.push({
          name: varName,
          typeStr: isPtr ? `${rawType} *` : rawType,
          bytes,
        });
      }
    }
  }

  const frameOverhead = isIsr ? 36 : 20;
  const varsTotal = localVars.reduce(
    (acc, v) => acc + Math.ceil(v.bytes / 4) * 4,
    0
  );
  const stackBytes = frameOverhead + varsTotal;

  return { localVars, stackBytes, stackWarnings };
}

function parseCFileFunctions(
  relFile: string,
  content: string,
  macros: Record<string, number>,
  isUserSrc = true
): ParsedFileFunc[] {
  const lines = content.split(/\r?\n/);
  const results: ParsedFileFunc[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("typedef")
    ) {
      continue;
    }

    if (/^[a-zA-Z_]/.test(line) && line.includes("(") && !line.includes(";")) {
      let headerText = line;
      let braceLineIdx = i;

      while (
        braceLineIdx < Math.min(lines.length - 1, i + 4) &&
        !headerText.includes("{") &&
        !headerText.includes(";")
      ) {
        braceLineIdx++;
        headerText += " " + lines[braceLineIdx].trim();
      }

      if (!headerText.includes("{") || headerText.includes(";")) continue;

      const beforeBrace = headerText.slice(0, headerText.indexOf("{")).trim();
      const fnMatch = beforeBrace.match(/([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*$/);
      if (!fnMatch) continue;

      const fnName = fnMatch[1];
      if (C_KEYWORDS.has(fnName)) continue;

      let depth = 0;
      let endLineIdx = braceLineIdx;
      let started = false;

      for (let k = i; k < lines.length; k++) {
        const l = lines[k];
        const t = l.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) {
          continue;
        }
        const codePart = l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        for (let c = 0; c < codePart.length; c++) {
          const ch = codePart[c];
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") {
            depth--;
            if (started && depth === 0) {
              endLineIdx = k;
              break;
            }
          }
        }
        if (started && depth === 0) break;
      }

      if (!started || endLineIdx <= i) continue;

      const docBrief = extractPrecedingDocBrief(lines, i);
      const bodyLines = lines.slice(braceLineIdx + 1, endLineIdx);
      const body = bodyLines.join("\n");

      const cleanSnippetLines = bodyLines
        .filter((l) => {
          const t = l.trim();
          return t.length > 0 && t !== "{" && t !== "}";
        })
        .slice(0, 14);
      const snippet = cleanSnippetLines.join("\n") || beforeBrace;

      const isWeak =
        beforeBrace.includes("__WEAK") || beforeBrace.includes("__weak");
      const isStatic = /\bstatic\b/.test(beforeBrace);
      const isIsr = fnName.endsWith("_IRQHandler");
      const hasSwitch = /\bswitch\s*\(/.test(body);

      // Extract switch case labels
      const switchCases: string[] = [];
      const caseRegex = /\bcase\s+([A-Za-z0-9_]+)\s*:/g;
      let cm: RegExpExecArray | null;
      while ((cm = caseRegex.exec(body)) !== null) {
        if (!switchCases.includes(cm[1]) && switchCases.length < 6) {
          switchCases.push(cm[1]);
        }
      }

      const { localVars, stackBytes, stackWarnings } = analyzeFunctionStack(
        body,
        macros,
        isIsr
      );

      const directCalls: { callee: string; line: number; argsText: string }[] = [];
      const fieldAssignments: {
        field: string;
        targetFn: string;
        line: number;
      }[] = [];
      const fieldCalls: { field: string; line: number }[] = [];
      const configAssignments: string[] = [];
      const inlinePhases: InlinePhase[] = [];
      const seenCallees = new Set<string>();
      const seenFieldCalls = new Set<string>();
      const heapApis: string[] = [];
      let inMultilineComment = false;

      bodyLines.forEach((bLine, offset) => {
        const lineNum = braceLineIdx + 2 + offset;

        if (isUserSrc) {
          const cmtMatch = bLine.match(/\/\*+\s*(.*?)\s*\*+\//);
          if (cmtMatch) {
            const rawC = cmtMatch[1].replace(/^[#-]+|[#-]+$/g, "").trim();
            if (
              rawC.length >= 6 &&
              rawC.toLowerCase() !== "infinite loop" &&
              !rawC.includes("Error") &&
              !rawC.startsWith("Set the") &&
              !rawC.startsWith("Compare results")
            ) {
              if (
                bLine.includes("##-") ||
                inlinePhases.length === 0 ||
                /^(Configure|Enable|Compute|Initialize)/i.test(rawC)
              ) {
                inlinePhases.push({
                  title: rawC,
                  calls: [],
                  configs: [],
                });
              }
            }
          }
        }

        const trimmedB = bLine.trim();
        if (inMultilineComment) {
          if (trimmedB.includes("*/")) {
            inMultilineComment = false;
          }
          return;
        }
        if (trimmedB.startsWith("/*")) {
          if (!trimmedB.includes("*/")) {
            inMultilineComment = true;
          }
          return;
        }

        const clean = bLine.replace(/\/\/.*$/, "").replace(/\/\*.*$/, "");

        if (isUserSrc) {
          const cfgMatch = clean.match(
            /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*|->[a-zA-Z_]\w*)+)\s*=\s*([A-Za-z0-9_]+)\s*;/
          );
          if (cfgMatch) {
            const shortLhs = cfgMatch[1].split(/[.>]/).pop() || cfgMatch[1];
            const item = `${shortLhs}=${cfgMatch[2]}`;
            if (configAssignments.length < 8 && !configAssignments.includes(item)) {
              configAssignments.push(item);
            }
            if (inlinePhases.length > 0) {
              const lastP = inlinePhases[inlinePhases.length - 1];
              if (lastP.configs.length < 5) lastP.configs.push(item);
            }
          }
        }

        // Detect struct function pointer assignments: e.g. intf->class_interface_handler = xxx_handler;
        const assignMatch = clean.match(
          /(?:->|\.)([a-zA-Z_]\w*)\s*=\s*&?\s*([a-zA-Z_]\w*)\s*[,;]/
        );
        if (assignMatch && !C_KEYWORDS.has(assignMatch[2])) {
          fieldAssignments.push({
            field: assignMatch[1],
            targetFn: assignMatch[2],
            line: lineNum,
          });
        }

        // Detect indirect struct field invocations: e.g. ptr->read(...) or ops.write(...)
        const fieldCallRegex = /(?:->|\.)([a-zA-Z_]\w*)\s*\(/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldCallRegex.exec(clean)) !== null) {
          const fld = fm[1];
          if (!C_KEYWORDS.has(fld) && !seenFieldCalls.has(fld)) {
            seenFieldCalls.add(fld);
            fieldCalls.push({ field: fld, line: lineNum });
          }
        }

        const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = callRegex.exec(clean)) !== null) {
          const callee = m[1];
          if (C_KEYWORDS.has(callee)) continue;
          const afterParen = clean.slice(m.index + m[0].length);
          const argsText = afterParen.split(")")[0] || "";
          if (HEAP_APIS.has(callee) && !heapApis.includes(callee)) {
            heapApis.push(callee);
          }
          if (!seenCallees.has(callee)) {
            seenCallees.add(callee);
            directCalls.push({
              callee,
              line: lineNum,
              argsText,
            });
          }
          if (
            inlinePhases.length > 0 &&
            !TRIVIAL_STD_CALLS.has(callee) &&
            callee !== "Error_Handler"
          ) {
            const lastP = inlinePhases[inlinePhases.length - 1];
            if (!lastP.calls.includes(callee)) lastP.calls.push(callee);
          }
        }
      });

      results.push({
        name: fnName,
        signature: beforeBrace.replace(/\s+/g, " "),
        file: relFile,
        lineStart: i + 1,
        lineEnd: endLineIdx + 1,
        isWeak,
        isStatic,
        isUserSrc,
        docBrief,
        inlinePhases,
        configAssignments,
        body,
        snippet,
        hasSwitch,
        switchCases,
        localVars,
        stackBytes,
        stackWarnings,
        callsHeap: heapApis.length > 0,
        heapApis,
        directCalls,
        fieldAssignments,
        fieldCalls,
      });

      i = endLineIdx;
    }
  }

  return results;
}

function discoverIdeProjectLinkedFiles(
  rootDir: string
): { disp: string; fullPath: string; isLocal: boolean }[] {
  const linked: { disp: string; fullPath: string; isLocal: boolean }[] = [];
  const seen = new Set<string>();

  const scanIdeProj = (dir: string, depth = 0) => {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanIdeProj(full, depth + 1);
        } else if (/\.(uvprojx|uvproj|ewp)$/i.test(entry.name)) {
          const xml = fs.readFileSync(full, "utf-8");
          const fpRegex = /<FilePath>([^<]+\.(?:c|h|s|S))<\/FilePath>/g;
          let m: RegExpExecArray | null;
          while ((m = fpRegex.exec(xml)) !== null) {
            const rawRel = m[1]
              .trim()
              .replace(/^\$PROJ_DIR\$[\\/]/, "");
            const candidate = path.resolve(dir, rawRel);
            if (fs.existsSync(candidate) && !seen.has(candidate)) {
              seen.add(candidate);
              const isInside = candidate
                .toLowerCase()
                .startsWith(rootDir.toLowerCase());
              const disp = isInside
                ? normalizeRelPath(rootDir, candidate)
                : candidate
                    .replace(/\\/g, "/")
                    .split("/")
                    .slice(-4)
                    .join("/");
              linked.push({
                disp,
                fullPath: candidate,
                isLocal: !disp.startsWith("Drivers/"),
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }
  };
  scanIdeProj(rootDir);
  return linked;
}

function extractProjectReadmeSummary(rootDir: string): string | undefined {
  for (const name of ["readme.txt", "README.txt", "README.md", "readme.md"]) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(p)) {
      try {
        const txt = fs.readFileSync(p, "utf-8");
        const out: string[] = [];
        let inDesc = false;
        for (const l of txt.split(/\r?\n/)) {
          const t = l.trim().replace(/^\*+\s*/, "").trim();
          if (t.startsWith("@brief")) {
            out.push(t.replace(/^@brief\s*/, "").trim());
          } else if (t.startsWith("@par Example Description")) {
            inDesc = true;
          } else if (inDesc) {
            if (t.startsWith("@") || out.length >= 5) break;
            if (t) out.push(t);
          }
        }
        if (out.length > 0) return out.join(" ");
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

function parseGlobalVariables(
  relFile: string,
  content: string,
  macros: Record<string, number>
): GlobalVarInfo[] {
  const globals: GlobalVarInfo[] = [];
  const lines = content.split(/\r?\n/);
  let braceDepth = 0;
  let lastComment = "";

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
      const c = trimmed
        .replace(/^\/\*+/, "")
        .replace(/\*+\/$/, "")
        .replace(/^\*+/, "")
        .trim();
      if (c && !c.includes("Private variables")) lastComment = c;
    } else if (trimmed.startsWith("//")) {
      lastComment = trimmed.replace(/^\/+/, "").trim();
    }

    if (
      braceDepth === 0 &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("typedef")
    ) {
      const arrM = trimmed.match(
        /^(?:static\s+)?(?:const\s+)?(?:volatile\s+)?([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*\[\s*([A-Za-z0-9_]+)?\s*\]/
      );
      if (arrM && !C_KEYWORDS.has(arrM[2])) {
        const baseT = arrM[1];
        const name = arrM[2];
        const dimStr = arrM[3] || "4";
        const elemSz = TYPE_SIZE_MAP[baseT] ?? 4;
        const count =
          parseInt(dimStr, 10) || macros[dimStr] || 4;
        globals.push({
          name,
          typeStr: `${baseT}[${dimStr}]`,
          bytes: Math.max(4, elemSz * count),
          file: relFile,
          line: idx + 1,
          isStatic: trimmed.startsWith("static "),
          section: trimmed.includes("=") ? ".data" : ".bss",
          description:
            lastComment || `全局数组缓冲区 (${relFile}:${idx + 1})`,
        });
        lastComment = "";
      } else {
        const stM = trimmed.match(
          /^(?:static\s+)?(struct\s+[a-zA-Z_]\w*|[A-Z][A-Za-z0-9_]*_HandleTypeDef|[a-zA-Z_]\w*_t)\s+([a-zA-Z_]\w*)\s*(?:=|;)/
        );
        if (stM && !C_KEYWORDS.has(stM[2]) && !trimmed.includes("(")) {
          const typeS = stM[1];
          const name = stM[2];
          globals.push({
            name,
            typeStr: typeS,
            bytes: TYPE_SIZE_MAP[typeS] ?? 32,
            file: relFile,
            line: idx + 1,
            isStatic: trimmed.startsWith("static "),
            section: trimmed.includes("=") ? ".data" : ".bss",
            description:
              lastComment || `外设句柄/全局状态结构体 (${relFile}:${idx + 1})`,
          });
          lastComment = "";
        }
      }
    }

    if (
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("//")
    ) {
      continue;
    }
    const codeOnly = trimmed
      .replace(/\/\*.*?\*\//g, "")
      .replace(/\/\/.*$/, "");
    for (const ch of codeOnly) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  return globals;
}

export function analyzeLocalCProject(rootDir: string): ProjectAnalysis {
  const resolvedRoot = path.resolve(rootDir);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`目录不存在: ${resolvedRoot}`);
  }

  const isCherryUsb =
    fs.existsSync(path.join(resolvedRoot, "core", "usbd_core.c")) &&
    fs.existsSync(path.join(resolvedRoot, "core", "usbh_core.c"));

  const targetFiles: { disp: string; fullPath: string; isLocal: boolean }[] = [];
  const seenDisp = new Set<string>();

  if (isCherryUsb) {
    const cherryFiles = [
      "cherryusb_config_template.h",
      "common/usb_dc.h",
      "common/usb_hc.h",
      "common/usb_osal.h",
      "common/usb_def.h",
      "core/usbd_core.h",
      "core/usbd_core.c",
      "core/usbh_core.h",
      "core/usbh_core.c",
      "class/cdc/usbd_cdc_acm.h",
      "class/cdc/usbd_cdc_acm.c",
      "class/msc/usbd_msc.h",
      "class/msc/usbd_msc.c",
      "class/msc/usbh_msc.h",
      "class/msc/usbh_msc.c",
      "class/hid/usbd_hid.h",
      "class/hid/usbd_hid.c",
      "class/dfu/usbd_dfu.h",
      "class/dfu/usbd_dfu.c",
      "class/audio/usbd_audio.h",
      "class/audio/usbd_audio.c",
      "class/video/usbd_video.h",
      "class/video/usbd_video.c",
      "class/hub/usbh_hub.h",
      "class/hub/usbh_hub.c",
      "class/serial/usbh_serial.h",
      "class/serial/usbh_serial.c",
      "demo/cdc_acm_template.c",
      "demo/msc_ram_template.c",
      "demo/hid_keyboard_template.c",
      "demo/usb_host.c",
      "port/fsdev/usb_dc_fsdev.c",
      "port/dwc2/usb_dc_dwc2.c",
      "osal/usb_osal_freertos.c",
    ];
    for (const f of cherryFiles) {
      const full = path.join(resolvedRoot, f);
      if (fs.existsSync(full)) {
        seenDisp.add(f);
        targetFiles.push({ disp: f, fullPath: full, isLocal: true });
      }
    }
  } else {
    const walk = (dir: string) => {
      if (targetFiles.length >= 70) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (targetFiles.length >= 70) break;
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "third_party" ||
          entry.name === "build" ||
          entry.name === "target" ||
          entry.name === "Exe" ||
          entry.name === "Obj"
        ) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(c|cpp|h|hpp)$/i.test(entry.name)) {
          const disp = normalizeRelPath(resolvedRoot, full);
          if (!isSyscallBoilerplate(disp) && !seenDisp.has(disp)) {
            seenDisp.add(disp);
            targetFiles.push({ disp, fullPath: full, isLocal: true });
          }
        }
      }
    };
    walk(resolvedRoot);

    for (const item of discoverIdeProjectLinkedFiles(resolvedRoot)) {
      if (targetFiles.length >= 110) break;
      if (
        /\.(c|h)$/i.test(item.disp) &&
        !isSyscallBoilerplate(item.disp) &&
        !seenDisp.has(item.disp)
      ) {
        seenDisp.add(item.disp);
        targetFiles.push(item);
      }
    }
  }

  const filesContent: Record<string, string> = {};
  const macros: Record<string, number> = {
    CONFIG_USBDEV_REQUEST_BUFFER_LEN: 512,
    CONFIG_USBHOST_REQUEST_BUFFER_LEN: 512,
    CONFIG_USBHOST_PSC_STACKSIZE: 2048,
    CONFIG_USBDEV_EP0_STACKSIZE: 2048,
    CDC_MAX_MPS: 64,
  };

  let detectedMspStackBytes = 1024;
  let mspStackSource = "默认裸机主栈基准 (MSP Stack_Size = 0x0400 / 1024B)";

  // Also scan up to 200 files in generic projects and detect startup.s / linker .ld Stack_Size
  if (!isCherryUsb) {
    const checkStartupOrLinker = (dir: string, depth = 0) => {
      if (depth > 3) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkStartupOrLinker(full, depth + 1);
          } else if (/\.(s|S|ld|sct|icf)$/i.test(entry.name)) {
            const txt = fs.readFileSync(full, "utf-8");
            const equMatch =
              txt.match(/Stack_Size\s+EQU\s+(0x[0-9a-fA-F]+|\d+)/i) ||
              txt.match(/_Min_Stack_Size\s*=\s*(0x[0-9a-fA-F]+|\d+)/i) ||
              txt.match(/__STACK_SIZE\s*=\s*(0x[0-9a-fA-F]+|\d+)/i);
            if (equMatch) {
              const val = equMatch[1].startsWith("0x")
                ? parseInt(equMatch[1], 16)
                : parseInt(equMatch[1], 10);
              if (val >= 128 && val <= 65536) {
                detectedMspStackBytes = val;
                mspStackSource = `${normalizeRelPath(resolvedRoot, full)} (MSP Stack_Size = ${equMatch[1]} / ${val}B)`;
              }
            }
          }
        }
      } catch {
        // ignore
      }
    };
    checkStartupOrLinker(resolvedRoot);
  }

  const configMacros: {
    name: string;
    defaultVal: string;
    file: string;
    purpose: string;
  }[] = [];

  for (const { disp, fullPath, isLocal } of targetFiles) {
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      filesContent[disp] = content;
      const defRegex = /#define\s+([A-Z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+)\b/g;
      let m: RegExpExecArray | null;
      while ((m = defRegex.exec(content)) !== null) {
        const mName = m[1];
        const mRaw = m[2];
        const num = mRaw.toLowerCase().startsWith("0x")
          ? parseInt(mRaw, 16)
          : parseInt(mRaw, 10);
        if (!Number.isNaN(num)) {
          macros[mName] = num;
        }
        if (
          isLocal &&
          configMacros.length < 10 &&
          !mName.endsWith("_H") &&
          !mName.startsWith("USE_HAL_")
        ) {
          configMacros.push({
            name: mName,
            defaultVal: mRaw,
            file: disp,
            purpose: `定义于 ${disp} 的工程配置宏`,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // Build #include dependency map across all loaded files
  const headerByBasename = new Map<string, string>();
  for (const rel of Object.keys(filesContent)) {
    if (rel.endsWith(".h") || rel.endsWith(".hpp")) {
      headerByBasename.set(path.basename(rel), rel);
    }
  }
  const fileIncludes: Record<string, string[]> = {};
  for (const [rel, content] of Object.entries(filesContent)) {
    const incs: string[] = [];
    const incRegex = /#include\s+["<]([^">]+)[">]/g;
    let im: RegExpExecArray | null;
    while ((im = incRegex.exec(content)) !== null) {
      const rawInc = im[1].replace(/\\/g, "/");
      if (filesContent[rawInc]) {
        if (!incs.includes(rawInc)) incs.push(rawInc);
      } else {
        const base = path.basename(rawInc);
        const mapped = headerByBasename.get(base);
        if (mapped && !incs.includes(mapped)) {
          incs.push(mapped);
        }
      }
    }
    fileIncludes[rel] = incs;
  }

  const parsedFuncs = new Map<string, ParsedFileFunc>();
  const weakFuncNames = new Set<string>();
  const genericGlobals: GlobalVarInfo[] = [];

  for (const { disp, isLocal } of targetFiles) {
    if (!disp.endsWith(".c") && !disp.endsWith(".cpp")) continue;
    const content = filesContent[disp];
    if (!content) continue;

    if (isLocal && !isCherryUsb) {
      for (const g of parseGlobalVariables(disp, content, macros)) {
        if (!genericGlobals.some((x) => x.name === g.name)) {
          genericGlobals.push(g);
        }
      }
    }

    const fns = parseCFileFunctions(disp, content, macros, isLocal);
    for (const fn of fns) {
      if (isSyscallBoilerplate(disp, fn.name)) continue;
      if (fn.isWeak) {
        weakFuncNames.add(fn.name);
      }
      const existing = parsedFuncs.get(fn.name);
      if (
        !existing ||
        (existing.isWeak && !fn.isWeak) ||
        (!existing.isUserSrc && fn.isUserSrc)
      ) {
        if (
          existing &&
          existing.file.startsWith("port/fsdev/") &&
          disp.startsWith("port/dwc2/")
        ) {
          continue;
        }
        if (
          existing &&
          existing.file === "demo/cdc_acm_template.c" &&
          disp.startsWith("demo/")
        ) {
          continue;
        }
        if (existing && existing.isUserSrc && !fn.isUserSrc) {
          continue;
        }
        parsedFuncs.set(fn.name, fn);
      }
    }
  }

  if (isCherryUsb) {
    const res = buildCherryUsbAnalysis(
      resolvedRoot,
      filesContent,
      parsedFuncs,
      weakFuncNames
    );
    res.fileIncludes = fileIncludes;
    return res;
  }

  const res = buildGenericCProjectAnalysis(
    resolvedRoot,
    filesContent,
    parsedFuncs,
    weakFuncNames,
    genericGlobals,
    configMacros
  );
  res.fileIncludes = fileIncludes;
  res.detectedMspStackBytes = detectedMspStackBytes;
  res.mspStackSource = mspStackSource;
  return res;
}

function buildCherryUsbAnalysis(
  rootDir: string,
  files: Record<string, string>,
  parsedFuncs: Map<string, ParsedFileFunc>,
  weakFuncNames: Set<string>
): ProjectAnalysis {
  const globals: GlobalVarInfo[] = [
    {
      name: "g_usbd_core",
      typeStr: "struct usbd_core_priv[CONFIG_USBDEV_MAX_BUS]",
      bytes: 648,
      file: "core/usbd_core.c",
      line: 82,
      isStatic: false,
      section: ".bss",
      description:
        "USB Device 核心控制块（保存 EP0 状态机、描述符回调表、接口与端点 tx_msg/rx_msg 回调指针）",
    },
    {
      name: "g_usbdev_bus",
      typeStr: "struct usbd_bus[CONFIG_USBDEV_MAX_BUS]",
      bytes: 16,
      file: "core/usbd_core.c",
      line: 84,
      isStatic: false,
      section: ".bss",
      description: "USB Device 总线实例与硬件寄存器基地址映射",
    },
    {
      name: "g_fsdev_udc",
      typeStr: "struct fsdev_udc",
      bytes: 280,
      file: "port/fsdev/usb_dc_fsdev.c",
      line: 53,
      isStatic: false,
      section: ".bss",
      description:
        "STM32/通用 FSDEV USB 硬件控制器端点 PMA 缓冲区与传输状态结构体",
    },
    {
      name: "g_usbd_msc",
      typeStr: "struct usbd_msc_priv[CONFIG_USBDEV_MAX_BUS]",
      bytes: 584,
      file: "class/msc/usbd_msc.c",
      line: 61,
      isStatic: false,
      section: ".bss",
      description:
        "USB MSC 大容量存储 BOT 状态机（CBW/CSW 缓冲、LUN 容量、Stage 状态）",
    },
    {
      name: "g_usbd_video",
      typeStr: "struct usbd_video_priv[CONFIG_USBDEV_MAX_BUS]",
      bytes: 192,
      file: "class/video/usbd_video.c",
      line: 29,
      isStatic: false,
      section: ".bss",
      description:
        "USB Video (UVC) 摄像头 Probe/Commit 协商参数与流实体控制块",
    },
    {
      name: "g_usbhost_bus",
      typeStr: "struct usbh_bus[CONFIG_USBHOST_MAX_BUS]",
      bytes: 1024,
      file: "core/usbh_core.c",
      line: 24,
      isStatic: false,
      section: ".bss",
      description:
        "USB Host 主机总线控制块（含 Roothub 端口树、HCD 句柄、hub_mq 消息队列与事件回调）",
    },
    {
      name: "ep0_request_buffer",
      typeStr: "uint8_t[CONFIG_USBHOST_MAX_BUS][512]",
      bytes: 512,
      file: "core/usbh_core.c",
      line: 22,
      isStatic: false,
      section: ".bss",
      description: "USB Host EP0 控制传输与描述符读取 DMA 对齐静态缓冲区",
    },
    {
      name: "read_buffer",
      typeStr: "uint8_t[2048] (USB_NOCACHE_RAM_SECTION)",
      bytes: 2048,
      file: "demo/cdc_acm_template.c",
      line: 90,
      isStatic: false,
      section: ".bss",
      description: "CDC ACM Bulk OUT 端点无缓存对齐接收缓冲区",
    },
    {
      name: "write_buffer",
      typeStr: "uint8_t[2048] (USB_NOCACHE_RAM_SECTION)",
      bytes: 2048,
      file: "demo/cdc_acm_template.c",
      line: 91,
      isStatic: false,
      section: ".bss",
      description: "CDC ACM Bulk IN 端点无缓存对齐发送缓冲区",
    },
    {
      name: "cdc_descriptor",
      typeStr: "const struct usb_descriptor",
      bytes: 32,
      file: "demo/cdc_acm_template.c",
      line: 83,
      isStatic: false,
      section: ".data",
      description: "挂载设备/配置/字符串描述符获取回调函数的注册表结构体",
    },
  ];

  const briefMap: Record<string, string> = {
    cdc_acm_init:
      "CDC ACM 虚拟串口完整初始化入口：注册描述符表、挂载 CDC 接口与 IN/OUT 端点回调并启动 USB Device 协议栈",
    usbd_desc_register:
      "注册 usb_descriptor 回调表，并将 EP0 默认 IN/OUT 完成回调挂载到 tx_msg[0].cb / rx_msg[0].cb",
    usbd_cdc_acm_init_intf:
      "初始化 CDC ACM 接口：将 cdc_acm_class_interface_request_handler 挂载至 intf->class_interface_handler",
    usbd_add_interface:
      "将 USB Class 接口注册到 g_usbd_core[busid].intf[] 数组供枚举与类请求派发",
    usbd_add_endpoint:
      "将端点的完成回调函数 ep->ep_cb 注册到 g_usbd_core 的 tx_msg / rx_msg 槽位",
    usbd_initialize:
      "USB Device 协议栈总初始化：通知所有 Class 与用户事件回调，并调用移植层 usb_dc_init 初始化硬件控制器",
    usbd_class_event_notify_handler:
      "遍历所有已注册接口，通过 intf->notify_handler 函数指针广播 RESET/INIT/CONFIGURED 事件",
    usbd_event_handler:
      "用户应用层事件回调：在收到 USBD_EVENT_CONFIGURED 后启动首次 CDC_OUT_EP 异步读取",
    usb_dc_init:
      "【DCD 硬件移植边界】初始化芯片 USB 设备控制器寄存器、PMA 内存并调用 __WEAK usb_dc_low_level_init",
    usb_dc_low_level_init:
      "【__WEAK 硬件引脚/时钟钩子】供用户实现 USB 引脚复用、时钟使能与 NVIC 中断配置",
    USBD_IRQHandler:
      "【DCD 硬件中断总入口】读取 USB->ISTR 状态寄存器，分发 RESET、EP0 Setup 请求及各端点 IN/OUT 传输完成事件",
    usbd_event_reset_handler:
      "处理 USB 总线复位：重置地址为 0，回调获取设备描述符，打开 EP0 IN/OUT 端点并通知上层",
    device_descriptor_callback:
      "返回 USB 设备描述符数组（含 bMaxPacketSize0、VID/PID）",
    usbd_ep_open:
      "【DCD 硬件移植接口】配置并使能指定物理端点的传输类型、PMA 地址与最大包长 (MPS)",
    usbd_event_ep0_setup_complete_handler:
      "收到 8 字节 EP0 Setup 包后的协议栈入口（支持中断直调或投递至 usbd_ep0_mq 线程）",
    __usbd_event_ep0_setup_complete_handler:
      "EP0 控制传输状态机核心：解析 Setup 方向与长度，调用 usbd_setup_request_handler 并启动数据阶段或状态阶段",
    usbd_setup_request_handler:
      "Setup 请求一级分发器：按 bmRequestType 分发至标准请求 (Standard)、类请求 (Class) 或厂商请求 (Vendor)",
    usbd_standard_request_handler:
      "USB 2.0 标准请求分发器：处理设备级 (GET_DESCRIPTOR / SET_ADDRESS / SET_CONFIG)、接口级与端点级请求",
    usbd_std_device_req_handler:
      "处理标准设备枚举请求：获取描述符、设置设备地址、激活配置并触发 USBD_EVENT_CONFIGURED",
    usbd_get_descriptor:
      "读取设备/配置/字符串描述符：回调 descriptors 表中的对应钩子函数组装返回数据",
    usbd_set_configuration:
      "激活 USB 配置：自动解析配置描述符打开所有非 0 端点，并通知 Class 与应用层进入 CONFIGURED 状态",
    usbd_class_request_handler:
      "USB 类请求分发器：根据 wIndex 查找目标接口并通过 intf->class_interface_handler 函数指针回调具体 Class",
    cdc_acm_class_interface_request_handler:
      "CDC ACM 类请求处理器：解析 SET_LINE_CODING (波特率) 与 SET_CONTROL_LINE_STATE (DTR/RTS) 并调用 __WEAK 钩子",
    usbd_cdc_acm_set_dtr:
      "【__WEAK 强重写回调】应用层重写 DTR 信号回调，当主机打开串口终端时置位 dtr_enable",
    usbd_cdc_acm_set_line_coding:
      "【__WEAK 回调钩子】主机设置虚拟串口波特率/停止位/校验位时触发",
    usbd_event_ep_out_complete_handler:
      "非 0 OUT 端点接收完成分发器：通过 g_usbd_core[busid].rx_msg[ep].cb 函数指针异步回调业务端点函数",
    usbd_event_ep_in_complete_handler:
      "非 0 IN 端点发送完成分发器：通过 g_usbd_core[busid].tx_msg[ep].cb 函数指针异步回调业务端点函数",
    usbd_cdc_acm_bulk_out:
      "CDC Bulk OUT 接收完成回调：处理主机发来的串口数据，并立即调用 usbd_ep_start_read 准备接收下一包",
    usbd_cdc_acm_bulk_in:
      "CDC Bulk IN 发送完成回调：若包长为 MPS 整数倍则补发 ZLP 零长包，否则清除 ep_tx_busy_flag",
    usbd_ep_start_read:
      "【DCD 硬件移植接口】配置 OUT 端点接收缓冲区并使能硬件 RX_VALID 状态",
    usbd_ep_start_write:
      "【DCD 硬件移植接口】将数据写入 PMA / FIFO 并使能硬件 TX_VALID 发送",
    fsdev_read_pma:
      "从 USB 控制器专用 Packet Memory Area (PMA) 拷贝接收数据到用户缓冲区",
    fsdev_write_pma:
      "将用户发送缓冲区数据按 16-bit 对齐写入 USB 控制器 PMA 内存",
    mass_storage_bulk_out:
      "MSC 大容量存储 Bulk OUT 回调：驱动 BOT (Bulk-Only Transport) 状态机（CBW 命令解码与 DATA_OUT 写扇区）",
    mass_storage_bulk_in:
      "MSC 大容量存储 Bulk IN 回调：驱动 BOT DATA_IN 读扇区继续发送与 CSW 状态阶段收尾",
    SCSI_CBWDecode:
      "解析 31 字节 SCSI CBW 命令块，分发 INQUIRY / READ_CAPACITY / READ10 / WRITE10 等 15+ 种磁盘指令",
    SCSI_processRead:
      "处理 SCSI 读扇区数据流：调用 __WEAK usbd_msc_sector_read 读取块设备并通过 Bulk IN 发送",
    SCSI_processWrite:
      "处理 SCSI 写扇区数据流：调用 __WEAK usbd_msc_sector_write 落盘并开启下一包接收或发送 CSW",
    usbd_msc_send_csw:
      "封装 13 字节 CSW (Command Status Wrapper) 并通过 Bulk IN 端点回传给主机",
    usbd_msc_sector_read:
      "【__WEAK 存储介质移植接口】移植 MSC 到 SD 卡/SPI Flash/RAMDisk 时必须重写的扇区读取函数",
    usbd_msc_sector_write:
      "【__WEAK 存储介质移植接口】移植 MSC 到 SD 卡/SPI Flash/RAMDisk 时必须重写的扇区写入函数",
    usbd_msc_get_cap:
      "【__WEAK 存储介质移植接口】返回磁盘总扇区数 (block_num) 与扇区大小 (block_size)",
    usbh_initialize:
      "USB Host 主机协议栈总入口：初始化总线链表、扫描编译器段注册的 Class 驱动表并启动 Hub 热插拔管理线程",
    usbh_hub_initialize:
      "创建 hub_mq 消息队列与信号量，并通过 usb_osal_thread_create 启动 usbh_hub_thread 内核线程",
    usbh_hub_thread:
      "【RTOS 核心线程】初始化 HCD 主机控制器 (usb_hc_init)，循环阻塞等待 hub_mq 端口状态变化消息并执行枚举",
    usbh_hub_events:
      "扫描 Hub 各端口连接状态：执行 100ms 插入消抖、发送端口复位、检测高低速并调用 usbh_enumerate 枚举新设备",
    usbh_hub_get_portstatus:
      "读取 Roothub 或外部 Hub 的端口连接与速度状态 (4 字节 hub_port_status)",
    usbh_hub_set_feature:
      "向 Roothub 或外部 Hub 发送 PORT_RESET / PORT_POWER 等控制特性请求",
    usbh_enumerate:
      "【USB Host 枚举核心 (275行)】分配设备地址、读取设备与配置描述符、动态分配 raw_config_desc 并自动匹配加载 Class 驱动",
    parse_device_descriptor: "解析 18 字节标准 USB 设备描述符",
    parse_config_descriptor:
      "解析配置描述符、接口描述符 (Interface) 与端点描述符 (Endpoint)",
    usbh_control_transfer:
      "USB Host EP0 控制传输同步封装：加互斥锁填充 URB 并调用底层 HCD usbh_submit_urb（含 3 次失败重试）",
    usbh_get_string_desc:
      "读取设备厂商/产品/序列号 Unicode 字符串描述符并转换为 ASCII",
    usbh_hub_connect:
      "【外部扩展 Hub Class connect 回调】当枚举发现外接 USB Hub 时动态分配 hub 结构并递归监测下级端口",
    usbh_msc_connect:
      "【Host MSC U盘 Class connect 回调】枚举发现 U 盘时打开 Bulk IN/OUT 管道并启动 SCSI 初始化",
    usbh_msc_scsi_init:
      "Host U盘 SCSI 初始化序列：依次执行 TestUnitReady、Inquiry、ReadCapacity10 获取 U 盘容量",
    usbh_bulk_cbw_csw_xfer:
      "Host U盘 BOT 传输核心：依次提交 31B CBW、数据阶段 URB 与 13B CSW 状态校验",
    video_class_interface_request_handler:
      "UVC 摄像头类请求总分发：区分 VideoControl (亮度/对比度/单元控制) 与 VideoStreaming (Probe/Commit 协商)",
    usbd_video_stream_start_write:
      "UVC 视频帧分片传输入口：自动为 MJPEG/YUYV/H264 帧切分 Payload Header (12B) 并提交端点发送",
    lsusb:
      "CherryUSB 内置命令行工具：支持 -v (详细描述符) 与 -t (物理设备树) 遍历打印所有总线与挂载设备",
    usbh_list_device:
      "【含直接递归调用】遍历打印当前 Hub 下所有连接设备；若子设备仍是 Hub 则递归调用自身遍历下级树",
    usbh_print_hubport_info:
      "详细格式化打印设备的 Device / Config / Interface / Endpoint 全套描述符",
  };

  const nodes: Record<string, FunctionNodeData> = {};

  for (const [name, pf] of parsedFuncs.entries()) {
    const isWeakSym = pf.isWeak || weakFuncNames.has(name);
    const layer = classifyLayerByFileAndName(pf.file, name, isWeakSym);
    const readsGlobals: string[] = [];
    const writesGlobals: string[] = [];

    for (const g of globals) {
      if (pf.body.includes(g.name)) {
        readsGlobals.push(g.name);
        if (
          new RegExp(`${g.name}[^;]*=[^=]`).test(pf.body) ||
          pf.body.includes(`&${g.name}`)
        ) {
          writesGlobals.push(g.name);
        }
      }
    }

    nodes[name] = {
      id: name,
      name,
      signature: pf.signature,
      file: pf.file,
      lineStart: pf.lineStart,
      lineEnd: pf.lineEnd,
      layer,
      isCallback: layer === "CALLBACK",
      isIsr: name.endsWith("_IRQHandler"),
      hasStateMachine: pf.hasSwitch,
      stackBytes: pf.stackBytes,
      localVars: pf.localVars,
      stackWarnings: pf.stackWarnings.length > 0 ? pf.stackWarnings : undefined,
      readsGlobals,
      writesGlobals,
      callsHeap: pf.callsHeap,
      heapApis: pf.heapApis,
      snippet: pf.snippet,
      brief:
        briefMap[name] ||
        (pf.switchCases.length > 0
          ? `状态机/分支处理 (${pf.switchCases.slice(0, 3).join(", ")}) — ${pf.file}:${pf.lineStart}`
          : `定义于 ${pf.file}:${pf.lineStart} 的 ${layer} 层函数`),
    };
  }

  const ensureExternalHalNode = (
    name: string,
    signature: string,
    file: string,
    brief: string,
    stackBytes = 40
  ) => {
    if (!nodes[name]) {
      nodes[name] = {
        id: name,
        name,
        signature,
        file,
        lineStart: 1,
        lineEnd: 1,
        layer: "HAL",
        isExternal: true,
        stackBytes,
        localVars: [],
        readsGlobals: [],
        writesGlobals: [],
        snippet: `/* Porting Boundary Interface (${file}) */\n${signature};`,
        brief,
      };
    }
  };

  ensureExternalHalNode(
    "usb_hc_init",
    "int usb_hc_init(struct usbh_bus *bus)",
    "common/usb_hc.h",
    "【HCD 硬件移植边界】初始化 USB Host 主机控制器 (EHCI/DWC2/OHCI) 寄存器与 DMA"
  );
  ensureExternalHalNode(
    "usbh_roothub_control",
    "int usbh_roothub_control(struct usbh_bus *bus, struct usb_setup_packet *setup, uint8_t *buf)",
    "common/usb_hc.h",
    "【HCD 硬件移植边界】主机控制器 Roothub 端口状态查询与端口复位寄存器操作"
  );
  ensureExternalHalNode(
    "usbh_submit_urb",
    "int usbh_submit_urb(struct usbh_urb *urb)",
    "common/usb_hc.h",
    "【HCD 硬件移植边界】向底层 USB 主机控制器提交 URB 传输请求块（控制/批量/中断/同步传输）",
    56
  );
  ensureExternalHalNode(
    "usb_osal_malloc",
    "void *usb_osal_malloc(size_t size)",
    "common/usb_osal.h",
    "【OSAL 操作系统移植边界】动态分配堆内存（用于保存设备 raw_config_desc 等）",
    32
  );

  // Build universal direct + callback + weak edges across all parsed functions
  const edgeMap = new Map<string, CallEdgeData>();
  const addEdge = (edge: CallEdgeData) => {
    if (!nodes[edge.source] || !nodes[edge.target]) return;
    const key = `${edge.source}->${edge.target}`;
    if (!edgeMap.has(key) || edge.kind !== "DIRECT") {
      edgeMap.set(key, edge);
    }
  };

  let autoEdgeIdx = 1;
  for (const [name, pf] of parsedFuncs.entries()) {
    // 1. Direct function calls (or __WEAK calls) inside function body
    for (const call of pf.directCalls) {
      if (nodes[call.callee]) {
        const isWeakTarget =
          weakFuncNames.has(call.callee) ||
          parsedFuncs.get(call.callee)?.isWeak;
        addEdge({
          id: `e_auto_${autoEdgeIdx++}`,
          source: name,
          target: call.callee,
          kind: isWeakTarget ? "WEAK_OVERRIDE" : "DIRECT",
          label: isWeakTarget ? "__WEAK 钩子" : undefined,
          callSiteLine: call.line,
        });
      }
    }

    // 2. Struct function pointer assignments inside body (e.g. intf->class_interface_handler = xxx)
    for (const fa of pf.fieldAssignments) {
      if (nodes[fa.targetFn]) {
        addEdge({
          id: `e_auto_${autoEdgeIdx++}`,
          source: name,
          target: fa.targetFn,
          kind: "OPS_TABLE",
          label: `.${fa.field} = ${fa.targetFn}`,
          registeredAt: `${pf.file}:${fa.line}`,
          callSiteLine: fa.line,
        });
      }
    }
  }

  // 3. Curated semantic callback edges for CherryUSB core dispatchers
  const curatedEdges: CallEdgeData[] = [
    { id: "c_init_1", source: "cdc_acm_init", target: "usbd_desc_register", kind: "DIRECT", callSiteLine: 167 },
    {
      id: "c_init_2",
      source: "usbd_desc_register",
      target: "device_descriptor_callback",
      kind: "OPS_TABLE",
      label: "descriptors->device_descriptor_callback",
      registeredAt: "demo/cdc_acm_template.c:84",
    },
    { id: "c_init_3", source: "cdc_acm_init", target: "usbd_cdc_acm_init_intf", kind: "DIRECT", callSiteLine: 169 },
    {
      id: "c_init_4",
      source: "usbd_cdc_acm_init_intf",
      target: "cdc_acm_class_interface_request_handler",
      kind: "OPS_TABLE",
      label: "intf->class_interface_handler",
      registeredAt: "class/cdc/usbd_cdc_acm.c:89",
    },
    { id: "c_init_5", source: "cdc_acm_init", target: "usbd_add_interface", kind: "DIRECT", callSiteLine: 169 },
    { id: "c_init_6", source: "cdc_acm_init", target: "usbd_add_endpoint", kind: "DIRECT", callSiteLine: 171 },
    {
      id: "c_init_7",
      source: "usbd_add_endpoint",
      target: "usbd_cdc_acm_bulk_out",
      kind: "ASYNC_CALLBACK",
      label: "rx_msg[ep].cb = ep->ep_cb",
      registeredAt: "demo/cdc_acm_template.c:149",
    },
    {
      id: "c_init_8",
      source: "usbd_add_endpoint",
      target: "usbd_cdc_acm_bulk_in",
      kind: "ASYNC_CALLBACK",
      label: "tx_msg[ep].cb = ep->ep_cb",
      registeredAt: "demo/cdc_acm_template.c:154",
    },
    { id: "c_init_9", source: "cdc_acm_init", target: "usbd_initialize", kind: "DIRECT", callSiteLine: 173 },
    { id: "c_init_10", source: "usbd_initialize", target: "usbd_class_event_notify_handler", kind: "DIRECT", callSiteLine: 1367 },
    {
      id: "c_init_11",
      source: "usbd_initialize",
      target: "usbd_event_handler",
      kind: "ASYNC_CALLBACK",
      label: "g_usbd_core.event_handler(INIT)",
      registeredAt: "core/usbd_core.c:1366",
    },
    { id: "c_init_12", source: "usbd_event_handler", target: "usbd_ep_start_read", kind: "DIRECT", callSiteLine: 111 },
    { id: "c_init_13", source: "usbd_initialize", target: "usb_dc_init", kind: "DIRECT", callSiteLine: 1369 },
    {
      id: "c_init_14",
      source: "usb_dc_init",
      target: "usb_dc_low_level_init",
      kind: "WEAK_OVERRIDE",
      label: "__WEAK 底层时钟/引脚钩子",
      callSiteLine: 67,
    },
    // ISR -> EP0 & Endpoint callbacks
    { id: "c_isr_1", source: "USBD_IRQHandler", target: "usbd_event_reset_handler", kind: "DIRECT", callSiteLine: 441 },
    {
      id: "c_isr_2",
      source: "usbd_event_reset_handler",
      target: "device_descriptor_callback",
      kind: "OPS_TABLE",
      label: "descriptors->device_descriptor_callback()",
      callSiteLine: 999,
    },
    { id: "c_isr_3", source: "usbd_event_reset_handler", target: "usbd_ep_open", kind: "DIRECT", callSiteLine: 1007 },
    { id: "c_isr_4", source: "USBD_IRQHandler", target: "usbd_event_ep0_setup_complete_handler", kind: "DIRECT", callSiteLine: 378 },
    {
      id: "c_isr_5",
      source: "usbd_event_ep0_setup_complete_handler",
      target: "__usbd_event_ep0_setup_complete_handler",
      kind: "DIRECT",
      callSiteLine: 1106,
    },
    {
      id: "c_isr_6",
      source: "__usbd_event_ep0_setup_complete_handler",
      target: "usbd_setup_request_handler",
      kind: "DIRECT",
      callSiteLine: 1051,
    },
    {
      id: "c_isr_7",
      source: "__usbd_event_ep0_setup_complete_handler",
      target: "usbd_ep_start_write",
      kind: "DIRECT",
      callSiteLine: 1086,
    },
    {
      id: "c_isr_8",
      source: "usbd_setup_request_handler",
      target: "usbd_standard_request_handler",
      kind: "DIRECT",
      callSiteLine: 905,
    },
    {
      id: "c_isr_9",
      source: "usbd_standard_request_handler",
      target: "usbd_std_device_req_handler",
      kind: "DIRECT",
      callSiteLine: 749,
    },
    { id: "c_isr_10", source: "usbd_std_device_req_handler", target: "usbd_get_descriptor", kind: "DIRECT", callSiteLine: 519 },
    { id: "c_isr_11", source: "usbd_std_device_req_handler", target: "usbd_set_configuration", kind: "DIRECT", callSiteLine: 501 },
    {
      id: "c_isr_12",
      source: "usbd_set_configuration",
      target: "usbd_event_handler",
      kind: "ASYNC_CALLBACK",
      label: "event_handler(CONFIGURED)",
      callSiteLine: 382,
    },
    {
      id: "c_isr_13",
      source: "usbd_setup_request_handler",
      target: "usbd_class_request_handler",
      kind: "DIRECT",
      callSiteLine: 917,
    },
    {
      id: "c_isr_14",
      source: "usbd_class_request_handler",
      target: "cdc_acm_class_interface_request_handler",
      kind: "OPS_TABLE",
      label: "intf->class_interface_handler()",
      callSiteLine: 794,
    },
    {
      id: "c_isr_15",
      source: "cdc_acm_class_interface_request_handler",
      target: "usbd_cdc_acm_set_dtr",
      kind: "WEAK_OVERRIDE",
      label: "__WEAK DTR回调重写",
      callSiteLine: 60,
    },
    {
      id: "c_isr_16",
      source: "cdc_acm_class_interface_request_handler",
      target: "usbd_cdc_acm_set_line_coding",
      kind: "WEAK_OVERRIDE",
      label: "__WEAK 波特率回调",
      callSiteLine: 50,
    },
    {
      id: "c_isr_17",
      source: "USBD_IRQHandler",
      target: "usbd_event_ep_out_complete_handler",
      kind: "DIRECT",
      callSiteLine: 412,
    },
    {
      id: "c_isr_18",
      source: "usbd_event_ep_out_complete_handler",
      target: "usbd_cdc_acm_bulk_out",
      kind: "ASYNC_CALLBACK",
      label: "rx_msg[ep].cb()",
      callSiteLine: 1212,
    },
    { id: "c_isr_19", source: "usbd_cdc_acm_bulk_out", target: "usbd_ep_start_read", kind: "DIRECT", callSiteLine: 131 },
    { id: "c_isr_20", source: "USBD_IRQHandler", target: "usbd_event_ep_in_complete_handler", kind: "DIRECT", callSiteLine: 427 },
    {
      id: "c_isr_21",
      source: "usbd_event_ep_in_complete_handler",
      target: "usbd_cdc_acm_bulk_in",
      kind: "ASYNC_CALLBACK",
      label: "tx_msg[ep].cb()",
      callSiteLine: 1205,
    },
    { id: "c_isr_22", source: "usbd_cdc_acm_bulk_in", target: "usbd_ep_start_write", kind: "DIRECT", callSiteLine: 140 },
    { id: "c_isr_23", source: "usbd_ep_start_write", target: "fsdev_write_pma", kind: "DIRECT", callSiteLine: 299 },
    { id: "c_isr_24", source: "USBD_IRQHandler", target: "fsdev_read_pma", kind: "DIRECT", callSiteLine: 405 },
    // Host Hub & MSC
    {
      id: "c_host_15",
      source: "usbh_enumerate",
      target: "usbh_hub_connect",
      kind: "OPS_TABLE",
      label: "CLASS_CONNECT (hub_driver->connect)",
      registeredAt: "class/hub/usbh_hub.c:773",
      callSiteLine: 579,
    },
    {
      id: "c_host_16",
      source: "usbh_enumerate",
      target: "usbh_msc_connect",
      kind: "OPS_TABLE",
      label: "CLASS_CONNECT (msc_driver->connect)",
      registeredAt: "class/msc/usbh_msc.c:456",
      callSiteLine: 579,
    },
    {
      id: "c_ls_7",
      source: "usbh_list_device",
      target: "usbh_list_device",
      kind: "ASYNC_CALLBACK",
      label: "级联 Hub 树直接递归遍历",
      callSiteLine: 1056,
    },
  ];

  for (const ce of curatedEdges) {
    addEdge(ce);
  }

  const edges = Array.from(edgeMap.values());

  // Helper to get edge IDs connecting a set of nodeIds
  const edgesForNodes = (nids: string[]): string[] => {
    const s = new Set(nids);
    return edges.filter((e) => s.has(e.source) && s.has(e.target)).map((e) => e.id);
  };

  const entries: FeatureEntry[] = [
    {
      id: "cherry_usbd_irq_enum",
      name: "USBD_IRQHandler",
      displayName: "USB Device 中断枚举与端点回调全链路",
      category: "ISR",
      entryNodeId: "USBD_IRQHandler",
      summary:
        "CherryUSB Device 核心脉络：从 DCD 硬件中断 USBD_IRQHandler 出发，涵盖总线复位、EP0 标准枚举请求、Class 接口表回调 (intf->class_interface_handler)、__WEAK 钩子重写及 Bulk IN/OUT 端点完成异步回调。",
      nodeIds: [
        "USBD_IRQHandler",
        "usbd_event_reset_handler",
        "device_descriptor_callback",
        "usbd_ep_open",
        "usbd_event_ep0_setup_complete_handler",
        "__usbd_event_ep0_setup_complete_handler",
        "usbd_setup_request_handler",
        "usbd_standard_request_handler",
        "usbd_std_device_req_handler",
        "usbd_get_descriptor",
        "usbd_set_configuration",
        "usbd_event_handler",
        "usbd_class_request_handler",
        "cdc_acm_class_interface_request_handler",
        "usbd_cdc_acm_set_dtr",
        "usbd_cdc_acm_set_line_coding",
        "usbd_event_ep_out_complete_handler",
        "usbd_cdc_acm_bulk_out",
        "usbd_event_ep_in_complete_handler",
        "usbd_cdc_acm_bulk_in",
        "usbd_ep_start_read",
        "usbd_ep_start_write",
        "fsdev_read_pma",
        "fsdev_write_pma",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [
        {
          name: "CONFIG_USBDEV_REQUEST_BUFFER_LEN",
          defaultVal: "512",
          file: "cherryusb_config_template.h",
          purpose: "EP0 控制传输最大请求缓冲区大小",
        },
        {
          name: "CONFIG_USBDEV_EP0_THREAD",
          defaultVal: "0 (可选)",
          file: "core/usbd_core.c",
          purpose: "是否将 EP0 Setup 处理从中断剥离到独立 OSAL 线程",
        },
      ],
      staticFlowOutline: [
        {
          id: "s1",
          stage: "1. 硬件中断入口与总线复位",
          title: "USBD_IRQHandler ➔ usbd_event_reset_handler",
          nodeId: "USBD_IRQHandler",
          detail:
            "读取 USB->ISTR，收到 RESET 时重置地址为 0，通过 descriptors->device_descriptor_callback 获取 MPS0 并调用 usbd_ep_open 打开控制端点 EP0。",
          tag: "HAL",
        },
        {
          id: "s2",
          stage: "2. EP0 标准请求枚举 (Get Descriptor / Set Config)",
          title:
            "__usbd_event_ep0_setup_complete_handler ➔ usbd_std_device_req_handler",
          nodeId: "__usbd_event_ep0_setup_complete_handler",
          detail:
            "主机发送 8 字节 Setup 包，经标准请求处理器读取设备/配置描述符；在 usbd_set_configuration 中激活配置并异步触发应用层 usbd_event_handler(USBD_EVENT_CONFIGURED)。",
          tag: "FSM",
        },
        {
          id: "s3",
          stage: "3. Class 接口表回调 + __WEAK 钩子重写",
          title: "usbd_class_request_handler ➔ intf->class_interface_handler()",
          nodeId: "cdc_acm_class_interface_request_handler",
          detail:
            "类请求通过 g_usbd_core[busid].intf[i]->class_interface_handler 虚线派发到 CDC 类处理器，进而调用用户重写的 __WEAK usbd_cdc_acm_set_dtr。",
          tag: "CALLBACK",
        },
        {
          id: "s4",
          stage: "4. 端点收发完成异步回调闭环",
          title:
            "usbd_event_ep_out/in_complete_handler ➔ rx_msg/tx_msg[ep].cb()",
          nodeId: "usbd_cdc_acm_bulk_out",
          detail:
            "非 0 端点传输完成时，通过 usbd_add_endpoint 注册在 rx_msg/tx_msg 的函数指针直接回调 usbd_cdc_acm_bulk_out / bulk_in，调用 usbd_ep_start_read 持续乒乓收发。",
          tag: "CALLBACK",
        },
      ],
    },
    {
      id: "cherry_cdc_init",
      name: "cdc_acm_init",
      displayName: "USB Device CDC ACM 初始化与回调挂载链",
      category: "MAIN_LOOP",
      entryNodeId: "cdc_acm_init",
      summary:
        "展示应用层如何一步步把描述符回调表 (usb_descriptor)、类接口回调 (usbd_interface) 和端点收发回调 (usbd_endpoint) 注册进 core，并最终调用 DCD 移植接口 usb_dc_init。",
      nodeIds: [
        "cdc_acm_init",
        "usbd_desc_register",
        "device_descriptor_callback",
        "usbd_cdc_acm_init_intf",
        "cdc_acm_class_interface_request_handler",
        "usbd_add_interface",
        "usbd_add_endpoint",
        "usbd_cdc_acm_bulk_out",
        "usbd_cdc_acm_bulk_in",
        "usbd_initialize",
        "usbd_class_event_notify_handler",
        "usbd_event_handler",
        "usbd_ep_start_read",
        "usb_dc_init",
        "usb_dc_low_level_init",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [
        {
          name: "CONFIG_USBDEV_MAX_BUS",
          defaultVal: "1",
          file: "cherryusb_config_template.h",
          purpose: "支持的 USB Device 控制器总线数量",
        },
        {
          name: "CDC_MAX_MPS",
          defaultVal: "64 / 512",
          file: "demo/cdc_acm_template.c",
          purpose: "FS/HS 模式端点最大包长",
        },
      ],
      staticFlowOutline: [
        {
          id: "ci_1",
          stage: "1. 描述符回调表挂载",
          title: "usbd_desc_register(&cdc_descriptor)",
          nodeId: "usbd_desc_register",
          detail:
            "将 cdc_descriptor 挂载到 g_usbd_core[busid].descriptors，并默认绑定 EP0 的 IN/OUT 内部回调。",
          tag: "INIT",
        },
        {
          id: "ci_2",
          stage: "2. Class 接口与 Endpoint 回调注册",
          title: "usbd_cdc_acm_init_intf + usbd_add_endpoint",
          nodeId: "usbd_add_endpoint",
          detail:
            "在 intf->class_interface_handler 上挂载 CDC 请求处理器；在 rx_msg[0x02].cb 和 tx_msg[0x01].cb 上挂载 bulk_out 与 bulk_in 回调。",
          tag: "CALLBACK",
        },
        {
          id: "ci_3",
          stage: "3. 硬件 DCD 启动与底层引脚初始化",
          title: "usbd_initialize ➔ usb_dc_init ➔ usb_dc_low_level_init",
          nodeId: "usb_dc_init",
          detail:
            "广播 USBD_EVENT_INIT 事件后进入 DCD 移植层 usb_dc_init，调用用户重写的 __WEAK usb_dc_low_level_init 开启硬件时钟与中断。",
          tag: "HAL",
        },
      ],
    },
    {
      id: "cherry_usbh_hub_thread",
      name: "usbh_hub_thread",
      displayName: "USB Host 主机栈 Hub 热插拔与设备枚举线程",
      category: "RTOS_TASK",
      entryNodeId: "usbh_hub_thread",
      rtosAllocatedStackBytes: 2048,
      summary:
        "CherryUSB Host 核心 RTOS 线程 (CONFIG_USBHOST_PSC_STACKSIZE=2048B)：通过 OSAL 消息队列监听 Roothub/外部 Hub 端口变化，执行复位、EP0 控制传输枚举、动态堆分配 raw_config_desc 并通过 CLASS_CONNECT 挂载驱动。",
      nodeIds: [
        "usbh_hub_thread",
        "usb_hc_init",
        "usb_osal_mq_recv",
        "usbh_hub_events",
        "usbh_hub_get_portstatus",
        "usbh_hub_set_feature",
        "usbh_roothub_control",
        "usbh_enumerate",
        "usbh_control_transfer",
        "parse_device_descriptor",
        "parse_config_descriptor",
        "usb_osal_malloc",
        "usbh_get_string_desc",
        "usbh_submit_urb",
        "usbh_hub_connect",
        "usbh_msc_connect",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [
        {
          name: "CONFIG_USBHOST_PSC_STACKSIZE",
          defaultVal: "2048",
          file: "cherryusb_config_template.h",
          purpose: "usbh_hub_thread 枚举线程栈大小",
        },
        {
          name: "CONFIG_USBHOST_REQUEST_BUFFER_LEN",
          defaultVal: "512",
          file: "cherryusb_config_template.h",
          purpose: "主机 EP0 描述符请求缓冲长度",
        },
        {
          name: "CONFIG_USBHOST_CONTROL_TRANSFER_TIMEOUT",
          defaultVal: "500",
          file: "cherryusb_config_template.h",
          purpose: "EP0 控制传输超时时间 (ms)",
        },
      ],
      staticFlowOutline: [
        {
          id: "uh_1",
          stage: "1. HCD 主机控制器初始化与消息队列阻塞",
          title: "usbh_hub_thread ➔ usb_hc_init + usb_osal_mq_recv",
          nodeId: "usbh_hub_thread",
          detail:
            "初始化底层 EHCI/DWC2 主机控制器硬件，随后在 bus->hub_mq 上等待端口中断唤醒 (usbh_hub_thread_wakeup)。",
          tag: "INIT",
        },
        {
          id: "uh_2",
          stage: "2. 端口消抖与复位 (Roothub Control)",
          title: "usbh_hub_events ➔ usbh_roothub_control",
          nodeId: "usbh_hub_events",
          detail:
            "检测到设备插入后执行 100ms 消抖，调用 usbh_hub_set_feature 下发 PORT_RESET 并识别高低速设备。",
          tag: "HAL",
        },
        {
          id: "uh_3",
          stage: "3. EP0 标准枚举与动态堆分配 (⚠️ Heap + 128B 局部栈)",
          title: "usbh_enumerate ➔ usb_osal_malloc + string_buffer[128]",
          nodeId: "usbh_enumerate",
          detail:
            "依次发送设置地址、读取设备/配置描述符请求；调用 usb_osal_malloc 动态分配 raw_config_desc，并在栈上分配 uint8_t string_buffer[128] 读取厂商字符串。",
          tag: "WARN",
        },
        {
          id: "uh_4",
          stage: "4. 匹配 Class 驱动表并回调 CLASS_CONNECT",
          title: "usbh_enumerate ➔ class_driver->connect()",
          nodeId: "usbh_msc_connect",
          detail:
            "根据接口 Class/SubClass 查表匹配驱动，通过 CLASS_CONNECT 宏回调具体驱动 (如 usbh_hub_connect / usbh_msc_connect)。",
          tag: "CALLBACK",
        },
      ],
    },
    {
      id: "cherry_usbd_msc_bot",
      name: "mass_storage_bulk_out",
      displayName: "USB Device MSC 大容量存储 BOT 状态机",
      category: "PUBLIC_API",
      entryNodeId: "mass_storage_bulk_out",
      summary:
        "USB 虚拟 U 盘核心协议栈：解析 31 字节 CBW 命令块、执行 SCSI 指令集，并通过 3 个 __WEAK 钩子函数 (usbd_msc_sector_read / write / get_cap) 与底层 Flash/SD 卡存储介质彻底解耦。",
      nodeIds: [
        "mass_storage_bulk_out",
        "SCSI_CBWDecode",
        "SCSI_inquiry",
        "SCSI_readCapacity10",
        "SCSI_read10",
        "SCSI_write10",
        "SCSI_processRead",
        "SCSI_processWrite",
        "usbd_msc_sector_read",
        "usbd_msc_sector_write",
        "usbd_msc_send_csw",
        "usbd_ep_start_write",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [
        {
          name: "CONFIG_USBDEV_MSC_MAX_BUFSIZE",
          defaultVal: "8192",
          file: "cherryusb_config_template.h",
          purpose: "MSC 块读写内部流转缓冲区大小",
        },
        {
          name: "CONFIG_USBDEV_MSC_THREAD",
          defaultVal: "0 (可选)",
          file: "class/msc/usbd_msc.c",
          purpose: "是否将耗时的 Flash/SD 扇区读写放入独立 OSAL 线程",
        },
      ],
      staticFlowOutline: [
        {
          id: "ms_1",
          stage: "1. CBW 命令块解码与 SCSI 状态机",
          title: "mass_storage_bulk_out ➔ SCSI_CBWDecode",
          nodeId: "SCSI_CBWDecode",
          detail:
            "校验 CBW 签名 0x43425355，按 cbw.CB[0] 分发 INQUIRY、READ_CAPACITY10、READ10、WRITE10 等 SCSI 命令。",
          tag: "FSM",
        },
        {
          id: "ms_2",
          stage: "2. 扇区读写 __WEAK 存储介质移植边界",
          title: "SCSI_processRead/Write ➔ usbd_msc_sector_read/write",
          nodeId: "usbd_msc_sector_read",
          detail:
            "通过 __WEAK 弱函数调用底层块设备读写；移植 MSC 时只需在应用层重写 usbd_msc_sector_read/write/get_cap 即可对接 SDIO/SPI Flash。",
          tag: "HAL",
        },
        {
          id: "ms_3",
          stage: "3. CSW 状态回传闭环",
          title: "usbd_msc_send_csw ➔ usbd_ep_start_write",
          nodeId: "usbd_msc_send_csw",
          detail:
            "读写完成后组装 13 字节 CSW 状态包通过 Bulk IN 端点发回主机，重置 stage 为 MSC_READ_CBW。",
          tag: "FSM",
        },
      ],
    },
    {
      id: "cherry_usbh_msc_scsi",
      name: "usbh_msc_connect",
      displayName: "USB Host U盘枚举挂载与 SCSI 扇区读写链路",
      category: "PUBLIC_API",
      entryNodeId: "usbh_msc_connect",
      summary:
        "当 USB Host 识别到 U 盘接入后，由 usbh_msc_connect 分配驱动对象，通过 usbh_msc_scsi_init 走完 BOT (CBW/Data/CSW) 握手并暴露出扇区读写接口 usbh_msc_scsi_read10/write10（每个 SCSI 命令在栈上构建 31B CBW 结构体）。",
      nodeIds: [
        "usbh_msc_connect",
        "usbh_msc_get_maxlun",
        "usbh_control_transfer",
        "usbh_msc_scsi_init",
        "usbh_msc_scsi_testunitready",
        "usbh_msc_scsi_inquiry",
        "usbh_msc_scsi_readcapacity10",
        "usbh_msc_scsi_read10",
        "usbh_msc_scsi_write10",
        "usbh_bulk_cbw_csw_xfer",
        "usbh_msc_bulk_out_transfer",
        "usbh_msc_bulk_in_transfer",
        "usbh_submit_urb",
        "usbh_msc_run",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [],
      staticFlowOutline: [
        {
          id: "hm_1",
          stage: "1. U盘接口连接与最大逻辑单元号 (MaxLUN) 获取",
          title: "usbh_msc_connect ➔ usbh_msc_get_maxlun",
          nodeId: "usbh_msc_connect",
          detail:
            "打开 Bulk IN/OUT 端点管道，发送 Class 控制请求读取 U 盘 LUN 数量并回调 __WEAK usbh_msc_run。",
          tag: "INIT",
        },
        {
          id: "hm_2",
          stage: "2. SCSI 磁盘初始化三步握手",
          title:
            "usbh_msc_scsi_init ➔ TestUnitReady / Inquiry / ReadCapacity10",
          nodeId: "usbh_msc_scsi_init",
          detail:
            "每个 SCSI 命令函数在栈上构造 struct CBW cbw (31B)，统一交给 usbh_bulk_cbw_csw_xfer 执行三阶段传输。",
          tag: "FSM",
        },
        {
          id: "hm_3",
          stage: "3. BOT 批量传输与底层 HCD URB 提交",
          title: "usbh_bulk_cbw_csw_xfer ➔ usbh_submit_urb",
          nodeId: "usbh_bulk_cbw_csw_xfer",
          detail:
            "依次通过 usbh_msc_bulk_out_transfer 发送 CBW，收发扇区数据，最后校验 13B CSW 状态字。",
          tag: "HAL",
        },
      ],
    },
    {
      id: "cherry_usbd_uvc_video",
      name: "video_class_interface_request_handler",
      displayName: "USB Device UVC 摄像头控制协商与分片推流",
      category: "PUBLIC_API",
      entryNodeId: "video_class_interface_request_handler",
      summary:
        "CherryUSB UVC 视频类核心：包含长达 480 行的摄像头参数控制请求状态机 (usbd_video_control_unit_terminal_request_handler)、Probe/Commit 格式帧率协商，以及带 12B Payload Header 的分片推流状态机。",
      nodeIds: [
        "video_class_interface_request_handler",
        "usbd_video_control_request_handler",
        "usbd_video_control_unit_terminal_request_handler",
        "usbd_video_stream_request_handler",
        "usbd_video_open",
        "usbd_video_close",
        "usbd_video_stream_start_write",
        "usbd_video_stream_split_transfer",
        "usbd_ep_start_write",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [],
      staticFlowOutline: [
        {
          id: "uv_1",
          stage: "1. UVC 控制接口与流接口请求分发",
          title:
            "video_class_interface_request_handler ➔ Control / Stream Handler",
          nodeId: "video_class_interface_request_handler",
          detail:
            "区分 VideoControl 单元控制请求与 VideoStreaming Probe/Commit 带宽帧率协商请求，触发 __WEAK usbd_video_open/close。",
          tag: "FSM",
        },
        {
          id: "uv_2",
          stage: "2. 视频帧 12B Payload Header 封装与分片写入",
          title:
            "usbd_video_stream_start_write ➔ usbd_video_stream_split_transfer",
          nodeId: "usbd_video_stream_start_write",
          detail:
            "在栈上构造 struct video_payload_header (12B)，切分大帧数据并通过 usbd_ep_start_write 推流。",
          tag: "HAL",
        },
      ],
    },
    {
      id: "cherry_lsusb_cmd",
      name: "lsusb",
      displayName: "lsusb 命令行工具（含级联 Hub 直接递归）",
      category: "CMD_TABLE",
      entryNodeId: "lsusb",
      summary:
        "CherryUSB 内置的 Shell 诊断命令：遍历 g_bus_head 总线链表打印设备树与描述符；其中 usbh_list_device 在遇到子 Hub 时存在真实的直接递归调用（每层分配 imbuf[64]+ipbuf[64] 栈缓冲）。",
      nodeIds: [
        "lsusb",
        "lsusb_help",
        "usbh_list_device",
        "usbh_print_hubport_info",
        "usbh_get_string_desc",
        "usbh_control_transfer",
        "usbh_submit_urb",
      ].filter((id) => Boolean(nodes[id])),
      edgeIds: [],
      configMacros: [],
      staticFlowOutline: [
        {
          id: "ls_1",
          stage: "1. 命令行参数解析与总线遍历",
          title: "lsusb(argc, argv) ➔ usbh_list_device",
          nodeId: "lsusb",
          detail:
            "解析 -v / -t / -s / -d 选项，遍历 g_bus_head 上的每个 Roothub 调用 usbh_list_device。",
          tag: "INIT",
        },
        {
          id: "ls_2",
          stage: "2. 级联 Hub 递归遍历告警 (🔄 直接递归 + 128B 局部数组)",
          title: "usbh_list_device ⇄ usbh_list_device",
          nodeId: "usbh_list_device",
          detail:
            "函数内声明 uint8_t imbuf[64] 与 ipbuf[64] (+128B)，并在发现下级扩展 Hub (core/usbh_core.c:1056) 时直接递归调用自身！",
          tag: "WARN",
        },
      ],
    },
  ];

  // Populate edgeIds automatically from all matching edges in the graph
  for (const entry of entries) {
    entry.edgeIds = edgesForNodes(entry.nodeIds);
  }

  return {
    projectName: path.basename(rootDir),
    archBits: 32,
    targetMcuHint: `Real Local Repo (${rootDir})`,
    sourceKind: "LOCAL_WORKSPACE",
    runtimeParadigm: "HYBRID_OPTIONAL_OS",
    detectedMspStackBytes: 1024,
    mspStackSource: "裸机主栈基准 (MSP Stack_Size = 0x0400 / 1024B)",
    files,
    nodes,
    edges,
    globals,
    entries,
  };
}

function buildGenericCProjectAnalysis(
  rootDir: string,
  files: Record<string, string>,
  parsedFuncs: Map<string, ParsedFileFunc>,
  weakFuncNames: Set<string>,
  globals: GlobalVarInfo[] = [],
  configMacros: {
    name: string;
    defaultVal: string;
    file: string;
    purpose: string;
  }[] = []
): ProjectAnalysis {
  const nodes: Record<string, FunctionNodeData> = {};
  const edges: CallEdgeData[] = [];

  for (const [name, pf] of parsedFuncs.entries()) {
    const isWeakSym = pf.isWeak || weakFuncNames.has(name);
    const layer = classifyLayerByFileAndName(pf.file, name, isWeakSym);
    const readsGlobals: string[] = [];
    const writesGlobals: string[] = [];
    for (const g of globals) {
      if (pf.body.includes(g.name)) {
        readsGlobals.push(g.name);
        if (
          pf.body.includes(`&${g.name}`) ||
          pf.body.includes(`${g.name}.`)
        ) {
          writesGlobals.push(g.name);
        }
      }
    }

    nodes[name] = {
      id: name,
      name,
      signature: pf.signature,
      file: pf.file,
      lineStart: pf.lineStart,
      lineEnd: pf.lineEnd,
      layer,
      isCallback: layer === "CALLBACK",
      isIsr: name.endsWith("_IRQHandler") || name === "SysTick_Handler",
      hasStateMachine: pf.hasSwitch,
      stackBytes: pf.stackBytes,
      localVars: pf.localVars,
      stackWarnings: pf.stackWarnings.length > 0 ? pf.stackWarnings : undefined,
      readsGlobals,
      writesGlobals,
      callsHeap: pf.callsHeap,
      heapApis: pf.heapApis,
      snippet: pf.snippet,
      brief: synthesizeMeaningfulBrief(pf, layer),
    };
  }

  // Synthesize external HAL/BSP/CMSIS leaf nodes for user calls not defined in .c
  for (const pf of parsedFuncs.values()) {
    if (!pf.isUserSrc) continue;
    for (const call of pf.directCalls) {
      const callee = call.callee;
      if (!nodes[callee] && !TRIVIAL_STD_CALLS.has(callee)) {
        const low = callee.toLowerCase();
        if (
          low.startsWith("hal_") ||
          low.startsWith("__hal_") ||
          low.startsWith("bsp_") ||
          low.startsWith("ll_") ||
          low.startsWith("scb_") ||
          low.startsWith("nvic_")
        ) {
          const extBrief = low.includes("_clk_enable")
            ? `【RCC 硬件时钟宏】使能外设时钟 (${callee})`
            : low.startsWith("scb_enable")
            ? `【Cortex-M 内核 Cache 接口】开启 CPU L1 缓存 (${callee})`
            : low.startsWith("bsp_led_")
            ? `【板级 BSP 接口】控制开发板状态指示灯 (${callee})`
            : low.startsWith("hal_mpu_")
            ? `【Cortex-M MPU 硬件接口】配置内存保护单元 (${callee})`
            : `【底层 HAL/BSP 驱动接口】外部硬件操作函数 ${callee}()`;
          nodes[callee] = {
            id: callee,
            name: callee,
            signature: `void ${callee}(...)`,
            file: "Drivers/CMSIS_or_HAL_Macro",
            lineStart: 1,
            lineEnd: 1,
            layer: "HAL",
            isExternal: true,
            stackBytes: 16,
            localVars: [],
            readsGlobals: [],
            writesGlobals: [],
            snippet: `/* Hardware Macro / External Driver Interface */\n${callee}(...);`,
            brief: extBrief,
          };
        }
      }
    }
  }

  let edgeSeq = 1;
  const edgeKeys = new Set<string>();
  const pushEdge = (e: CallEdgeData) => {
    const k = `${e.source}->${e.target}:${e.kind}`;
    if (!edgeKeys.has(k) && e.source !== e.target) {
      edgeKeys.add(k);
      edges.push(e);
    }
  };

  // Global struct initializer field bindings (.field = func_name) across all files
  const fieldToHandlers = new Map<string, { fn: string; loc: string }[]>();
  for (const [rel, content] of Object.entries(files)) {
    const initRegex = /\.([a-zA-Z_]\w*)\s*=\s*&?\s*([a-zA-Z_]\w*)\s*[,}]/g;
    let m: RegExpExecArray | null;
    while ((m = initRegex.exec(content)) !== null) {
      const fld = m[1];
      const targetFn = m[2];
      if (nodes[targetFn]) {
        const arr = fieldToHandlers.get(fld) ?? [];
        if (!arr.some((x) => x.fn === targetFn)) {
          arr.push({ fn: targetFn, loc: rel });
          fieldToHandlers.set(fld, arr);
        }
      }
    }
  }
  for (const pf of parsedFuncs.values()) {
    for (const fa of pf.fieldAssignments) {
      if (nodes[fa.targetFn]) {
        const arr = fieldToHandlers.get(fa.field) ?? [];
        if (!arr.some((x) => x.fn === fa.targetFn)) {
          arr.push({ fn: fa.targetFn, loc: `${pf.file}:${fa.line}` });
          fieldToHandlers.set(fa.field, arr);
        }
      }
    }
  }

  for (const [name, pf] of parsedFuncs.entries()) {
    for (const call of pf.directCalls) {
      if (nodes[call.callee]) {
        const isWeakTarget =
          weakFuncNames.has(call.callee) ||
          call.callee.endsWith("MspInit") ||
          call.callee.endsWith("MspDeInit") ||
          call.callee.endsWith("Callback") ||
          parsedFuncs.get(call.callee)?.isWeak;
        pushEdge({
          id: `e_gen_${edgeSeq++}`,
          source: name,
          target: call.callee,
          kind: isWeakTarget ? "WEAK_OVERRIDE" : "DIRECT",
          label: isWeakTarget ? "__weak 硬件/事件回调" : undefined,
          callSiteLine: call.line,
        });
      }

      // Check if any argument passed to this call is a known function pointer (callback registration!)
      const argTokens = call.argsText.split(/[^a-zA-Z0-9_]+/);
      for (const tok of argTokens) {
        if (tok && tok !== call.callee && nodes[tok]) {
          pushEdge({
            id: `e_gen_${edgeSeq++}`,
            source: call.callee && nodes[call.callee] ? call.callee : name,
            target: tok,
            kind: "ASYNC_CALLBACK",
            label: `注册回调 (${call.callee})`,
            registeredAt: `${pf.file}:${call.line}`,
            callSiteLine: call.line,
          });
        }
      }
    }

    // Direct field assignment inside function
    for (const fa of pf.fieldAssignments) {
      if (nodes[fa.targetFn]) {
        pushEdge({
          id: `e_gen_${edgeSeq++}`,
          source: name,
          target: fa.targetFn,
          kind: "OPS_TABLE",
          label: `.${fa.field} = ${fa.targetFn}`,
          registeredAt: `${pf.file}:${fa.line}`,
          callSiteLine: fa.line,
        });
      }
    }

    // Indirect struct field calls: e.g. dev->ops->read() paired with .read = bsp_read
    // Scope to same file or matching module prefix first to avoid cross-peripheral false positives
    for (const fc of pf.fieldCalls) {
      const allBound = fieldToHandlers.get(fc.field) ?? [];
      const fnPrefix = name.split("_").slice(0, 2).join("_");
      const sameModule = allBound.filter(
        (h) => h.loc.startsWith(pf.file) || h.fn.startsWith(fnPrefix)
      );
      const chosen = sameModule.length > 0 ? sameModule : allBound;
      for (const h of chosen.slice(0, 3)) {
        pushEdge({
          id: `e_gen_${edgeSeq++}`,
          source: name,
          target: h.fn,
          kind: "OPS_TABLE",
          label: `->${fc.field}()`,
          registeredAt: h.loc,
          callSiteLine: fc.line,
        });
      }
    }
  }

  const adj = new Map<string, string[]>();
  for (const name of Object.keys(nodes)) adj.set(name, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);

  const collectReachable = (rootId: string, maxNodes = 26) => {
    const visited = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length > 0 && visited.size < maxNodes) {
      const curr = queue.shift()!;
      for (const nxt of adj.get(curr) ?? []) {
        if (!visited.has(nxt) && visited.size < maxNodes) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return Array.from(visited);
  };

  const edgesForNodes = (nids: string[]) => {
    const s = new Set(nids);
    return edges
      .filter((e) => s.has(e.source) && s.has(e.target))
      .map((e) => e.id);
  };

  const readmeSummary = extractProjectReadmeSummary(rootDir);
  const entries: FeatureEntry[] = [];

  // 1. Always place `main` first if present, prioritizing business peripheral subtrees!
  const mainPf = parsedFuncs.get("main");
  if (mainPf) {
    const nids: string[] = ["main"];
    const seenM = new Set<string>(["main"]);
    for (const ch of adj.get("main") ?? []) {
      if (!seenM.has(ch)) {
        seenM.add(ch);
        nids.push(ch);
      }
    }
    const priorityQ: string[] = [];
    const secondaryQ: string[] = [];
    for (const ch of nids.slice(1)) {
      if (
        [
          "HAL_Init",
          "SystemClock_Config",
          "MPU_Config",
          "CPU_CACHE_Enable",
          "Error_Handler",
        ].includes(ch)
      ) {
        secondaryQ.push(ch);
      } else {
        priorityQ.push(ch);
      }
    }
    const queue = [...priorityQ, ...secondaryQ];
    while (queue.length > 0 && nids.length < 30) {
      const curr = queue.shift()!;
      for (const nxt of adj.get(curr) ?? []) {
        if (!seenM.has(nxt) && nids.length < 30) {
          seenM.add(nxt);
          nids.push(nxt);
          queue.push(nxt);
        }
      }
    }

    const eids = edgesForNodes(nids);
    const activePhases = mainPf.inlinePhases.filter(
      (p) => p.calls.length > 0 || p.configs.length > 0
    );

    const outlineSteps: FlowStep[] =
      activePhases.length > 0
        ? activePhases.map((phase, pIdx) => {
            const focusNode =
              phase.calls.find((c) => Boolean(nodes[c])) || "main";
            const callsStr =
              phase.calls.length > 0
                ? phase.calls.join(" ➔ ")
                : "配置外设参数与状态";
            const cfgStr =
              phase.configs.length > 0
                ? ` [参数: ${phase.configs.join(", ")}]`
                : "";
            return {
              id: `main_phase_${pIdx}`,
              stage: `阶段 ${pIdx + 1}: ${phase.title}`,
              title: callsStr,
              nodeId: focusNode,
              detail: `执行 ${phase.calls.join(" / ") || "初始化"}${cfgStr}`,
              tag: pIdx === 0 ? "INIT" : "FSM",
            };
          })
        : nids.slice(0, 6).map((nid, sIdx) => ({
            id: `main_s_${sIdx}`,
            stage: `步骤 ${sIdx + 1}`,
            title: `${nid}()`,
            nodeId: nid,
            detail: nodes[nid]?.brief || "",
            tag: "FSM",
          }));

    entries.push({
      id: "entry_main_full",
      name: "main",
      displayName: "main() — 工程主业务流程与硬件驱动全链路",
      category: "MAIN_LOOP",
      entryNodeId: "main",
      summary:
        readmeSummary ||
        nodes["main"]?.brief ||
        "主程序完整初始化与业务执行链路",
      nodeIds: nids,
      edgeIds: eids,
      configMacros,
      staticFlowOutline: outlineSteps,
    });

    // 2. Also create focused sub-entries for each major business API called inside main()
    for (const call of mainPf.directCalls) {
      const callee = call.callee;
      if (
        ["Error_Handler", "HAL_Init", "MPU_Config", "CPU_CACHE_Enable"].includes(
          callee
        ) ||
        TRIVIAL_STD_CALLS.has(callee)
      ) {
        continue;
      }
      if (nodes[callee]) {
        const subNids = collectReachable(callee, 18);
        if (subNids.length >= 2) {
          entries.push({
            id: `entry_sub_${callee}`,
            name: callee,
            displayName: `${callee}() 子系统深层实现链路`,
            category:
              callee.includes("Clock") || callee.includes("Init")
                ? "MAIN_LOOP"
                : "PUBLIC_API",
            entryNodeId: callee,
            summary: nodes[callee]?.brief || "",
            nodeIds: subNids,
            edgeIds: edgesForNodes(subNids),
            configMacros,
            staticFlowOutline: subNids.slice(0, 5).map((nid, sIdx) => ({
              id: `sub_${callee}_${sIdx}`,
              stage: `调用层级 ${sIdx + 1}`,
              title: `${nid}()`,
              nodeId: nid,
              detail: nodes[nid]?.brief || "",
              tag: nodes[nid]?.layer === "HAL" ? "HAL" : "FSM",
            })),
          });
        }
      }
    }
  }

  // 3. Add non-empty ISR / MSP Callback entries
  for (const [name, pf] of parsedFuncs.entries()) {
    if (!pf.isUserSrc || name === "main") continue;
    if (
      (name.endsWith("MspInit") ||
        name.endsWith("_IRQHandler") ||
        name === "SysTick_Handler") &&
      pf.directCalls.length > 0
    ) {
      const nids = collectReachable(name, 14);
      entries.push({
        id: `entry_isr_${name}`,
        name,
        displayName: `${name}() 硬件回调/中断入口`,
        category: "ISR",
        entryNodeId: name,
        summary: nodes[name]?.brief || "",
        nodeIds: nids,
        edgeIds: edgesForNodes(nids),
        configMacros,
        staticFlowOutline: [
          {
            id: `isr_step_${name}`,
            stage: "中断/MSP 回调触发",
            title: `${name}()`,
            nodeId: name,
            detail: nodes[name]?.brief || "",
            tag: "CALLBACK",
          },
        ],
      });
    }
  }

  // 4. Fallback if no main()
  if (entries.length === 0) {
    const candidates = Object.values(nodes)
      .map((n) => ({ node: n, reach: collectReachable(n.id, 24) }))
      .filter((c) => c.reach.length >= 2)
      .sort((a, b) => b.reach.length - a.reach.length)
      .slice(0, 8);
    candidates.forEach((c, idx) => {
      entries.push({
        id: `gen_entry_${idx}`,
        name: c.node.name,
        displayName: `${c.node.name}() 调用链`,
        category: "PUBLIC_API",
        entryNodeId: c.node.id,
        summary: c.node.brief,
        nodeIds: c.reach,
        edgeIds: edgesForNodes(c.reach),
        configMacros,
        staticFlowOutline: c.reach.slice(0, 5).map((nid, sIdx) => ({
          id: `step_${idx}_${sIdx}`,
          stage: `步骤 ${sIdx + 1}`,
          title: `${nid}()`,
          nodeId: nid,
          detail: nodes[nid]?.brief || "",
          tag: "FSM",
        })),
      });
    });
  }

  const hasRtosCalls = Object.values(nodes).some((n) =>
    /^(xTask|vTask|osThread|rt_thread|usb_osal_thread)/i.test(n.name)
  );

  return {
    projectName: path.basename(rootDir),
    archBits: 32,
    targetMcuHint: `Local C/C++ Repo (${rootDir})`,
    sourceKind: "LOCAL_WORKSPACE",
    runtimeParadigm: hasRtosCalls ? "RTOS" : "BARE_METAL",
    detectedMspStackBytes: 1024,
    mspStackSource: "裸机启动主栈 (MSP Stack_Size = 1024B)",
    files,
    nodes,
    edges,
    globals,
    entries,
  };
}
