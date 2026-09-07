import { useEffect, useState } from "react";
import { useAppStore } from "../lib/stores/app-store";
import { hostClient, isSyntheticLifecycleFatal } from "../lib/bridge/host-client";
import {
  createTauriTransport,
  replayActiveHostReady,
  acknowledgeSessionTerminal,
} from "../lib/bridge/tauri-transport";
import { RecoveryEventBuffer, fullRehydrate } from "../lib/bridge/rehydrate";
import { Sidebar } from "../components/Sidebar";
import { RightDock } from "../components/RightDock";
import { AppTopBar } from "../components/AppTopBar";
import { FileEditorDialogs } from "../features/dock/FileEditorDialogs";
import { fileWorkspaceForRecovery } from "../features/dock/file-session";
import { resolveWindowControlsPlatform } from "../components/WindowControls";
import { ChatPage } from "../features/chat/ChatPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SettingsTopBarActionsContext } from "../features/settings/settings-top-bar";
import { ExtensionUiModal } from "../features/chat/ExtensionUiModal";
import { GlobalSearchHost } from "../features/sessions/GlobalSearchModal";
import { WorkspaceSwitchTransition } from "../features/workspaces/WorkspaceSwitchTransition";
import { applyTheme } from "../lib/theme";
import { applyAppearancePreferences } from "../lib/appearance-preferences";
import { subscribeSidebarToggle } from "../lib/commands/events";
import {
  applyAgentEvent,
  applyAgentEventBatch,
  matchesTimedAgentEventIdentity,
  type TimedAgentEventEnvelope,
} from "../lib/chat/transcript-reducer";
import { classifyToolSnapshot } from "../lib/stores/tool-revision";
import { expectedIdentityForEvent, extensionUiRequestDelivery } from "./event-identity";
import { publishValidatedHostEvent } from "../lib/bridge/validated-host-events";
import {
  mergeHostIdentity,
  nullableSessionContext,
  workspaceContext,
} from "../lib/bridge/host-context";
import { requestSessionOpenWithRetry } from "../lib/bridge/session-open-request";
import { openSessionAcrossWorkspaces } from "../lib/bridge/session-navigation";
import {
  SystemNotificationController,
  type SystemNotificationTarget,
} from "../lib/system-notifications";
import { ActivityNotificationObserver, activityPathKey } from "../lib/activity-notifications";
import { summarizeHostFailure } from "../lib/host-failure-message";
import { getAppVersion } from "../lib/app-version";
import { checkForAppUpdate } from "../lib/updater";
import { applyLanguage } from "../lib/i18n";
import { tCurrent, useT } from "../lib/i18n/use-t";
import { StartupScreen, resolveStartupStage, useInitialStartupScreen } from "./StartupScreen";
import { DraftPersistenceController } from "./DraftPersistenceController";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  persistRecentDesktopLocation,
  type DesktopSettingsSnapshot,
} from "../lib/desktop-settings";
import {
  clearExtensionTerminal as clearExtensionTerminalFrames,
  pushExtensionTerminalFrame,
} from "../lib/chat/extension-terminal-bus";
import type { HostEventEnvelope, HostEventPayloadMap } from "@piabyss/protocol";
import { CommandLayer } from "../lib/commands/CommandLayer";
import {
  resolveWindowFrameAttribute,
  resolveWindowFrameMode,
  type WindowFrameMode,
} from "../lib/window-frame";

export async function runFullRehydrate(
  expectedHostInstanceId: string,
  recoveryEvents: RecoveryEventBuffer,
  requestRecovery: (reason: string) => void,
  agentEventBuffer: {
    enqueue: (event: HostEventEnvelope<"agent.event">) => void;
    flush: () => void;
  },
): Promise<boolean> {
  const store = useAppStore.getState();
  recoveryEvents.begin(expectedHostInstanceId);
  store.setRehydrating(true);
  try {
    const snap = await fullRehydrate(expectedHostInstanceId);
    const recovered = recoveryEvents.finish(snap.host.hostInstanceId, snap.watermark);
    useAppStore.getState().completeRehydrate({
      ...snap,
      lastSequence: snap.watermark,
    });
    if (recovered.overflowed) {
      requestRecovery("recovery event buffer overflowed");
      return false;
    }
    for (const event of recovered.events) {
      if (handleHostEvent(event, requestRecovery, agentEventBuffer)) {
        publishValidatedHostEvent(event);
      }
      if (useAppStore.getState().desynchronized) return false;
    }
    useAppStore.getState().setHostFatal(null);
    return true;
  } catch (err) {
    recoveryEvents.cancel();
    const message = err instanceof Error ? err.message : String(err);
    useAppStore.getState().markDesynchronized(message);
    useAppStore.getState().setHostFatal(message);
    throw err;
  } finally {
    useAppStore.getState().setRehydrating(false);
  }
}

export function applyModelChanged(payload: HostEventPayloadMap["model.changed"]): void {
  const store = useAppStore.getState();
  const currentSession = store.session;
  if (!currentSession) return;
  store.applySessionSnapshot({
    ...currentSession,
    model: payload.model,
    thinkingLevel: payload.thinkingLevel,
  });
  store.setThinkingLevels(payload.availableThinkingLevels);
}

/**
 * A terminal (done/error) state that occurs while a session is in focus is
 * already visible in the conversation pane, so the local store auto-acknowledges
 * its marker (switching away never leaves a stale dot). The Rust Host pool
 * keeps its own copy of the marker with a fresh generation, and a later
 * activity snapshot would otherwise re-open the local acknowledgement across
 * the generation change — so tell the Host pool to drop it as well. Safe when
 * no marker exists yet (e.g. a plain idle announcement that never ran).
 */
function acknowledgeHostTerminalIfFocused(sessionId: string, state: string): void {
  if (state !== "error" && state !== "idle") return;
  const current = useAppStore.getState();
  if (current.session?.sessionId !== sessionId) return;
  const cwd = current.workspace?.canonicalCwd;
  if (!cwd) return;
  void acknowledgeSessionTerminal(cwd, sessionId);
}

/**
 * Resolves a sessionId to its session path by listing the now-active target
 * workspace's sessions. Called by the navigation module after the cross-
 * workspace switch has completed, so the active Host owns this session list.
 */
async function resolveNotificationSessionPath(
  sessionId: string,
): Promise<{ sessionPath: string; archived?: boolean } | null> {
  const current = useAppStore.getState();
  if (!current.host || !current.workspace) return null;
  const response = await hostClient.request(
    "session.list",
    workspaceContext(current.host, current.workspace),
    null,
    30_000,
  );
  if (!response.ok) return null;
  const item = response.result.items.find((entry) => entry.sessionId === sessionId);
  if (!item) return null;
  return { sessionPath: item.sessionPath, archived: item.archived === true };
}

/**
 * OS-notification click router. Navigates to the notification's workspace and
 * session through the same guarded path as global search, then clears the
 * sidebar terminal marker the completed run left behind (both the local store
 * copy and the Rust Host pool's generation marker, matching the in-app
 * acknowledge flow). host-fatal candidates carry no routing target; focusing
 * the app is all they can do.
 */
async function openSystemNotificationTarget(target: SystemNotificationTarget): Promise<void> {
  // A click must surface the app even when the window is hidden to the tray
  // or minimized (fork-specific tray behavior; the notification plugin never
  // shows the window for us). Runs before any guard so host-fatal clicks,
  // which carry no routing target, still bring PiAbyss up.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    win.show();
    win.unminimize();
    win.setFocus();
  } catch {
    // Non-Tauri environment: nothing to surface.
  }
  useAppStore.getState().setPage("chat");
  if (!target.workspacePath) return;

  const outcome = await openSessionAcrossWorkspaces(
    {
      cwd: target.workspacePath,
      sessionPath: target.sessionPath,
      sessionId: target.sessionId,
      archived: target.archived,
    },
    { resolveSessionPath: resolveNotificationSessionPath },
  );
  if (outcome.status === "archived") {
    useAppStore.getState().pushNotification(tCurrent("globalSearchArchivedRestoreHint"), "info");
    return;
  }
  if (outcome.status !== "opened" && outcome.status !== "already-active") return;

  const current = useAppStore.getState();
  // The completed run left an unacknowledged sidebar marker; opening the
  // session from the notification counts as having seen it. A missing local
  // marker (cross-workspace notifications carry no workspaceId and never
  // create one) is fine: the unconditional Host-pool acknowledge below stops
  // a later activity snapshot from re-opening it across generations.
  const { workspaceId, sessionId } = target;
  const marker =
    workspaceId && sessionId ? current.sessionTerminalStates[workspaceId]?.[sessionId] : undefined;
  if (marker && !marker.acknowledged && workspaceId && sessionId) {
    current.acknowledgeSessionTerminalState(workspaceId, sessionId, marker.state);
  }
  if (target.sessionId) {
    void acknowledgeSessionTerminal(target.workspacePath, target.sessionId);
  }
}

export function handleHostEvent(
  event: HostEventEnvelope,
  requestRecovery: (reason: string) => void,
  agentEventBuffer: {
    enqueue: (event: HostEventEnvelope<"agent.event">) => void;
    flush: () => void;
  },
): boolean {
  const store = useAppStore.getState();
  const lifecycleEvent = event.event === "host.statusChanged" || event.event === "host.fatal";
  if ((store.rehydrating || store.desynchronized) && !lifecycleEvent) return false;

  if (!isSyntheticLifecycleFatal(event)) {
    const seqAction = store.noteSequence(event.sequence);
    if (seqAction === "drop") return false;
    if (seqAction === "gap") {
      requestRecovery(`sequence gap at ${event.sequence}`);
      return false;
    }
  }

  const hostId = store.host?.hostInstanceId ?? hostClient.getHostInstanceId();
  if (
    !lifecycleEvent &&
    !hostClient.shouldAcceptEvent(
      event,
      expectedIdentityForEvent(event, {
        hostInstanceId: hostId,
        workspaceId: store.workspace?.id ?? null,
        workspaceRevision: store.workspace?.revision,
        sessionId: store.session?.sessionId ?? null,
        sessionRevision: store.session?.revision,
      }),
    )
  ) {
    store.markDesynchronized(`identity mismatch for ${event.event}`);
    requestRecovery(`identity mismatch for ${event.event}`);
    return false;
  }

  const bufferableMessageUpdate =
    event.event === "agent.event" && event.payload.event.type === "message_update";
  if (!bufferableMessageUpdate) agentEventBuffer.flush();

  switch (event.event) {
    case "host.ready": {
      store.beginHostEpoch(event.payload);
      store.setHostFatal(null);
      store.setConnecting(false);
      break;
    }
    case "host.statusChanged": {
      store.setHost(event.payload);
      break;
    }
    case "host.fatal": {
      const message = event.payload.error?.message ?? "Host fatal";
      const summary = summarizeHostFailure(message);
      console.error("[pi-host] fatal", message);
      store.settleHostFailure(summary);
      store.pushNotification(tCurrent("notifHostUnavailable", { summary }), "error");
      break;
    }
    case "workspace.changed":
      if (
        event.payload.id !== event.workspaceId ||
        event.payload.revision !== event.workspaceRevision
      ) {
        requestRecovery("workspace.changed payload generation mismatch");
        return false;
      }
      store.applyWorkspaceSnapshot(event.payload);
      break;
    case "session.snapshot":
      if (
        (event.payload === null && event.sessionId !== null) ||
        (event.payload !== null &&
          (event.payload.sessionId !== event.sessionId ||
            event.payload.revision !== event.sessionRevision))
      ) {
        requestRecovery("session.snapshot payload generation mismatch");
        return false;
      }
      store.applySessionSnapshot(event.payload);
      break;
    case "session.runtimeChanged":
      if (
        event.payload.sessionId !== event.sessionId ||
        event.payload.sessionRevision !== event.sessionRevision
      ) {
        requestRecovery("session.runtimeChanged payload generation mismatch");
        return false;
      }
      store.setSessionRuntimeState(
        event.payload.sessionId,
        event.payload.state,
        event.payload.error,
        event.payload.updatedAt,
      );
      acknowledgeHostTerminalIfFocused(event.payload.sessionId, event.payload.state);
      break;
    case "agent.toolsChanged": {
      const action = classifyToolSnapshot(store.tools, event.payload);
      if (
        event.payload.workspaceId !== event.workspaceId ||
        event.payload.sessionId !== event.sessionId ||
        event.payload.sessionRevision !== event.sessionRevision ||
        action === "recover"
      ) {
        requestRecovery("agent.toolsChanged payload generation mismatch");
        return false;
      }
      if (action === "apply") {
        store.setTools(event.payload);
      }
      break;
    }
    case "package.snapshot":
      if (
        event.payload.workspaceId !== event.workspaceId ||
        event.payload.revision !== event.packageRevision
      ) {
        requestRecovery("package.snapshot payload generation mismatch");
        return false;
      }
      store.applyPackageSnapshot(event.payload);
      break;
    case "package.resourcesChanged":
      if (
        event.payload.packages.workspaceId !== event.workspaceId ||
        event.payload.packages.revision !== event.packageRevision ||
        (event.payload.session !== undefined &&
          (event.payload.session.sessionId !== event.sessionId ||
            event.payload.session.revision !== event.sessionRevision))
      ) {
        requestRecovery("package.resourcesChanged payload generation mismatch");
        return false;
      }
      store.applyPackageSnapshot(event.payload.packages);
      if (event.payload.session) {
        store.applySessionSnapshot(event.payload.session);
      }
      break;
    case "package.progress":
      store.setPackageProgress({
        ...event.payload,
        lastEventAt: Date.now(),
      });
      break;
    case "extensionUi.request":
      if (!event.sessionId) {
        requestRecovery("extensionUi.request missing session identity");
        return false;
      }
      const extensionRequest = {
        ...event.payload,
        expiresAt: event.payload.timeoutMs ? Date.now() + event.payload.timeoutMs : undefined,
        context: {
          expectedHostInstanceId: event.hostInstanceId,
          expectedWorkspaceId: event.workspaceId,
          expectedWorkspaceRevision: event.workspaceRevision,
          expectedSessionId: event.sessionId,
          expectedSessionRevision: event.sessionRevision,
        },
      };
      const delivery = extensionUiRequestDelivery({
        eventSessionId: event.sessionId,
        activeSessionId: store.session?.sessionId ?? null,
        catalogRuntimeState: store.sessionCatalog.entries[event.sessionId]?.runtimeState,
      });
      if (delivery === "background") {
        store.enqueueExtensionUiRequest(extensionRequest);
      } else if (delivery === "candidate") {
        store.presentCandidateExtensionUiRequest(extensionRequest);
      } else {
        store.setExtensionUiRequest(extensionRequest);
      }
      break;
    case "extensionUi.closed":
      if (!event.sessionId) {
        requestRecovery("extensionUi.closed missing session identity");
        return false;
      }
      store.closeExtensionUiRequest(
        event.payload.requestId,
        event.payload.reason === "aborted"
          ? "cancelled"
          : event.payload.reason === "timed-out"
            ? "expired"
            : "stale",
      );
      break;
    case "extensionUi.groupClosed":
      if (!event.sessionId) {
        requestRecovery("extensionUi.groupClosed missing session identity");
        return false;
      }
      store.closeExtensionDecisionGroup(event.payload.groupKey, event.payload.status);
      break;
    case "extensionUi.statusChanged":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionStatus(event.payload.key, event.payload.text ?? "");
      }
      break;
    case "extensionUi.widgetChanged":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionWidget({
          key: event.payload.key ?? "default",
          widget: event.payload.widget,
          ...(event.payload.placement ? { placement: event.payload.placement } : {}),
          hostInstanceId: event.hostInstanceId,
          workspaceId: event.workspaceId,
          workspaceRevision: event.workspaceRevision,
          sessionId: event.sessionId,
          sessionRevision: event.sessionRevision,
        });
      }
      break;
    case "extensionUi.widgetAttentionRequested":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.requestExtensionWidgetAttention(event.payload.runId, event.payload.key);
      }
      break;
    case "extensionUi.messageRendered":
      if (
        event.sessionId === store.session?.sessionId &&
        event.sessionRevision === store.session?.revision
      ) {
        store.setExtensionMessageRender(event.payload.entryId, event.payload.render);
      }
      break;
    case "extensionUi.notification":
      store.pushNotification(event.payload.message ?? "", event.payload.level ?? "info");
      break;
    case "extensionUi.customStarted":
      if (!event.sessionId) {
        requestRecovery("extensionUi.customStarted missing session identity");
        return false;
      }
      store.openExtensionTerminal({
        requestId: event.payload.requestId,
        title: event.payload.title,
        cols: event.payload.cols,
        rows: event.payload.rows,
        context: {
          expectedHostInstanceId: event.hostInstanceId,
          expectedWorkspaceId: event.workspaceId,
          expectedWorkspaceRevision: event.workspaceRevision,
          expectedSessionId: event.sessionId,
          expectedSessionRevision: event.sessionRevision,
        },
      });
      break;
    case "extensionUi.customFrame":
      pushExtensionTerminalFrame(event.payload.requestId, event.payload.data);
      break;
    case "extensionUi.customClosed":
      clearExtensionTerminalFrames(event.payload.requestId);
      store.closeExtensionTerminal(event.payload.requestId);
      break;
    case "model.changed":
      applyModelChanged(event.payload);
      break;
    case "provider.loginEvent":
      store.applyProviderLoginEvent(event.payload);
      break;
    case "session.infoChanged": {
      store.updateSessionCatalogInfo(event.payload.sessionId, event.payload.name);
      const currentSession = store.session;
      if (currentSession?.sessionId === event.payload.sessionId) {
        store.applySessionSnapshot({
          ...currentSession,
          name: event.payload.name,
        });
      }
      break;
    }
    case "package.diagnostic":
      store.pushNotification(event.payload.message, event.payload.severity);
      break;
    case "agent.event": {
      if (bufferableMessageUpdate) {
        agentEventBuffer.enqueue(event);
        break;
      }
      const cur = useAppStore.getState().session;
      if (!cur || event.sessionId !== cur.sessionId || event.sessionRevision !== cur.revision) {
        break;
      }
      const next = applyAgentEvent(cur, event.payload);
      if (next) useAppStore.getState().applySessionSnapshot(next);
      if (event.payload.event.type === "error" && event.sessionId) {
        const rawError = event.payload.event.error;
        const message =
          typeof rawError === "string"
            ? rawError
            : typeof event.payload.event.message === "string"
              ? event.payload.event.message
              : "Agent error";
        useAppStore.getState().setSessionRuntimeState(event.sessionId, "error", message);
        acknowledgeHostTerminalIfFocused(event.sessionId, "error");
        useAppStore
          .getState()
          .pushNotification(tCurrent("notifSessionFailed", { message }), "error");
      }
      break;
    }
    case "agent.queueChanged": {
      const cur = useAppStore.getState().session;
      if (cur && event.payload.revision >= cur.pending.revision) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          pending: {
            revision: event.payload.revision,
            steering: event.payload.steering ?? cur.pending.steering,
            followUp: event.payload.followUp ?? cur.pending.followUp,
          },
        });
      }
      break;
    }
    case "agent.compactionChanged": {
      const cur = useAppStore.getState().session;
      if (cur) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          isCompacting: Boolean(event.payload.active),
          isIdle: event.payload.active ? false : cur.isIdle,
        });
      }
      break;
    }
    case "subagents.statusChanged":
      store.setSubagentsStatus(event.payload);
      break;
    case "agent.retryChanged": {
      const cur = useAppStore.getState().session;
      if (cur) {
        useAppStore.getState().applySessionSnapshot({
          ...cur,
          isRetrying: Boolean(event.payload.active),
          isIdle: event.payload.active ? false : cur.isIdle,
        });
      }
      break;
    }
    default:
      break;
  }
  return true;
}

export function App() {
  const t = useT();
  const windowControlsPlatform = resolveWindowControlsPlatform();
  const nativeWindowAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [windowFrameMode, setWindowFrameMode] = useState<WindowFrameMode>("floating");
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? "");
  const sessionId = useAppStore((s) => s.session?.sessionId ?? "");
  const sessionRevision = useAppStore((s) => s.session?.revision ?? 0);
  const workspacePath = useAppStore((s) => s.workspace?.canonicalCwd);
  const activeSessionPath = useAppStore((s) => s.session?.sessionPath);
  const startupSettled = desktopSettings !== null && !connecting && !rehydrating && !desynchronized;
  const startupPhase = useInitialStartupScreen(startupSettled);
  const startupVisible = startupPhase !== "complete";
  const startupStage = resolveStartupStage({
    settingsReady: desktopSettings !== null,
    hostReady: hostInstanceId !== "",
    workspaceReady: Boolean(workspacePath),
    sessionReady: sessionId !== "",
    connecting,
    rehydrating,
    desynchronized,
  });

  useEffect(() => {
    let unsub = () => {};
    let unsubTransportError = () => {};
    let cancelPendingAgentEvents = () => {};
    let cancelled = false;
    let unsubscribeMainFocus = () => {};
    let mainFocusKnown = false;
    let mainFocused = false;
    let visibility: DocumentVisibilityState = document.visibilityState;
    const attention = () => {
      if (visibility === "hidden") return "background" as const;
      // Until the first authoritative window state arrives, stay silent
      // instead of risking noise. The async baseline below also covers the
      // login-launch path where the window starts hidden and no focus event
      // ever fires.
      if (!mainFocusKnown) return "unknown" as const;
      return mainFocused ? ("foreground" as const) : ("background" as const);
    };
    const systemNotifications = new SystemNotificationController({
      enabled: () => useAppStore.getState().desktopSettings?.systemNotificationsEnabled ?? true,
      attention,
      targetForSession: (sessionId, event) => {
        const current = useAppStore.getState();
        const catalog = current.sessionCatalog.entries[sessionId];
        const active = current.session?.sessionId === sessionId ? current.session : null;
        const sessionCwd = active?.cwd ?? catalog?.cwd;
        const sessionPath = active?.sessionPath ?? catalog?.sessionPath;
        const sessionName = active?.name ?? catalog?.name;
        return {
          workspaceId: event.workspaceId,
          workspaceRevision: event.workspaceRevision,
          ...(sessionCwd ? { workspacePath: sessionCwd } : {}),
          sessionId,
          ...(sessionPath ? { sessionPath } : {}),
          ...(event.sessionRevision !== undefined
            ? { sessionRevision: event.sessionRevision }
            : {}),
          ...(sessionName ? { sessionName } : {}),
          ...(catalog?.archived ? { archived: true } : {}),
        };
      },
      openTarget: openSystemNotificationTarget,
    });
    void systemNotifications.start();
    const onVisibilityChange = () => {
      visibility = document.visibilityState;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (cancelled) return;
        const win = getCurrentWindow();
        const unlisten = await win.onFocusChanged(({ payload: focused }) => {
          mainFocusKnown = true;
          mainFocused = focused;
        });
        if (cancelled) {
          unlisten();
          return;
        }
        unsubscribeMainFocus = unlisten;
        // Baseline for windows that never gained focus (login-launch hidden
        // in the tray): hidden or visible-but-unfocused both mean background.
        // A real focus event supersedes this snapshot.
        const [visible, focused] = await Promise.all([win.isVisible(), win.isFocused()]);
        if (cancelled || mainFocusKnown) return;
        mainFocusKnown = true;
        mainFocused = Boolean(visible && focused);
      })
      .catch(() => undefined);
    // Cross-workspace completions never reach the event stream (background
    // Host stdout is not routed to the renderer); the pool activity snapshot
    // is the only seam. Priming is silent — see ActivityNotificationObserver.
    const activityObserver = new ActivityNotificationObserver({
      isActiveWorkspace: (cwd) =>
        activityPathKey(useAppStore.getState().workspace?.canonicalCwd ?? "") ===
        activityPathKey(cwd),
      attention,
      enabled: () => useAppStore.getState().desktopSettings?.systemNotificationsEnabled ?? true,
      notify: (candidate) => systemNotifications.deliver(candidate),
    });
    void activityObserver.refresh();

    (async () => {
      const store = useAppStore.getState();
      store.setConnecting(true);
      try {
        const browserDefaults = {
          theme: "dark" as const,
          themeFamily: "piabyss" as const,
          restoreLastSession: false,
          autoStartOnBoot: false,
          systemNotificationsEnabled: true,
          autoRestartHostOnce: false,
          extensionDecisionPresentation: "auto" as const,
          terminalProfile: "auto" as const,
        };
        try {
          const { invoke, isTauri } = await import("@tauri-apps/api/core");
          if (!isTauri()) {
            store.setDesktopSettings(browserDefaults);
            applyTheme(browserDefaults.theme, { family: browserDefaults.themeFamily });
            applyAppearancePreferences(browserDefaults);
          } else {
            const snapshot = await invoke<DesktopSettingsSnapshot>("desktop_settings_get");
            if (!cancelled && snapshot.settings) {
              store.setDesktopSettings(snapshot.settings);
              applyTheme(snapshot.settings.theme, { family: snapshot.settings.themeFamily });
              applyAppearancePreferences(snapshot.settings);
              if (snapshot.warning) {
                store.pushNotification(
                  snapshot.recoveredFrom
                    ? `${snapshot.warning}. ${tCurrent("notifBackupFrom", { path: snapshot.recoveredFrom })}`
                    : snapshot.warning,
                  "warning",
                );
              }
            }
          }
        } catch (error) {
          store.setDesktopSettings(browserDefaults);
          applyTheme(browserDefaults.theme, { family: browserDefaults.themeFamily });
          applyAppearancePreferences(browserDefaults);
          if (nativeWindowAvailable) {
            store.pushNotification(
              tCurrent("notifDesktopSettingsLoadFailed", {
                error: error instanceof Error ? error.message : String(error),
              }),
              "error",
            );
          }
        }

        const transport = await createTauriTransport();
        if (cancelled) {
          // Effect already cleaned up (StrictMode/HMR unmount) — release the
          // native listeners instead of attaching an orphaned transport.
          transport.dispose?.();
          return;
        }

        let agentEventFrame: number | null = null;
        let pendingAgentEvents: TimedAgentEventEnvelope[] = [];

        const flushAgentEvents = () => {
          if (agentEventFrame !== null) {
            window.cancelAnimationFrame(agentEventFrame);
            agentEventFrame = null;
          }
          if (pendingAgentEvents.length === 0) return;
          const current = useAppStore.getState();
          const currentIdentity = current.host
            ? {
                ...current.host,
                workspaceId: current.workspace?.id ?? current.host.workspaceId,
                workspaceRevision: current.workspace?.revision ?? current.host.workspaceRevision,
                sessionId: current.session?.sessionId ?? current.host.sessionId,
                sessionRevision: current.session?.revision ?? current.host.sessionRevision,
                packageRevision: current.packages?.revision ?? current.host.packageRevision,
              }
            : null;
          const batch = currentIdentity
            ? pendingAgentEvents.filter((event) =>
                matchesTimedAgentEventIdentity(event, currentIdentity),
              )
            : [];
          pendingAgentEvents = [];
          const currentSession = current.session;
          const nextSession = applyAgentEventBatch(currentSession, batch);
          if (nextSession) useAppStore.getState().applySessionSnapshot(nextSession);
        };

        const cancelAgentEvents = () => {
          if (agentEventFrame !== null) {
            window.cancelAnimationFrame(agentEventFrame);
            agentEventFrame = null;
          }
          pendingAgentEvents = [];
        };
        cancelPendingAgentEvents = cancelAgentEvents;

        const agentEventBuffer = {
          enqueue: (event: HostEventEnvelope<"agent.event">) => {
            pendingAgentEvents.push({
              hostInstanceId: event.hostInstanceId,
              workspaceId: event.workspaceId,
              workspaceRevision: event.workspaceRevision,
              sessionId: event.sessionId,
              sessionRevision: event.sessionRevision,
              packageRevision: event.packageRevision,
              sequence: event.sequence,
              payload: event.payload,
              receivedAt: Date.now(),
            });
            if (agentEventFrame !== null) return;
            agentEventFrame = window.requestAnimationFrame(() => {
              agentEventFrame = null;
              flushAgentEvents();
            });
          },
          flush: flushAgentEvents,
        };
        const recoveryEvents = new RecoveryEventBuffer();

        let pendingRecoveryHostId: string | "bootstrap" | null = null;
        let recoveryLoop: Promise<void> | null = null;

        const scheduleRecovery = (hostId: string | null, reason: string) => {
          const target = hostId ?? "bootstrap";
          pendingRecoveryHostId = target;
          if (recoveryLoop) return;

          recoveryLoop = (async () => {
            while (!cancelled && pendingRecoveryHostId) {
              const expectedHostId = pendingRecoveryHostId;
              pendingRecoveryHostId = null;
              const epochStore = useAppStore.getState();
              epochStore.setConnecting(true);
              hostClient.rejectAllPending(reason);

              let lastError: unknown;
              // Restoring lastSessionPath is startup/restart semantics: only a
              // pass that found the Host without a workspace (fresh boot or
              // watchdog restart) may re-open it. A recovery against a live
              // Host keeps that Host's current session authoritative.
              let sessionRestoreEligible = false;
              for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
                try {
                  const configuredPresentation =
                    useAppStore.getState().desktopSettings?.extensionDecisionPresentation ?? "auto";
                  const status = await hostClient.hello(
                    "piabyss",
                    await getAppVersion(),
                    configuredPresentation,
                  );
                  if (expectedHostId !== "bootstrap" && status.hostInstanceId !== expectedHostId) {
                    throw new Error("Host generation changed during hello");
                  }
                  if (!status.workspaceId) sessionRestoreEligible = true;
                  useAppStore.getState().beginHostEpoch(status);
                  const configuredSettings = useAppStore.getState().desktopSettings;
                  const configuredWorkspace = fileWorkspaceForRecovery(
                    configuredSettings?.defaultWorkspace ?? configuredSettings?.lastWorkspace,
                  );
                  const sessionPathToRestore = configuredSettings?.restoreLastSession
                    ? configuredSettings.lastSessionPath
                    : undefined;
                  if (!status.workspaceId && configuredWorkspace) {
                    const selected = await hostClient.request(
                      "workspace.setCurrent",
                      {
                        expectedHostInstanceId: status.hostInstanceId,
                        expectedWorkspaceId: null,
                        expectedWorkspaceRevision: status.workspaceRevision,
                      },
                      { cwd: configuredWorkspace },
                      180_000,
                    );
                    if (!selected.ok) {
                      throw new Error(selected.error.message);
                    }
                    useAppStore.getState().setHost({
                      ...status,
                      workspaceId: selected.workspaceId,
                      workspaceRevision: selected.workspaceRevision,
                      sessionId: selected.sessionId,
                      sessionRevision: selected.sessionRevision,
                      packageRevision: selected.packageRevision,
                    });
                  }
                  const recovered = await runFullRehydrate(
                    status.hostInstanceId,
                    recoveryEvents,
                    requestRecovery,
                    agentEventBuffer,
                  );
                  if (!recovered) {
                    lastError = new Error("Host recovery was superseded by a newer recovery");
                    break;
                  }
                  const hydrated = useAppStore.getState();
                  if (
                    sessionPathToRestore &&
                    (sessionRestoreEligible || !hydrated.session) &&
                    hydrated.host &&
                    hydrated.workspace?.servicesReady &&
                    hydrated.session?.sessionPath !== sessionPathToRestore
                  ) {
                    const restoreContext = nullableSessionContext(
                      hydrated.host,
                      hydrated.workspace,
                    );
                    const restored = await requestSessionOpenWithRetry(
                      () =>
                        hostClient.request(
                          "session.open",
                          restoreContext,
                          { sessionPath: sessionPathToRestore },
                          180_000,
                        ),
                      undefined,
                      () => {
                        const current = useAppStore.getState();
                        return (
                          !cancelled &&
                          current.host?.hostInstanceId === restoreContext.expectedHostInstanceId &&
                          current.workspace?.id === restoreContext.expectedWorkspaceId &&
                          current.workspace?.revision ===
                            restoreContext.expectedWorkspaceRevision &&
                          // The restore decision was made against this session
                          // generation; once it moves, re-evaluate instead of
                          // re-sending a context the Host must reject.
                          current.host?.sessionId === restoreContext.expectedSessionId &&
                          current.host?.sessionRevision === restoreContext.expectedSessionRevision
                        );
                      },
                    );
                    if (!restored) {
                      lastError = new Error("Session restore was superseded during recovery");
                      continue;
                    }
                    if (restored.ok) {
                      const currentHost = useAppStore.getState().host;
                      if (currentHost) {
                        const nextHost = mergeHostIdentity(currentHost, restored);
                        if (nextHost) useAppStore.getState().setHost(nextHost);
                      }
                      const restoredRecovery = await runFullRehydrate(
                        restored.hostInstanceId,
                        recoveryEvents,
                        requestRecovery,
                        agentEventBuffer,
                      );
                      if (!restoredRecovery) {
                        lastError = new Error("Host recovery was superseded after session restore");
                        break;
                      }
                    } else if (restored.error.code === "SESSION_NOT_FOUND") {
                      await persistDesktopSettings({ lastSessionPath: null });
                    } else if (restored.error.code === "STALE_REVISION") {
                      // Another mutation committed between the rehydrate
                      // snapshot and this open (e.g. an orphaned session.open
                      // from the pre-recovery epoch). Re-run the attempt
                      // against fresh Host state instead of surfacing it.
                      lastError = new Error(
                        `Session restore raced a newer session change: ${restored.error.message}`,
                      );
                      continue;
                    } else {
                      useAppStore.getState().pushNotification(
                        tCurrent("notifRestoreSessionFailed", {
                          message: restored.error.message,
                        }),
                        "warning",
                      );
                    }
                  }
                  useAppStore.getState().setHostFatal(null);
                  useAppStore.getState().setConnecting(false);
                  lastError = null;
                  break;
                } catch (err) {
                  lastError = err;
                  if (pendingRecoveryHostId) break;
                  await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
                }
              }

              if (lastError && !pendingRecoveryHostId && !cancelled) {
                const message = lastError instanceof Error ? lastError.message : String(lastError);
                // Recovery gave up: settle into the terminal failure state so
                // the startup screen lifts (desynchronized would otherwise pin
                // startupSettled=false forever) and the fatal panel's
                // Settings → Restart Host path becomes reachable.
                useAppStore.getState().settleHostFailure(message);
                // The initial bootstrap recovery is a startup race, not a
                // product failure: the Host is still booting and the live
                // `host.ready` event (or a subsequent recovery) takes over as
                // soon as it appears. Only surface a toast for recoveries that
                // happen after the app settled, and never leak the internal
                // "bootstrap hello" reason string into the UI.
                if (reason !== "bootstrap hello") {
                  useAppStore
                    .getState()
                    .pushNotification(tCurrent("notifHostRecoveryFailed", { message }), "error");
                }
              }
            }
          })().finally(() => {
            recoveryLoop = null;
            if (!cancelled && pendingRecoveryHostId) {
              scheduleRecovery(
                pendingRecoveryHostId === "bootstrap" ? null : pendingRecoveryHostId,
                reason,
              );
            }
          });
        };

        const requestRecovery = (reason: string) => {
          cancelAgentEvents();
          useAppStore.getState().markDesynchronized(reason);
          scheduleRecovery(hostClient.getHostInstanceId(), reason);
        };

        let transportRepair: Promise<void> | null = null;
        const repairTransport = (transportError: Error) => {
          if (transportRepair || cancelled) return;
          cancelAgentEvents();
          const failureReason = `Host transport failed: ${transportError.message}`;
          const currentStore = useAppStore.getState();
          currentStore.markDesynchronized(failureReason);
          currentStore.setConnecting(true);
          hostClient.rejectAllPending(failureReason);
          transportRepair = (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const running = await invoke<boolean>("pi_host_status");
              if (!running) await invoke("pi_host_restart");
              scheduleRecovery(hostClient.getHostInstanceId(), failureReason);
            } catch (repairError) {
              const fullMessage =
                repairError instanceof Error ? repairError.message : String(repairError);
              const message = summarizeHostFailure(fullMessage);
              console.error("[pi-host] transport recovery failed", fullMessage);
              const latestStore = useAppStore.getState();
              latestStore.setHostFatal(message);
              latestStore.pushNotification(
                tCurrent("notifHostRecoveryFailed", { message }),
                "error",
              );
              latestStore.setConnecting(false);
            } finally {
              transportRepair = null;
            }
          })();
        };

        unsub = hostClient.onEvent((event) => {
          if (event.event === "host.ready") {
            cancelAgentEvents();
            recoveryEvents.cancel();
            systemNotifications.reset();
            scheduleRecovery(event.hostInstanceId, "host ready");
            return;
          }
          if (event.event === "host.fatal") {
            hostClient.rejectAllPending(event.payload.error.message);
          }
          if (recoveryEvents.capture(event)) return;
          if (handleHostEvent(event, requestRecovery, agentEventBuffer)) {
            publishValidatedHostEvent(event);
            systemNotifications.observe(event);
          }
        });
        unsubTransportError = hostClient.onTransportError(repairTransport);
        hostClient.attach(transport);
        await replayActiveHostReady();

        window.setTimeout(() => {
          if (!cancelled && !hostClient.getHostInstanceId()) {
            scheduleRecovery(null, "bootstrap hello");
          }
        }, 1500);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          store.setHostFatal(message);
          store.pushNotification(tCurrent("notifDesktopStartupFailed", { message }), "error");
          store.setConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelPendingAgentEvents();
      unsub();
      unsubTransportError();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeMainFocus();
      systemNotifications.dispose();
      activityObserver.dispose();
      hostClient.detach("application unmounted");
    };
  }, [nativeWindowAvailable]);

  useEffect(() => {
    if (desktopSettings?.theme) {
      applyTheme(desktopSettings.theme, { family: desktopSettings.themeFamily });
    }
  }, [desktopSettings?.theme, desktopSettings?.themeFamily]);

  useEffect(() => {
    applyLanguage(desktopSettings?.language);
  }, [desktopSettings?.language]);

  useEffect(() => {
    applyAppearancePreferences(desktopSettings);
  }, [desktopSettings]);

  useEffect(() => {
    if (!nativeWindowAvailable) return;

    let disposed = false;
    let pendingFrame: number | null = null;
    let stopListening = () => {};

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();

      const syncFrameMode = async () => {
        const [maximized, fullscreen] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isFullscreen(),
        ]);
        if (!disposed) setWindowFrameMode(resolveWindowFrameMode(maximized, fullscreen));
      };

      const scheduleFrameSync = () => {
        if (pendingFrame !== null) return;
        pendingFrame = window.requestAnimationFrame(() => {
          pendingFrame = null;
          void syncFrameMode().catch(() => undefined);
        });
      };

      const unlisten = await appWindow.onResized(scheduleFrameSync);
      if (disposed) {
        unlisten();
        return;
      }
      stopListening = unlisten;
      await syncFrameMode();
    })().catch(() => undefined);

    return () => {
      disposed = true;
      stopListening();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, [nativeWindowAvailable]);

  useEffect(() => {
    let cancelled = false;
    // Startup check is best-effort: offline or a bad feed stays silent, and
    // the manual check in Settings → Host surfaces errors instead.
    void checkForAppUpdate()
      .then((update) => {
        if (update && !cancelled) {
          const store = useAppStore.getState();
          if (
            store.appUpdatePhase.state !== "downloading" &&
            store.appUpdatePhase.state !== "installing"
          ) {
            store.setAppUpdatePhase({ state: "available", update });
          }
          store.pushNotification(tCurrent("notifUpdateAvailable", { version: update.version }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (connecting || rehydrating || desynchronized || !desktopSettings || !workspacePath) {
      return;
    }
    void persistRecentDesktopLocation(workspacePath, activeSessionPath ?? null).catch(
      notifyDesktopSettingsSaveFailure,
    );
  }, [connecting, rehydrating, desynchronized, desktopSettings, workspacePath, activeSessionPath]);

  // The sidebar collapse toggle moved into AppTopBar, so App owns the
  // sidebar.toggle command bus subscription that previously lived in Sidebar.
  useEffect(() => subscribeSidebarToggle(() => useAppStore.getState().toggleSidebar()), []);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-surface text-foreground"
      data-piabyss-app
      data-has-topbar
      data-window-platform={windowControlsPlatform}
      data-window-frame={resolveWindowFrameAttribute(nativeWindowAvailable, windowFrameMode)}
      data-host-instance-id={hostInstanceId}
      data-session-id={sessionId}
      data-session-revision={sessionRevision}
      data-rehydrating={rehydrating ? "true" : "false"}
      data-desynchronized={desynchronized ? "true" : "false"}
    >
      <DraftPersistenceController />
      <FileEditorDialogs />
      <SettingsTopBarActionsContext.Provider value={actionsEl}>
        <AppTopBar actionsSlotRef={setActionsEl} />
        <div className="flex min-h-0 flex-1" data-app-body>
          <Sidebar />
          <div className="flex min-h-0 flex-1" data-content-frame>
            <main className="relative flex min-w-0 flex-1 flex-col" data-content-main>
              {hostFatal ? (
                <div className="m-6 rounded-lg border border-danger/40 bg-danger/10 p-4">
                  <h2 className="mb-2 font-semibold text-danger">{t("hostUnavailableTitle")}</h2>
                  <p className="text-sm text-muted">{hostFatal}</p>
                  <p className="mt-2 text-xs text-muted">{t("hostUnavailableBody")}</p>
                </div>
              ) : page === "settings" ? (
                <SettingsPage
                  initialSection={settingsSection ?? "general"}
                  onClose={() => setPage("chat")}
                />
              ) : page === "packages" ? (
                <SettingsPage initialSection="packages" onClose={() => setPage("chat")} />
              ) : (
                <WorkspaceSwitchTransition>
                  <ChatPage />
                </WorkspaceSwitchTransition>
              )}
            </main>
            {page === "chat" && <RightDock />}
          </div>
        </div>
      </SettingsTopBarActionsContext.Provider>
      <ExtensionUiModal />
      <GlobalSearchHost />
      <CommandLayer />
      {startupVisible && (
        <StartupScreen stage={startupStage} exiting={startupPhase === "exiting"} />
      )}
    </div>
  );
}
