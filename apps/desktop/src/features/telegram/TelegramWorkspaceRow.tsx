import { FolderOpen, LoaderCircle, Pencil, Send, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import {
  loadTelegramBridgePrefEnabled,
  loadTelegramWorkspaceDisplayName,
  saveTelegramWorkspaceDisplayName,
  useTelegramViewStore,
  useTelegramWorkspaceActive,
} from "./telegram-view-store";
import { TelegramRenameDialog } from "./TelegramRenameDialog";
import { TelegramSettingsDialog } from "./TelegramSettingsDialog";

/**
 * The telegram workspace rendered as a row inside the regular workspace list.
 *
 * Unlike the old virtual view (frontend-only state), selecting this row now
 * switches to the REAL dedicated workspace (`<agentDir>/workspace/telegram`)
 * through the normal host-switch machinery, so the bridge's polling session
 * lives in this workspace and TG turns never land in other workspaces. The
 * bridge does NOT auto-start on entry or at app startup — it only starts via
 * the manual settings switch. The row is hidden until a bot
 * profile has actually been added and configured (see the render guard); once
 * visible, the subtitle reflects the bind state.
 */
export function TelegramWorkspaceRow({
  onActivate,
}: {
  /** Real workspace switch for the telegram workspace path. */
  onActivate: (path: string) => Promise<void>;
}) {
  const t = useT();
  const active = useTelegramWorkspaceActive();
  const profile = useTelegramViewStore((s) => s.profile);
  const workspacePath = useTelegramViewStore((s) => s.workspacePath);
  const loaded = useTelegramViewStore((s) => s.loaded);
  const loading = useTelegramViewStore((s) => s.loading);
  const bridgeStatus = useTelegramViewStore((s) => s.bridgeStatus);
  const bridgeLoading = useTelegramViewStore((s) => s.bridgeLoading);
  const refresh = useTelegramViewStore((s) => s.refreshTelegramSessions);
  const refreshStatus = useTelegramViewStore((s) => s.refreshBridgeStatus);
  const ensureWorkspace = useTelegramViewStore((s) => s.ensureTelegramWorkspace);
  // Host presence drives the initial refresh: on app startup the host is
  // async and may not be ready when this row first mounts, which would
  // otherwise skip the load and hide the entry permanently.
  const hostReady = useAppStore((s) => s.host?.hostInstanceId);
  const [displayName, setDisplayName] = useState<string | null>(() =>
    loadTelegramWorkspaceDisplayName(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // Mirrors the persisted bridge on/off preference so the status dot can
  // distinguish "user turned it off" from "should be on but not connected".
  const [bridgePrefOn, setBridgePrefOn] = useState(() => loadTelegramBridgePrefEnabled());

  // Refresh on mount and again once the host becomes available, so a
  // persisted telegram.json / journaled history shows up after startup.
  useEffect(() => {
    void ensureWorkspace().then(() => {
      void refresh();
      void refreshStatus();
    });
  }, [ensureWorkspace, hostReady, refresh, refreshStatus]);

  const openFolder = useCallback(() => {
    void (async () => {
      if (!workspacePath) await ensureWorkspace();
      const path = useTelegramViewStore.getState().workspacePath;
      if (!path) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("desktop_open_path", { path });
      } catch {
        /* no-op: the native open failed silently */
      }
    })();
  }, [ensureWorkspace, workspacePath]);

  // No profile added AND configured yet: there is no dedicated workspace to
  // enter, so an "unconfigured" stub row is pure noise. Keep the component
  // mounted (hooks above still run) so the row appears the moment the add/
  // settings flow publishes a configured profile into the store.
  if (profile === null || !profile.configured) return null;

  async function handleActivate() {
    const path = await ensureWorkspace();
    if (!path) return;
    if (!active) {
      await onActivate(path);
    }
    // Either the switch completed or we were already inside the telegram
    // workspace: refresh history. The bridge is intentionally NOT auto-started
    // here — switching workspaces must not re-arm the bridge; it only starts
    // via the manual settings switch.
    void refresh();
  }

  const botLabel = profile.botUsername ? `@${profile.botUsername}` : "Telegram";
  const title = displayName ?? botLabel;
  const subtitle = !loaded ? undefined : (profile.botName ?? undefined);

  // Status dot: green when the bridge is connected; hidden when the user
  // turned the bridge off; red when the bridge is expected to run (pref on)
  // but is not currently connected. While the status is loading (or unknown)
  // we show no dot so a stale value never flashes a false error/off reading.
  // The render guard above guarantees a configured profile.
  const connected = bridgeStatus?.connected === true;
  const bridgeError = bridgePrefOn && bridgeStatus !== null && !connected && !bridgeLoading;
  let statusDot: string | null = null;
  let statusTitle: string | undefined;
  if (bridgePrefOn && connected) {
    statusDot = "bg-success status-dot-pulse";
    statusTitle = t("tgBridgeConnected");
  } else if (bridgeError) {
    statusDot = "bg-danger";
    statusTitle = t("tgBridgeError");
  }

  const onContextMenu = (event: React.MouseEvent) => {
    if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      trigger: contextMenuTrigger(event.target),
      items: [
        {
          id: "telegram-settings",
          label: t("tgCtxSettings"),
          icon: Settings,
          onSelect: () => setSettingsOpen(true),
        },
        {
          id: "telegram-rename",
          label: t("tgCtxRename"),
          icon: Pencil,
          onSelect: () => setRenameOpen(true),
        },
        {
          id: "telegram-open-folder",
          label: t("tgCtxOpenFolder"),
          icon: FolderOpen,
          separatorBefore: true,
          onSelect: () => openFolder(),
        },
      ],
    });
  };

  return (
    <li
      className={`interface-density-nav-row flex h-9 items-center rounded-md text-[13px] ${
        active ? "bg-surface-overlay font-medium" : "hover:bg-surface-overlay/70"
      }`}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={() => void handleActivate()}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
        title={t("tgWorkspaceEnterTitle", { name: title })}
      >
        {loading ? (
          <LoaderCircle size={16} className="shrink-0 animate-spin text-muted" />
        ) : (
          <Send size={16} className={`shrink-0 ${active ? "text-accent" : "text-muted"}`} />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {subtitle && <span className="shrink-0 truncate text-[10px] text-muted">{subtitle}</span>}
        {statusDot && (
          <span className={`size-[8.2px] shrink-0 rounded-full ${statusDot}`} title={statusTitle} />
        )}
      </button>
      {settingsOpen && (
        <TelegramSettingsDialog
          onCancel={() => setSettingsOpen(false)}
          onChanged={() => {
            void refresh();
            void refreshStatus();
            setDisplayName(loadTelegramWorkspaceDisplayName());
            setBridgePrefOn(loadTelegramBridgePrefEnabled());
          }}
        />
      )}
      {renameOpen && (
        <TelegramRenameDialog
          currentName={displayName ?? botLabel}
          onCancel={() => setRenameOpen(false)}
          onConfirm={(name) => {
            saveTelegramWorkspaceDisplayName(name);
            setDisplayName(loadTelegramWorkspaceDisplayName());
            setRenameOpen(false);
          }}
        />
      )}
    </li>
  );
}
