import {
  Bot,
  ChevronDown,
  Folder,
  FolderPlus,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import {
  activateWorkspaceHost,
  fetchHostActivity,
  hostActivityCwds,
  prepareWorkspaceHost,
  rebindActiveWorkspaceHost,
  replayActiveHostReady,
  subscribeHostActivity,
  type HostActivitySummary,
} from "../../lib/bridge/tauri-transport";
import type { WorkspaceActivity } from "../../lib/stores/app-store";
import type { SessionTerminalSnapshot } from "../../lib/session-terminal-states";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";
import { sidebarPref, setSidebarPref } from "../../lib/sidebar-prefs";
import { useT } from "../../lib/i18n/use-t";
import { workspaceContext } from "../../lib/bridge/host-context";
import {
  isWorkspaceSwitchBusyError,
  waitForWorkspaceActivation,
  workspaceHasActiveAgent,
} from "./workspace-switch-policy";
import { TelegramAddDialog } from "../bot/TelegramAddDialog";
import { loadBotGateways, removeGateway, type BotGateway } from "../bot/gateway-store";
import { TelegramInstallDialog } from "../telegram/TelegramInstallDialog";
import { TelegramWorkspaceRow } from "../telegram/TelegramWorkspaceRow";
import { isTelegramPluginInstalled } from "../telegram/telegram-plugin";
import { useTelegramViewStore, useTelegramWorkspaceActive } from "../telegram/telegram-view-store";
import { isSameTelegramPath } from "../../lib/telegram-path";

export function workspaceDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
}

/** Renderer path identity uses only Host-canonical strings. */
function samePath(a: string, b: string): boolean {
  return a === b;
}

/**
 * The Rust Host pool lowercases workspace keys on Windows, and the activity
 * snapshot returns each entry's Rust-canonicalized cwd — which can differ from
 * the renderer's casing. Normalize both sides the same way for lookups.
 */
function normalizedActivityKey(path: string): string {
  return /^win/i.test(navigator.platform) ? path.toLowerCase() : path;
}

/**
 * Projects one pool snapshot entry onto a single workspace cwd.
 *
 * Shared-host mode binds several workspaces to one Host, so entry-level
 * numbers describe the Host, not each workspace. When the pool reports
 * per-session ownership (busySessions / terminal workspaceCwd), busy and the
 * terminal markers are scoped to the cwd they belong to. Markers without an
 * owning cwd mirror every bound cwd (legacy semantics — scoping never hides
 * a completion), and when no marker carries ownership at all the aggregate
 * counters and whole-entry mirroring are kept.
 */
export function summarizeWorkspaceActivity(
  entry: HostActivitySummary,
  cwd: string,
): WorkspaceActivity {
  const key = normalizedActivityKey(cwd);
  const markers = Object.entries(entry.terminalSessions ?? {});
  const ownershipKnown = markers.some(([, marker]) => marker.workspaceCwd != null);
  const terminalSessions: Record<string, SessionTerminalSnapshot> = {};
  let errorCount = 0;
  let doneCount = 0;
  for (const [sessionId, marker] of markers) {
    const ownedHere =
      marker.workspaceCwd == null || normalizedActivityKey(marker.workspaceCwd) === key;
    if (!ownedHere) continue;
    terminalSessions[sessionId] = marker;
    if (marker.state === "error") errorCount += 1;
    else doneCount += 1;
  }
  if (!ownershipKnown) {
    // Aggregate counters stay authoritative when nothing is scoped: they may
    // include markers the pool has already acknowledged away.
    errorCount = entry.errorCount;
    doneCount = entry.doneCount;
  }
  return {
    busy:
      entry.busySessions !== undefined
        ? Object.values(entry.busySessions).some(
            (sessionCwd) => normalizedActivityKey(sessionCwd) === key,
          )
        : entry.busy,
    hasBeenBusy: entry.hasBeenBusy,
    errorCount,
    doneCount,
    terminalSessions,
  };
}

export function addKnownWorkspace(list: string[], path: string): string[] {
  return list.some((entry) => samePath(entry, path)) ? list : [...list, path];
}

export function removeKnownWorkspace(list: string[], path: string): string[] {
  return list.filter((entry) => !samePath(entry, path));
}

export function replaceKnownWorkspace(
  list: string[],
  requestedPath: string,
  canonicalPath: string,
): string[] {
  const next = list.map((entry) => (samePath(entry, requestedPath) ? canonicalPath : entry));
  if (!next.some((entry) => samePath(entry, canonicalPath))) next.push(canonicalPath);
  return next.filter((entry, index) => next.indexOf(entry) === index);
}

// Stable fallback: a fresh [] per render makes the zustand selector loop.
const NO_WORKSPACES: string[] = [];

export function WorkspacePicker() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const telegramActive = useTelegramWorkspaceActive();
  const telegramWorkspacePath = useTelegramViewStore((s) => s.workspacePath);
  const telegramProfileConfigured = useTelegramViewStore((s) => s.profile?.configured ?? false);
  const workspace = useAppStore((s) => s.workspace);
  const knownWorkspaces = useAppStore((s) => s.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES);
  const switchTarget = useAppStore((s) => s.workspaceSwitchTarget);
  const workspaceActivities = useAppStore((s) => s.workspaceActivities);
  const setWorkspaceActivities = useAppStore((s) => s.setWorkspaceActivities);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setSession = useAppStore((s) => s.setSession);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(() =>
    sidebarPref("piabyss.sidebar.workspacesCollapsed"),
  );
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);

  // Click outside (or Esc, scroll, or viewport resize) closes the add menu.
  // The menu is rendered as a fixed overlay anchored to the 按钮 so it both
  // escapes the sidebar's `overflow-hidden` clipping and stacks above the
  // right dock (which paints later in DOM). Any layout change scrolled away.
  useEffect(() => {
    if (!addMenuOpen) {
      setAddMenuPos(null);
      return;
    }
    const anchor = addMenuAnchorRef.current;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setAddMenuPos({ left: rect.left, top: rect.bottom + 4 });
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        (addMenuRef.current && addMenuRef.current.contains(target)) ||
        (addMenuAnchorRef.current && addMenuAnchorRef.current.contains(target))
      ) {
        return;
      }
      setAddMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    const onLayoutChange = () => setAddMenuOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onLayoutChange);
    const onScroll = () => setAddMenuOpen(false);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLayoutChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [addMenuOpen]);
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false);
  const [telegramInstallOpen, setTelegramInstallOpen] = useState(false);
  const [gateways, setGateways] = useState<BotGateway[]>(() => loadBotGateways());
  const [gatewaysCollapsed, setGatewaysCollapsed] = useState(() =>
    sidebarPref("piabyss.sidebar.botGatewaysCollapsed"),
  );
  const requestRef = useRef(0);

  function toggleCollapsed() {
    setCollapsed((current) => {
      setSidebarPref("piabyss.sidebar.workspacesCollapsed", !current);
      return !current;
    });
  }

  function toggleGatewaysCollapsed() {
    setGatewaysCollapsed((current) => {
      setSidebarPref("piabyss.sidebar.botGatewaysCollapsed", !current);
      return !current;
    });
  }

  function removeGatewayEntry(gateway: BotGateway) {
    setGateways(removeGateway(gateway.id));
    pushNotification(t("botGatewayRemovedNotif", { name: gateway.name }), "success");
  }

  const currentCwd = workspace?.canonicalCwd ?? null;
  const requestedCwd = workspace?.cwd ?? null;

  // Self-heal: whatever workspace is active (restored, picked, or set by the
  // host) always appears in the persistent list. The telegram workspace is a
  // first-class row of its own, never a folder entry — keep it out.
  useEffect(() => {
    if (!currentCwd) return;
    if (isSameTelegramPath(currentCwd, telegramWorkspacePath)) return;
    const next = replaceKnownWorkspace(knownWorkspaces, requestedCwd ?? currentCwd, currentCwd);
    if (
      next.length === knownWorkspaces.length &&
      next.every((entry, index) => entry === knownWorkspaces[index])
    ) {
      return;
    }
    void persistDesktopSettings({
      knownWorkspaces: next,
    }).catch(notifyDesktopSettingsSaveFailure);
  }, [currentCwd, knownWorkspaces, requestedCwd, telegramWorkspacePath]);

  // Live activity for every workspace Host in the pool, including background
  // ones whose stdout is not routed to the renderer. Refetch on mount, on
  // workspace/host changes, and whenever a Host emits a busy-change signal.
  useEffect(() => {
    let alive = true;
    let latestRefresh = 0;
    const refresh = async () => {
      const request = ++latestRefresh;
      const list = await fetchHostActivity();
      if (!alive || request !== latestRefresh) return;
      // One snapshot entry covers every workspace its Host serves (a single
      // cwd in dedicated mode; all registered workspaces in shared-host mode).
      // Per-cwd projection scopes busy/terminal signals to their owning
      // workspace when the pool reports session ownership.
      const activities: typeof workspaceActivities = {};
      for (const entry of list) {
        for (const cwd of hostActivityCwds(entry)) {
          activities[normalizedActivityKey(cwd)] = summarizeWorkspaceActivity(entry, cwd);
        }
      }
      const current = useAppStore.getState();
      const currentWorkspace = current.workspace;
      if (currentWorkspace) {
        const active = activities[normalizedActivityKey(currentWorkspace.canonicalCwd)];
        if (active) {
          current.mergeSessionTerminalSnapshots(currentWorkspace.id, active.terminalSessions);
        }
      }
      setWorkspaceActivities(activities);
    };
    void refresh();
    const unsubscribe = subscribeHostActivity(() => void refresh());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [setWorkspaceActivities, workspace?.id, host?.hostInstanceId]);

  async function switchTo(cwd: string) {
    if (!host || pending) return;
    // Leaving the telegram view for a folder workspace: run before the
    // same-cwd early return so clicking the already-active folder workspace
    // still exits the telegram view (single-selection semantics).
    useTelegramViewStore.getState().exitTelegramWorkspace();
    if (currentCwd && samePath(currentCwd, cwd)) return;

    const request = ++requestRef.current;
    setPending(true);
    useAppStore.getState().setWorkspaceSwitchTarget(cwd);
    const currentPage = useAppStore.getState().page;
    if (currentPage !== "chat") useAppStore.getState().setPage("chat");
    try {
      // Shared-host mode: one Host serves every workspace, so there is no
      // dedicated Host to prepare — always take the in-place
      // `workspace.setCurrent` path (the same connection; no
      // prepareForHostSwitch/replay needed) and register the workspace via
      // rebindActiveWorkspaceHost below. Enabled by default, including
      // while settings are still loading.
      const sharedHostMode = useAppStore.getState().desktopSettings?.sharedHostMode !== false;
      const connectDedicatedHost = async (force: boolean): Promise<boolean> => {
        const activated = force
          ? await activateWorkspaceHost(cwd)
          : await prepareWorkspaceHost(cwd, workspaceHasActiveAgent(useAppStore.getState()));
        if (!activated) return false;
        hostClient.prepareForHostSwitch();
        useAppStore.getState().setConnecting(true);
        await replayActiveHostReady();
        await waitForWorkspaceActivation(host.hostInstanceId);
        return true;
      };
      if (!sharedHostMode && (await connectDedicatedHost(false))) {
        return;
      }

      // Transient SERVICE_GRAPH_BUSY collisions (an in-flight read holding the
      // serviceGraphLock) are retryable by design; give the switch a short
      // retry window instead of surfacing a one-off busy toast.
      // optimistic: the Host commits a pending shell (servicesReady: false)
      // and returns before the full build, so the picker switches instantly —
      // the session lands via a later snapshot event.
      const attempted = await requestWithRetry(
        () =>
          hostClient.request(
            "workspace.setCurrent",
            workspaceContext(host, workspace),
            { cwd, optimistic: true },
            60_000,
          ),
        undefined,
        () => request === requestRef.current,
      );
      if (!attempted) return;
      const res = attempted;

      if (request !== requestRef.current) return;
      if (!res.ok) {
        // In shared mode a busy rejection cannot be resolved by a dedicated
        // Host (there is none) — surface it instead of retrying.
        if (
          !sharedHostMode &&
          isWorkspaceSwitchBusyError(res.error) &&
          (await connectDedicatedHost(true))
        )
          return;
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }

      const result = res.result;
      try {
        await rebindActiveWorkspaceHost(result.workspace.canonicalCwd);
      } catch (rebindError) {
        // Registration failure must not break an already-successful switch:
        // rebind only feeds Rust bookkeeping (activity cwds / restart restore).
        console.warn("[piabyss] workspace host rebind failed", rebindError);
      }
      // workspace.changed / session.snapshot events land before this response
      // resolves; re-applying identical snapshots re-renders the chat and
      // sidebar a second time. Apply only what the event stream has not.
      const appliedWorkspace = useAppStore.getState().workspace;
      if (
        appliedWorkspace === null ||
        appliedWorkspace.id !== result.workspace.id ||
        appliedWorkspace.revision !== result.workspace.revision
      ) {
        setWorkspace(result.workspace);
      }
      const responseSession = result.session;
      if (responseSession) {
        const appliedSession = useAppStore.getState().session;
        if (
          appliedSession === null ||
          appliedSession.sessionId !== responseSession.sessionId ||
          appliedSession.revision !== responseSession.revision
        ) {
          setSession(responseSession);
        }
      }
      useAppStore.getState().setHost({
        ...host,
        workspaceId: res.workspaceId,
        workspaceRevision: res.workspaceRevision,
        sessionId: res.sessionId,
        sessionRevision: res.sessionRevision,
        packageRevision: res.packageRevision,
      });
    } finally {
      if (request === requestRef.current) {
        setPending(false);
        useAppStore.getState().setWorkspaceSwitchTarget(null);
      }
    }
  }

  async function pickAndAdd() {
    if (!host || pending) return;
    let cwd: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") cwd = selected;
    } catch {
      cwd = window.prompt(t("workspacesEnterPath")) || null;
    }
    if (!cwd) return;
    await switchTo(cwd);
  }

  /**
   * "Add → TG workspace": install the plugin first when missing, then create/
   * enter the dedicated telegram workspace and bind a bot (token dialog when
   * none is configured yet; otherwise just enter the workspace).
   */
  const checkTelegramPluginInstalled = async (): Promise<boolean> => {
    const { host: hostNow, workspace: workspaceNow } = useAppStore.getState();
    if (!hostNow || !workspaceNow) return false;
    try {
      const res = await hostClient.request(
        "package.list",
        workspaceContext(hostNow, workspaceNow),
        { scope: "user" },
        30_000,
      );
      return res.ok && isTelegramPluginInstalled(res.result);
    } catch {
      return false;
    }
  };

  async function startTelegramAdd() {
    setAddMenuOpen(false);
    const { host: hostNow, workspace: workspaceNow } = useAppStore.getState();
    if (!hostNow) return;
    if (!workspaceNow) {
      pushNotification(t("tgInstallNeedsWorkspace"), "warning");
      return;
    }
    if (!(await checkTelegramPluginInstalled())) {
      setTelegramInstallOpen(true);
      return;
    }
    await enterTelegramWorkspaceFlow();
  }

  /** Ensure the telegram workspace folder and switch to it; open the token
   *  dialog when no bot is bound yet. Never auto-starts the bridge. */
  async function enterTelegramWorkspaceFlow() {
    const path = await useTelegramViewStore.getState().ensureTelegramWorkspace();
    if (!path) {
      pushNotification(t("tgWorkspaceCreateFailed"), "warning");
      return;
    }
    await switchTo(path);
    const store = useTelegramViewStore.getState();
    if (!store.profile?.configured) {
      setTelegramDialogOpen(true);
    }
  }

  function removeFromList(path: string) {
    void persistDesktopSettings({
      knownWorkspaces: removeKnownWorkspace(knownWorkspaces, path),
    }).catch(notifyDesktopSettingsSaveFailure);
  }

  // Render the active workspace even before self-heal persists it. The
  // telegram workspace is rendered by its own row, so folder rows exclude it.
  const listed = (
    currentCwd ? addKnownWorkspace(knownWorkspaces, currentCwd) : knownWorkspaces
  ).filter((path) => !isSameTelegramPath(path, telegramWorkspacePath));

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="workspace-list-region"
          title={collapsed ? t("workspacesExpand") : t("workspacesCollapse")}
          className="group flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-foreground"
        >
          <span>{t("workspacesTitle")}</span>
          <ChevronDown
            size={12}
            className={`opacity-0 transition-all group-hover:opacity-100 ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        <div className="relative">
          <button
            type="button"
            ref={addMenuAnchorRef}
            onClick={() => setAddMenuOpen((v) => !v)}
            disabled={!host || pending}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            title={t("botAddMenu")}
            aria-label={t("botAddMenu")}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
          >
            <Plus size={15} />
          </button>
          {addMenuOpen && addMenuPos
            ? createPortal(
                <div
                  ref={addMenuRef}
                  className="theme-floating-surface fixed z-[110] w-60 rounded-md border border-border bg-surface-raised p-1 shadow-xl"
                  role="menu"
                  style={{ left: addMenuPos.left, top: addMenuPos.top }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
                    onClick={() => {
                      setAddMenuOpen(false);
                      void pickAndAdd();
                    }}
                  >
                    <FolderPlus size={16} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {t("botAddFolderWorkspace")}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {t("botAddFolderWorkspaceDesc")}
                      </span>
                    </span>
                  </button>
                  {!telegramProfileConfigured && (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-overlay"
                      onClick={() => void startTelegramAdd()}
                    >
                      <Send size={16} className="mt-0.5 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {t("botAddTelegramBot")}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {t("botAddTelegramBotDesc")}
                        </span>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <MessageCircle size={16} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {t("botAddWeixinBot")}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {t("botAddWeixinBotDesc")}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] text-muted">
                      {t("botAddComingSoon")}
                    </span>
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>
      </div>
      <CollapsibleRegion open={!collapsed} id="workspace-list-region">
        {listed.length === 0 ? (
          <button
            type="button"
            onClick={() => void pickAndAdd()}
            disabled={!host || pending}
            className="interface-density-nav-row flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          >
            <FolderPlus size={16} />
            <span>{pending ? t("workspacesOpening") : t("workspacesAdd")}</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {listed.map((path) => {
              // Folders and the telegram workspace are single-select: while
              // the telegram view is active, folder rows show as inactive.
              const active = !telegramActive && Boolean(currentCwd && samePath(currentCwd, path));
              const activity = workspaceActivities[normalizedActivityKey(path)];
              // Priority: red (unacknowledged failure) > green (busy) > gray
              // (unacknowledged completion) > none. Returning to the sessions
              // acknowledges their markers, so the dot downgrades over time.
              const statusDot =
                activity && activity.errorCount > 0
                  ? "bg-danger status-dot-pulse"
                  : activity?.busy
                    ? "bg-success status-dot-pulse"
                    : activity && activity.doneCount > 0
                      ? "bg-muted status-dot-pulse"
                      : active && !workspace?.servicesReady
                        ? "bg-warning status-dot-pulse"
                        : null;
              return (
                <li
                  key={path}
                  className={`interface-density-nav-row group flex h-9 items-center rounded-md text-[13px] ${
                    active ? "bg-surface-overlay font-medium" : "hover:bg-surface-overlay/70"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void switchTo(path)}
                    disabled={!host || pending || active}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                    title={`${workspaceDisplayName(path)}\n${path}`}
                    aria-current={active ? "true" : undefined}
                  >
                    {pending && switchTarget !== null && samePath(switchTarget, path) ? (
                      <LoaderCircle size={16} className="shrink-0 animate-spin text-muted" />
                    ) : (
                      <Folder
                        size={16}
                        className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{workspaceDisplayName(path)}</span>
                    {statusDot && (
                      <span className={`size-[8.2px] shrink-0 rounded-full ${statusDot}`} />
                    )}
                  </button>
                  {!active && (
                    <button
                      type="button"
                      onClick={() => removeFromList(path)}
                      disabled={pending}
                      className="mr-1 hidden rounded p-1 text-muted hover:bg-surface hover:text-foreground group-hover:block"
                      title={t("workspacesRemoveTitle")}
                      aria-label={t("workspacesRemoveAria", { name: workspaceDisplayName(path) })}
                    >
                      <X size={13} />
                    </button>
                  )}
                </li>
              );
            })}
            <TelegramWorkspaceRow onActivate={(path) => switchTo(path)} />
          </ul>
        )}
      </CollapsibleRegion>
      {gateways.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex h-7 items-center px-2">
            <button
              type="button"
              onClick={toggleGatewaysCollapsed}
              aria-expanded={!gatewaysCollapsed}
              aria-controls="bot-gateways-region"
              title={gatewaysCollapsed ? t("botGatewaysExpand") : t("botGatewaysCollapse")}
              className="group flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-foreground"
            >
              <span>{t("botGatewaysTitle")}</span>
              <ChevronDown
                size={12}
                className={`opacity-0 transition-all group-hover:opacity-100 ${
                  gatewaysCollapsed ? "-rotate-90" : ""
                }`}
              />
            </button>
          </div>
          <CollapsibleRegion open={!gatewaysCollapsed} id="bot-gateways-region">
            <ul className="flex flex-col gap-0.5">
              {gateways.map((gateway) => {
                const statusDot = gateway.connected ? "bg-success" : "bg-muted";
                const boundTitle = gateway.boundWorkspacePath
                  ? t("botGatewayBoundWorkspace", { path: gateway.boundWorkspacePath })
                  : t("botGatewayBoundWorkspaceUnknown");
                return (
                  <li
                    key={gateway.id}
                    className="interface-density-nav-row group flex h-9 items-center rounded-md hover:bg-surface-overlay/70"
                  >
                    <span
                      className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[13px]"
                      title={`${gateway.name}\n${boundTitle}`}
                    >
                      <Bot size={16} className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{gateway.name}</span>
                      {gateway.handle && (
                        <span className="shrink-0 truncate font-mono text-[10px] text-muted">
                          {gateway.handle}
                        </span>
                      )}
                      <span
                        className={`size-[8.2px] shrink-0 rounded-full ${statusDot}`}
                        title={
                          gateway.connected ? t("botGatewayConnected") : t("botGatewayDisconnected")
                        }
                      />
                    </span>
                    <button
                      type="button"
                      onClick={() => removeGatewayEntry(gateway)}
                      className="mr-1 hidden rounded p-1 text-muted hover:bg-surface hover:text-foreground group-hover:block"
                      title={t("botGatewayRemoveTitle")}
                      aria-label={t("botGatewayRemoveAria", { name: gateway.name })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </CollapsibleRegion>
        </div>
      )}
      {telegramDialogOpen && <TelegramAddDialog onCancel={() => setTelegramDialogOpen(false)} />}
      {telegramInstallOpen && (
        <TelegramInstallDialog
          onCancel={() => setTelegramInstallOpen(false)}
          onInstalled={() => {
            setTelegramInstallOpen(false);
            void enterTelegramWorkspaceFlow();
          }}
        />
      )}
    </section>
  );
}
