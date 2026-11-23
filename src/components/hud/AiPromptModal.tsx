import React, { useState } from "react";
import { Check, Copy, Sparkles, X } from "lucide-react";

interface AiPromptModalProps {
  open: boolean;
  promptText: string;
  onClose: () => void;
}

export const AiPromptModal: React.FC<AiPromptModalProps> = ({
  open,
  promptText,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[82vh] flex flex-col rounded-2xl border border-white/15 bg-slate-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-900/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-cyan-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                免 API Key · AI 深度思路与移植指南 Prompt
              </h2>
              <p className="text-[11px] text-slate-400">
                已自动打包调用链、隐式回调、WCS 栈预算、需替换 HAL 接口与核心代码切片
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 bg-[#060911]">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-200">
            {promptText}
          </pre>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 bg-slate-900/70 px-5 py-3">
          <span className="text-[11px] text-slate-400">
            复制后直接粘贴到免费网页版 DeepSeek / Kimi / ChatGPT / Claude 即可
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 transition-colors"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> 已复制到剪贴板！
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> 一键复制全部 Prompt
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
