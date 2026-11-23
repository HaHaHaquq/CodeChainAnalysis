import React, { useState } from "react";
import {
  Check,
  Copy,
  Cpu,
  Download,
  FileCode2,
  FolderOutput,
  Loader2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useChainStore, isTauriDesktop } from "../../store/useChainStore";

interface PortingCodeModalProps {
  open: boolean;
  featureName: string;
  fileName: string;
  adapterCode: string;
  filesToCopy: string[];
  portingGuideMd: string;
  onClose: () => void;
}

const SAMPLE_SU_CONTENT = `core/usbd_core.c:986:6:usbd_event_reset_handler\t56\tstatic
core/usbd_core.c:1016:13:__usbd_event_ep0_setup_complete_handler\t72\tstatic
core/usbh_core.c:313:5:usbh_enumerate\t248\tstatic
port/fsdev/usb_dc_fsdev.c:328:6:USBD_IRQHandler\t88\tstatic`;

export const PortingCodeModal: React.FC<PortingCodeModalProps> = ({
  open,
  featureName,
  fileName,
  adapterCode,
  filesToCopy,
  portingGuideMd,
  onClose,
}) => {
  const [tab, setTab] = useState<"ADAPTER" | "EXPORT_PKG" | "SU_CALIB">(
    "ADAPTER"
  );
  const [copied, setCopied] = useState(false);
  const [suInput, setSuInput] = useState(SAMPLE_SU_CONTENT);
  const [calibMsg, setCalibMsg] = useState<string | null>(null);

  const currentRepoPath = useChainStore((s) => s.currentRepoPath);
  const project = useChainStore((s) => s.project);
  const applySuStackCalibration = useChainStore(
    (s) => s.applySuStackCalibration
  );

  const [targetDir, setTargetDir] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{
    outputDir: string;
    copiedCount: number;
    copiedFiles: string[];
  } | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(adapterCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    const blob = new Blob([adapterCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleApplySu = () => {
    const count = applySuStackCalibration(suInput);
    setCalibMsg(
      `✓ 已成功校准 ${count} 个函数的真实编译器栈帧大小，WCS 已同步重算！`
    );
  };

  const handleExportPackage = async () => {
    setExporting(true);
    setExportErr(null);
    setExportResult(null);
    const payload = {
      repoPath: currentRepoPath,
      targetDir: targetDir.trim() || undefined,
      featureName,
      filesToCopy,
      adapterFileName: fileName,
      adapterCode,
      portingGuideMd,
      projectFiles: project.files,
    };
    try {
      if (isTauriDesktop()) {
        const res = await invoke<{
          outputDir: string;
          copiedCount: number;
          copiedFiles: string[];
        }>("export_porting_package", { payload });
        setExportResult(res);
      } else {
        const resp = await fetch("/api/export-porting", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || "导出失败");
        }
        setExportResult({
          outputDir: data.outputDir,
          copiedCount: data.copiedCount,
          copiedFiles: data.copiedFiles,
        });
      }
    } catch (err: unknown) {
      setExportErr(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[84vh] flex flex-col rounded-2xl border border-white/15 bg-slate-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/75 px-5 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTab("ADAPTER")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                tab === "ADAPTER"
                  ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              1. 移植适配层 C 骨架
            </button>
            <button
              type="button"
              onClick={() => setTab("EXPORT_PKG")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                tab === "EXPORT_PKG"
                  ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <FolderOutput className="h-3.5 w-3.5" />
              2. 一键提取独立移植源码包
            </button>
            <button
              type="button"
              onClick={() => setTab("SU_CALIB")}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                tab === "SU_CALIB"
                  ? "bg-orange-500/20 text-orange-200 border border-orange-500/40"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Cpu className="h-3.5 w-3.5" />
              3. 导入 GCC .su 栈校准
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {tab === "ADAPTER" && (
          <>
            <div className="flex-1 overflow-y-auto p-4 bg-[#060911]">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-emerald-100/90">
                {adapterCode}
              </pre>
            </div>
            <div className="flex items-center justify-between border-t border-white/10 bg-slate-900/75 px-5 py-3">
              <span className="text-[11px] text-slate-400">
                将核心必拷文件与本适配层文件一起加入新 MCU 工程，填好 TODO 即可完成移植
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTab("EXPORT_PKG")}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-500/20 px-3.5 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-500/30"
                >
                  <FolderOutput className="h-3.5 w-3.5" /> 一键抠出完整移植包
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
                >
                  <Download className="h-3.5 w-3.5" /> 下载 .c
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" /> 已复制
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" /> 复制代码
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        )}

        {tab === "EXPORT_PKG" && (
          <div className="p-5 space-y-4 overflow-y-auto">
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3.5 text-xs text-slate-200 leading-relaxed">
              <div className="font-bold text-cyan-300 mb-1">
                📦 自动剥离无关代码，生成纯净版【{featureName}】独立移植文件夹
              </div>
              系统将自动从原仓库抠出该功能闭包所需的{" "}
              <span className="font-mono font-bold text-white">
                {filesToCopy.length} 个核心 .c/.h 文件
              </span>{" "}
              及公共头文件，连同生成的{" "}
              <code className="text-emerald-300">{fileName}</code> 适配层骨架与{" "}
              <code className="text-amber-300">PORTING_CHECKLIST.md</code>{" "}
              一并导出到目标文件夹，可直接拉进你的 Keil / IAR / CMake 新项目！
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                导出目标文件夹路径（留空则默认导出到本工程{" "}
                <code>exported_ports/port_{featureName}</code>）：
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder={`默认: d:\\13_JBYWorkSpace\\ChainAnalysis\\exported_ports\\port_${featureName}`}
                  className="flex-1 rounded-xl border border-white/15 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={exporting}
                  onClick={handleExportPackage}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50"
                >
                  {exporting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在导出...
                    </>
                  ) : (
                    <>
                      <FolderOutput className="h-3.5 w-3.5" /> 立即导出到磁盘
                    </>
                  )}
                </button>
              </div>
            </div>

            {exportErr && (
              <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300">
                ❌ {exportErr}
              </div>
            )}

            {exportResult && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/25 p-3.5 space-y-2">
                <div className="text-xs font-bold text-emerald-300">
                  ✓ 已成功导出 {exportResult.copiedCount} 个文件至：
                </div>
                <div className="rounded-lg bg-slate-950 p-2 font-mono text-xs text-cyan-300 select-all">
                  {exportResult.outputDir}
                </div>
                <div className="max-h-40 overflow-y-auto flex flex-wrap gap-1.5 pt-1">
                  {exportResult.copiedFiles.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-slate-900/90 px-2 py-0.5 font-mono text-[10px] text-slate-300 border border-white/5"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "SU_CALIB" && (
          <div className="p-5 space-y-4">
            <div className="rounded-xl border border-orange-500/30 bg-orange-950/20 p-3 text-xs text-slate-300 leading-relaxed">
              当你的工程使用{" "}
              <code className="text-orange-300">
                arm-none-eabi-gcc -fstack-usage
              </code>{" "}
              编译时，会生成 <code className="text-orange-300">.su</code>{" "}
              文件。将内容粘贴到下方，即可用**编译器汇编级真实栈帧大小**覆盖静态 AST 估算值：
            </div>
            <textarea
              rows={8}
              value={suInput}
              onChange={(e) => setSuInput(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-[#060911] p-3 font-mono text-xs text-slate-100 focus:border-orange-400 focus:outline-none"
              placeholder="粘贴 .su 文件内容，格式：file.c:line:col:func_name  bytes  static"
            />
            {calibMsg && (
              <div className="text-xs font-semibold text-emerald-400">
                {calibMsg}
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleApplySu}
                className="rounded-xl bg-orange-600 px-4 py-2 text-xs font-bold text-white hover:bg-orange-500"
              >
                应用 .su 栈帧校准并重算 WCS
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
