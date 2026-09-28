import { useEffect, useRef } from "react";
import { AtSign, Copy, FolderOpen, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { FilePreviewSurface } from "./FilePreviewSurface";
import { FileToolButton } from "./FileToolButton";
import { workspaceAbsolutePath } from "./FilesPanel";
import {
  fileIsDirty,
  openWorkspaceFile,
  refreshOpenFile,
  saveOpenFile,
  useFileSession,
} from "./file-session";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { requestComposerInsert } from "../../lib/composer-insert";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { workspaceContext } from "../../lib/bridge/host-context";
import "./file-preview.css";

/**
 * A dock page that shows exactly one workspace file. It reuses the Files
 * tab's preview surface and session semantics, but owns its own session key
 * so several files can stay open at once.
 */
export function FileTabPanel({ sessionKey, path }: { sessionKey: string; path: string }) {
  const t = useT();
  const session = useFileSession(sessionKey);
  const workspace = useAppStore((s) => s.workspace);
  const host = useAppStore((s) => s.host);
  const connecting = useAppStore((s) => s.connecting || s.rehydrating);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const { loading, saving } = session;
  const dirty = fileIsDirty(session);
  const disconnected = !host || !workspace || connecting || workspace.canonicalCwd !== session.root;
  const name = path.split("/").pop() ?? path;
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void openWorkspaceFile(path, sessionKey);
  }, [path, sessionKey]);

  useEffect(() => {
    if (!host || !workspace || connecting) return;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = subscribeValidatedHostEvent(
      "workspace.filesChanged",
      workspaceContext(host, workspace),
      (event) => {
        if (!event.payload.directories.includes(parentPath)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refreshOpenFile(sessionKey), 200);
      },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [host, workspace, connecting, parentPath, sessionKey]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      pushNotification(t("dockFilesPathCopied"), "info");
    } catch {
      pushNotification(t("dockFilesCopyFailed"), "warning");
    }
  };

  const reveal = async () => {
    if (!session.root) return;
    try {
      await invoke("desktop_open_path", { path: workspaceAbsolutePath(session.root, path) });
    } catch {
      pushNotification(t("dockFilesRevealFailed"), "warning");
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" data-file-tab>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 border-b border-border px-2 py-1">
        <div className="min-w-0 flex-1 basis-24 py-1" title={path}>
          <div className="truncate text-xs font-medium">
            {name}
            {dirty ? " *" : ""}
          </div>
          {parentPath && <div className="truncate text-[11px] text-muted">{parentPath}/</div>}
        </div>
        <div className="flex shrink-0 items-center">
          {session.file?.kind === "text" && (
            <FileToolButton
              label={saving ? t("fileSaving") : t("fileSave")}
              disabled={!dirty || saving || disconnected}
              onClick={() => void saveOpenFile(undefined, sessionKey)}
            >
              {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
            </FileToolButton>
          )}
          <FileToolButton
            label={t("dockFilesRefresh")}
            disabled={saving || loading || disconnected}
            onClick={() => void refreshOpenFile(sessionKey)}
          >
            <RefreshCw size={14} />
          </FileToolButton>
          <FileToolButton label={t("dockFilesCopyRelativePath")} onClick={() => void copy()}>
            <Copy size={14} />
          </FileToolButton>
          <FileToolButton
            label={t("dockFilesInsertReference")}
            disabled={disconnected}
            onClick={() => {
              useAppStore.getState().setPage("chat");
              requestComposerInsert(`@${path}`);
            }}
          >
            <AtSign size={14} />
          </FileToolButton>
          <FileToolButton label={t("fileSystemOpen")} onClick={() => void reveal()}>
            <FolderOpen size={14} />
          </FileToolButton>
        </div>
      </div>
      <FilePreviewSurface sessionKey={sessionKey} session={session} disconnected={disconnected} />
    </div>
  );
}
