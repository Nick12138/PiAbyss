/**
 * 备忘录正文的 Markdown 渲染：查看态即渲染态。
 *
 * 三处吃同一份——Agent 完成总结弹窗、随行面板行内展开的正文、
 * 编辑弹窗的「预览」态。渲染器（Streamdown + shiki/mermaid）体积可观，仍旧按需加载，
 * 增强失败时由组件内部的渲染边界回退成纯文本。
 *
 * 字号走 `memo-markdown`（13px，见 styles/index.css）；随行面板那种窄栏再加一档
 * `panel-markdown`（11px）。只负责渲染，外层容器与滚动交给调用方。
 */
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

const Markdown = lazy(() =>
  import("../chat/MarkdownMessage").then((m) => ({ default: m.MarkdownMessage })),
);

/** Markdown 渲染器加载中的占位（高度贴紧，避免内容跳动）。 */
function MarkdownPending() {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted" role="status">
      <Loader2 size={14} className="animate-spin" aria-hidden />
    </div>
  );
}

export function MemoMarkdown({
  content,
  className = "",
}: {
  content: string;
  /** 追加的排版档位（如 `panel-markdown`）。 */
  className?: string;
}) {
  return (
    <Suspense fallback={<MarkdownPending />}>
      <Markdown content={content} className={`memo-markdown${className ? ` ${className}` : ""}`} />
    </Suspense>
  );
}
