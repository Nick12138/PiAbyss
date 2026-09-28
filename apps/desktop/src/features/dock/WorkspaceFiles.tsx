import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  AtSign,
  Copy,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { FilesPanel, workspaceAbsolutePath } from "./FilesPanel";
import { FilePreviewSurface } from "./FilePreviewSurface";
import { FileToolButton } from "./FileToolButton";
import {
  FILES_SESSION_KEY,
  clearFileSession,
  ensureFileCanLeave,
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

export function WorkspaceFiles({ visible }: { visible: boolean }) {
  const t = useT();
  const session = useFileSession(FILES_SESSION_KEY);
  const { path, loading, saving } = session;
  const workspace = useAppStore((s) => s.workspace);
  const host = useAppStore((s) => s.host);
  const connecting = useAppStore((s) => s.connecting || s.rehydrating);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [width, setWidth] = useState(460);
  const [showTree, setShowTree] = useState(true);
  const [showContent, setShowContent] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const pendingOpen = useRef(0);
  const wide = width >= 640;
  const dirty = fileIsDirty(session);
  const disconnected = !host || !workspace || connecting || workspace.canonicalCwd !== session.root;
  const parentPath = path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !host || !workspace || connecting) return;
    const current = useFileSession.getState(FILES_SESSION_KEY);
    if (
      current.root &&
      workspace.canonicalCwd !== current.root &&
      !fileIsDirty(current) &&
      !current.saving
    ) {
      clearFileSession(FILES_SESSION_KEY);
      setShowContent(false);
    } else if (current.root === workspace.canonicalCwd) void refreshOpenFile(FILES_SESSION_KEY);
  }, [visible, host, workspace, connecting]);

  useEffect(() => {
    if (!visible || !host || !workspace) return;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = subscribeValidatedHostEvent(
      "workspace.filesChanged",
      workspaceContext(host, workspace),
      (event) => {
        if (!event.payload.directories.includes(parentPath)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refreshOpenFile(FILES_SESSION_KEY), 200);
      },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [visible, host, workspace, parentPath]);

  const openFile = useCallback(async (selected: string) => {
    const request = ++pendingOpen.current;
    const previous = useFileSession.getState(FILES_SESSION_KEY);
    const opening = openWorkspaceFile(selected, FILES_SESSION_KEY);
    // Display the content surface immediately for loading/error feedback.
    if (!fileIsDirty(previous)) setShowContent(true);
    const opened = await opening;
    if (request !== pendingOpen.current) return;
    if (opened || useFileSession.getState(FILES_SESSION_KEY).path === selected) {
      setShowContent(true);
    }
  }, []);

  const insert = () => {
    if (!path || disconnected) return;
    useAppStore.getState().setPage("chat");
    requestComposerInsert(`@${path}`);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path ?? "");
      pushNotification(t("dockFilesPathCopied"), "info");
    } catch {
      pushNotification(t("dockFilesCopyFailed"), "warning");
    }
  };
  const systemOpen = async () => {
    if (!session.root || !path) return;
    try {
      await invoke("desktop_open_path", { path: workspaceAbsolutePath(session.root, path) });
    } catch {
      pushNotification(t("dockFilesRevealFailed"), "warning");
    }
  };
  const refresh = async () => {
    if (await ensureFileCanLeave()) {
      if (!session.file && path) void openWorkspaceFile(path, FILES_SESSION_KEY);
      else await refreshOpenFile(FILES_SESSION_KEY);
    }
  };
  const treeVisible = wide ? showTree : !showContent;
  const contentVisible = wide || showContent;

  return (
    <div
      ref={container}
      data-file-workspace
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveOpenFile(undefined, FILES_SESSION_KEY);
        }
      }}
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 border-b border-border px-2 py-1">
        {!wide && showContent && (
          <FileToolButton label={t("fileBackToTree")} onClick={() => setShowContent(false)}>
            <ArrowLeft size={14} />
          </FileToolButton>
        )}
        <div className="min-w-0 flex-1 basis-24 py-1" title={path ?? t("dockFiles")}>
          <div className="truncate text-xs font-medium">
            {path?.split("/").pop() ?? t("dockFiles")}
            {dirty ? " *" : ""}
          </div>
          {parentPath && <div className="truncate text-[11px] text-muted">{parentPath}/</div>}
        </div>
        <div className="flex shrink-0 items-center">
          {session.file?.kind === "text" && (
            <FileToolButton
              label={saving ? t("fileSaving") : t("fileSave")}
              disabled={!dirty || saving || disconnected}
              onClick={() => void saveOpenFile(undefined, FILES_SESSION_KEY)}
            >
              {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
            </FileToolButton>
          )}
          {path && (
            <>
              <FileToolButton
                label={t("dockFilesRefresh")}
                disabled={saving || loading || disconnected}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
              </FileToolButton>
              <FileToolButton label={t("dockFilesCopyRelativePath")} onClick={() => void copy()}>
                <Copy size={14} />
              </FileToolButton>
              <FileToolButton
                label={t("dockFilesInsertReference")}
                disabled={disconnected}
                onClick={insert}
              >
                <AtSign size={14} />
              </FileToolButton>
              <FileToolButton label={t("fileSystemOpen")} onClick={() => void systemOpen()}>
                <FolderOpen size={14} />
              </FileToolButton>
            </>
          )}
          {wide && (
            <FileToolButton
              label={t("fileToggleTree")}
              pressed={showTree}
              onClick={() => setShowTree(!showTree)}
            >
              <FolderTree size={14} />
            </FileToolButton>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={`${contentVisible ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col`}>
          <FilePreviewSurface
            sessionKey={FILES_SESSION_KEY}
            session={session}
            disconnected={disconnected}
          />
        </div>
        <div
          className={`${treeVisible ? "flex" : "hidden"} min-h-0 min-w-0 flex-col ${wide ? "w-[220px] shrink-0 border-l border-border" : "flex-1"}`}
        >
          <FilesPanel
            visible={visible}
            onOpenFile={(entry) => void openFile(entry.path)}
            previewParent={
              path && session.root === workspace?.canonicalCwd ? parentPath : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
