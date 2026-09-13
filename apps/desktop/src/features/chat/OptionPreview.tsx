import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ExtensionUiOption } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";

/** Rows shown before the preview collapses behind an expand control. */
const COLLAPSED_ROWS = 10;

/**
 * One option's rich preview, rendered as literal monospace text.
 *
 * Deliberately NOT markdown: previews are ASCII layouts and mockups whose value
 * is exact column alignment. A markdown renderer would reflow them (collapsing
 * the leading whitespace and box-drawing alignment that makes them legible).
 * A fenced ``` block authored by the model is unwrapped so its inner text
 * reaches the same monospace surface without the fence characters.
 */
function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1]! : text.replace(/\s+$/, "");
}

export function OptionPreview({
  option,
  fallbackLabel,
}: {
  option: ExtensionUiOption;
  fallbackLabel: string;
}) {
  const t = useT();
  const preview = option.preview ?? null;
  const [expanded, setExpanded] = useState(false);
  const text = useMemo(() => (preview ? unwrapFence(preview) : ""), [preview]);
  const lineCount = useMemo(() => (text ? text.split("\n").length : 0), [text]);
  const truncated = lineCount > COLLAPSED_ROWS;
  const body = expanded || !truncated ? text : text.split("\n").slice(0, COLLAPSED_ROWS).join("\n");

  return (
    <figure className="min-w-0" data-extension-option-preview={option.id}>
      <figcaption className="mb-1 truncate text-[10px] font-medium text-muted">
        {option.label || fallbackLabel}
      </figcaption>
      {preview ? (
        <div className="min-w-0 overflow-hidden rounded-md border border-border bg-surface">
          <pre className="max-h-72 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground/90">
            <code>{body}</code>
          </pre>
          {truncated ? (
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1 border-t border-border py-1 text-[10px] text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <span>
                {expanded
                  ? t("extUiPreviewCollapse")
                  : t("extUiPreviewExpand", { count: lineCount - COLLAPSED_ROWS })}
              </span>
            </button>
          ) : null}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] text-muted">
          {t("extUiPreviewEmpty")}
        </p>
      )}
    </figure>
  );
}

/** True when at least one option carries preview content. */
export function hasOptionPreviews(options: readonly ExtensionUiOption[]): boolean {
  return options.some((option) => Boolean(option.preview));
}
