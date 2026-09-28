import { lazy, Suspense, useState } from "react";
import { Check, File, FolderOpen, LoaderCircle } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { openFileWithDefaultApp } from "../../lib/desktop-file-access";
import { workspaceAbsolutePath } from "./FilesPanel";
import {
  fileIsDirty,
  reloadConflict,
  saveOpenFile,
  useFileSession,
  type FileSession,
} from "./file-session";
import "./file-preview.css";

const CodeEditor = lazy(() =>
  import("./FileCodeEditor").then((m) => ({ default: m.FileCodeEditor })),
);
const ConflictDiff = lazy(() =>
  import("./FileCodeEditor").then((m) => ({ default: m.FileConflictDiff })),
);
const ImagePreview = lazy(() =>
  import("./FileMediaPreview").then((m) => ({ default: m.ImageFilePreview })),
);
const PdfPreview = lazy(() =>
  import("./FileMediaPreview").then((m) => ({ default: m.PdfFilePreview })),
);
const Markdown = lazy(() =>
  import("../chat/MarkdownMessage").then((m) => ({ default: m.MarkdownMessage })),
);

/**
 * The preview half of a dock file page — either the Files tree tab or a
 * single-file tab. It owns nothing but the rendering mode (markdown
 * live/source/preview, conflict compare) and reads its content from the
 * session it is handed, so any number of instances can run side by side.
 */
export function FilePreviewSurface({
  sessionKey,
  session,
  disconnected,
}: {
  sessionKey: string;
  session: FileSession;
  disconnected: boolean;
}) {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);
  const { file, path, text, loading, saving, error, conflict } = session;
  const [markdownMode, setMarkdownMode] = useState<"live" | "source" | "preview">("live");
  const [compare, setCompare] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"reload" | "overwrite" | "mixed" | null>(null);
  const dirty = fileIsDirty(session);
  const markdown = /\.(md|mdx|markdown)$/i.test(path ?? "");
  const editorReadOnly =
    disconnected || (file?.kind === "text" && file.mixedLineEndings && !session.mixedConfirmed);

  const systemOpen = async () => {
    if (!session.root || !path) return;
    const failure = await openFileWithDefaultApp(workspaceAbsolutePath(session.root, path));
    if (failure) pushNotification(t("fileDefaultOpenFailed"), "warning");
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-file-preview>
      {disconnected && path && (
        <p role="status" className="border-b border-border p-2 text-xs text-warning">
          {t("fileDisconnected")}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words border-b border-border p-2 text-xs text-danger">
          {error}
        </p>
      )}
      {conflict && (
        <div className="border-b border-border p-2 text-xs">
          <p className="text-warning">{t("fileConflict")}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <button
              className="rounded border border-border px-2 py-1"
              onClick={() => setCompare(!compare)}
            >
              {t(compare ? "fileSource" : "fileCompare")}
            </button>
            <button
              className="rounded border border-border px-2 py-1"
              onClick={() => setConfirmAction("reload")}
            >
              {t("fileReloadDisk")}
            </button>
            <button
              className="rounded border border-border px-2 py-1"
              disabled={saving}
              onClick={() => setConfirmAction("overwrite")}
            >
              {t("fileOverwrite")}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted">
          <LoaderCircle size={16} className="animate-spin" />
          {t("fileLoading")}
        </div>
      ) : !file ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
          <File size={32} />
          <span className="text-sm">{t("fileOpen")}</span>
        </div>
      ) : (
        <Suspense fallback={<div className="p-3 text-xs text-muted">{t("fileLoading")}</div>}>
          {file.kind === "text" && (
            <>
              <div className="file-tools flex-wrap">
                {markdown && (
                  <div
                    className="flex rounded border border-border text-xs"
                    role="group"
                    aria-label={t("fileView")}
                  >
                    {(["live", "source", "preview"] as const).map((mode) => (
                      <button
                        key={mode}
                        aria-pressed={markdownMode === mode}
                        className={`px-2 py-1 ${markdownMode === mode ? "bg-surface-overlay" : ""}`}
                        onClick={() => setMarkdownMode(mode)}
                      >
                        {t(
                          mode === "live"
                            ? "fileLivePreview"
                            : mode === "source"
                              ? "fileSource"
                              : "filePreview",
                        )}
                      </button>
                    ))}
                  </div>
                )}
                <span className="min-w-0 flex-1 text-[11px] text-muted">
                  UTF-8{file.bom ? " BOM" : ""} · {file.lineEnding.toUpperCase()}
                </span>
                {!dirty && <Check size={12} className="text-muted" />}
              </div>
              {file.mixedLineEndings && !session.mixedConfirmed && (
                <div className="border-b border-border p-2 text-xs text-warning">
                  {t("fileMixedLineEndings", { ending: file.lineEnding.toUpperCase() })}{" "}
                  <button
                    className="rounded border border-border px-2 py-1 text-foreground"
                    onClick={() => setConfirmAction("mixed")}
                  >
                    {t("fileEnableEditing")}
                  </button>
                </div>
              )}
              {compare && conflict && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex justify-around p-2 text-xs text-muted">
                    <span>{t("fileDiskVersion")}</span>
                    <span>{t("fileLocalVersion")}</span>
                  </div>
                  <ConflictDiff disk={conflict.text} local={text} />
                </div>
              )}
              <div
                className={`${(compare && conflict) || (markdown && markdownMode === "preview") ? "hidden" : "block"} min-h-0 flex-1`}
              >
                <CodeEditor
                  key={`${session.root}:${path}:${session.revision}`}
                  sessionKey={sessionKey}
                  path={path!}
                  text={text}
                  readOnly={editorReadOnly}
                  livePreview={markdown && markdownMode === "live"}
                />
              </div>
              {markdown && markdownMode === "preview" && !(compare && conflict) && (
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  <Markdown content={text} />
                </div>
              )}
            </>
          )}
          {file.kind === "image" && (
            <ImagePreview
              key={session.revision}
              data={file.data}
              mediaType={file.mediaType}
              name={file.path}
            />
          )}
          {file.kind === "pdf" && <PdfPreview key={session.revision} data={file.data} />}
          {file.kind === "unsupported" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
              <span>{t(file.reason === "tooLarge" ? "fileTooLarge" : "fileUnsupported")}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-foreground hover:bg-surface-overlay"
                onClick={() => void systemOpen()}
              >
                <FolderOpen size={13} />
                {t("fileOpenWithSystem")}
              </button>
            </div>
          )}
        </Suspense>
      )}
      {confirmAction && (
        <Dialog
          title={t(
            confirmAction === "mixed"
              ? "fileEnableEditing"
              : confirmAction === "reload"
                ? "fileReloadDisk"
                : "fileOverwrite",
          )}
          confirmLabel={t("fileConfirm")}
          tone="warning"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            if (confirmAction === "mixed")
              useFileSession.setState({ mixedConfirmed: true }, sessionKey);
            if (confirmAction === "reload") {
              reloadConflict(sessionKey);
              setCompare(false);
            }
            if (confirmAction === "overwrite" && conflict) {
              void saveOpenFile(conflict.version, sessionKey);
              setCompare(false);
            }
            setConfirmAction(null);
          }}
        >
          <p>
            {t(
              confirmAction === "mixed"
                ? "fileNormalizeConfirm"
                : confirmAction === "reload"
                  ? "fileReloadConfirm"
                  : "fileOverwriteConfirm",
            )}
          </p>
        </Dialog>
      )}
    </div>
  );
}
