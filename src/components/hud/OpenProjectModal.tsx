import React, { useState } from "react";
import { FolderOpen, HardDrive, Loader2, Sparkles, X } from "lucide-react";
import { open as tauriDialogOpen } from "@tauri-apps/plugin-dialog";
import { useChainStore, isTauriDesktop } from "../../store/useChainStore";

export const OpenProjectModal: React.FC = () => {
  const open = useChainStore((s) => s.openProjectModalOpen);
  const setOpen = useChainStore((s) => s.setOpenProjectModalOpen);
  const currentRepoPath = useChainStore((s) => s.currentRepoPath);
  const isLoading = useChainStore((s) => s.isLoadingProject);
  const analysisProgress = useChainStore((s) => s.analysisProgress);
  const loadError = useChainStore((s) => s.loadError);
  const loadLocalProject = useChainStore((s) => s.loadLocalProject);
  const loadBuiltinDemo = useChainStore((s) => s.loadBuiltinDemo);

  const [inputPath, setInputPath] = useState(
    currentRepoPath.startsWith("内置")
      ? "D:\\3-code\\USB\\CherryUSB-1.6.1"
      : currentRepoPath
  );
  const [pickingFolder, setPickingFolder] = useState(false);

  if (!open) return null;

  const handleNativeBrowse = async () => {
    setPickingFolder(true);
    try {
      if (isTauriDesktop()) {
        const selected = await tauriDialogOpen({
          directory: true,
          multiple: false,
          title: "选择嵌入式 C/C++ 工程根目录",
        });
        if (typeof selected === "string" && selected.trim()) {
          setInputPath(selected);
          loadLocalProject(selected);
        }
        return;
      }
      const resp = await fetch("/api/pick-folder");
      const data = await resp.json();
      if (data.ok && data.path) {
        setInputPath(data.path);
        loadLocalProject(data.path);
      }
    } catch {
      // ignore
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-white/15 bg-slate-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/75 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">
              加载本地嵌入式 C/C++ 工程或切换示例
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              本地 C/C++ 仓库目录路径：
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                placeholder="例如 D:\3-code\USB\CherryUSB-1.6.1"
                className="flex-1 rounded-xl border border-white/15 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={pickingFolder || isLoading}
                onClick={handleNativeBrowse}
                className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                title="弹出 Windows 原生文件夹选择框"
              >
                <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                {pickingFolder ? "选择中..." : "浏览..."}
              </button>
              <button
                type="button"
                disabled={isLoading || !inputPath.trim()}
                onClick={() => loadLocalProject(inputPath.trim())}
                className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 解析中...
                  </>
                ) : (
                  "静态解析"
                )}
              </button>
            </div>
            {isLoading && (
              <div className="mt-3 rounded-xl border border-cyan-500/35 bg-slate-900/90 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-cyan-200 flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                    {analysisProgress.stage || "正在执行静态 AST 解析..."}
                  </span>
                  <span className="font-mono font-bold text-cyan-300">
                    {analysisProgress.percent}%
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-emerald-400 transition-all duration-150"
                    style={{
                      width: `${Math.max(6, Math.min(100, analysisProgress.percent))}%`,
                    }}
                  />
                </div>
                {analysisProgress.detail && (
                  <div className="truncate font-mono text-[10px] text-slate-400">
                    📄 {analysisProgress.detail}
                  </div>
                )}
              </div>
            )}

            {loadError && (
              <p className="mt-2 text-xs text-red-400">❌ {loadError}</p>
            )}
          </div>

          <div className="border-t border-white/10 pt-3">
            <div className="text-[11px] font-semibold text-slate-400 mb-2">
              快速一键切换：
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setInputPath("D:\\3-code\\USB\\CherryUSB-1.6.1");
                  loadLocalProject("D:\\3-code\\USB\\CherryUSB-1.6.1");
                }}
                className="flex items-start gap-2.5 rounded-xl border border-cyan-500/35 bg-cyan-500/10 p-3 text-left hover:bg-cyan-500/20 transition-colors"
              >
                <HardDrive className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-cyan-200">
                    CherryUSB-1.6.1 (真实本地库)
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                    D:\3-code\USB\CherryUSB-1.6.1
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={loadBuiltinDemo}
                className="flex items-start gap-2.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3 text-left hover:bg-indigo-500/20 transition-colors"
              >
                <Sparkles className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-indigo-200">
                    STM32F4 Ymodem + FOC (内置)
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    含 1328B 大数组爆栈与 AT 递归演示
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
