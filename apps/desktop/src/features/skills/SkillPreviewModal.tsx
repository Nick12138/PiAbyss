import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { readDesktopSmallFile } from "../../lib/desktop-file-access";
import { useT } from "../../lib/i18n/use-t";

const MARKDOWN_PATTERN = /\.(?:md|markdown|mdx)$/i;

type SkillContent =
  { kind: "text"; text: string } | { kind: "image"; data: string; mediaType: string };

type PreviewStatus = "loading" | "ready" | "error";

/**
 * Modal preview of a skill card's SKILL.md (or standalone .md) file.
 * Reads through the desktop `desktop_read_small_file` command so bundled and
 * user-scope skill paths outside the workspace still resolve.
 */
export function SkillPreviewModal({
  name,
  filePath,
  onClose,
}: {
  name: string;
  filePath: string;
  onClose: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [content, setContent] = useState<SkillContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const id = ++generation.current;
    setStatus("loading");
    setContent(null);
    setError(null);
    void readDesktopSmallFile(filePath)
      .then((file) => {
        if (id !== generation.current) return;
        setContent(
          file.kind === "text"
            ? { kind: "text", text: file.text }
            : { kind: "image", data: file.data, mediaType: file.mediaType },
        );
        setStatus("ready");
      })
      .catch((readError) => {
        if (id !== generation.current) return;
        const message =
          readError instanceof Error
            ? readError.message
            : typeof readError === "string"
              ? readError
              : "";
        setError(message || t("skillsPreviewLoadFailed"));
        setStatus("error");
      });
  }, [filePath, t]);

  // No Escape handler here: the app-level Escape shortcut owns that key.
  // Close via the ✕ button or by clicking the backdrop.

  const isMarkdown = MARKDOWN_PATTERN.test(filePath);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-preview-title"
        className="theme-floating-surface flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 id="skill-preview-title" className="break-all text-base font-semibold">
              {name}
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={filePath}>
              {filePath}
            </p>
          </div>
          <button
            type="button"
            title={t("commonClose")}
            aria-label={t("commonClose")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        {status === "loading" && (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-16 text-muted">
            <LoaderCircle size={16} className="animate-spin" />
            <span className="text-sm">{t("skillsPreviewLoading")}</span>
          </div>
        )}

        {status === "error" && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
            <AlertTriangle size={22} className="text-muted" />
            <p className="max-w-full break-words text-xs text-muted">{error}</p>
          </div>
        )}

        {status === "ready" && content?.kind === "text" && isMarkdown && (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="preview-markdown chat-markdown skill-preview-markdown px-5 py-4 text-sm">
              <Streamdown
                mode="static"
                controls={{
                  code: { copy: true, download: false },
                  table: { copy: true, download: false, fullscreen: false },
                  mermaid: { copy: true, download: false, fullscreen: false, panZoom: false },
                }}
              >
                {content.text}
              </Streamdown>
            </div>
          </div>
        )}
        {status === "ready" && content?.kind === "text" && !isMarkdown && (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed text-foreground/90">
            {content.text}
          </pre>
        )}
        {status === "ready" && content?.kind === "image" && (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
            <img
              alt={name}
              src={`data:${content.mediaType};base64,${content.data}`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
      </div>
    </div>
  );
}
