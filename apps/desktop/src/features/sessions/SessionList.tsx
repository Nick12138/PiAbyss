import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FileOutput,
  FolderOpen,
  MessageCircleQuestion,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { tCurrent, useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { deriveExtensionUiWaitingBySession } from "../../lib/stores/extension-ui-state";
import { hostClient } from "../../lib/bridge/host-client";
import { acknowledgeSessionTerminal } from "../../lib/bridge/tauri-transport";
import { isHostEpochError } from "../../lib/bridge/host-client";
import { notifyOperationFailure } from "../../lib/notify-operation-error";
import { persistDesktopSettings } from "../../lib/desktop-settings";
import {
  prioritizePinnedSessions,
  readPinnedSessionIds,
  writePinnedSessionIds,
} from "../../lib/session-pins";
import {
  captureRequestGeneration,
  activeSessionContext,
  isCurrentRequestGeneration,
  mergeHostIdentity,
  nullableSessionContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import {
  LatestSessionOpenQueue,
  requestSessionOpenWithRetry,
  SESSION_OPEN_TIMEOUT_MS,
} from "../../lib/bridge/session-open-request";
import { hostErrorLevel, localizeHostError } from "../../lib/bridge/localize-host-error";
import { sessionCatalogItems, type SessionCatalogEntry } from "../../lib/stores/session-catalog";
import { useImeComposition } from "../../lib/use-ime-composition";
import { createNewSession } from "../../lib/commands/actions";
import { sidebarJsonPref, setSidebarJsonPref } from "../../lib/sidebar-prefs";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { contextMenuTrigger, openContextMenu } from "../../lib/context-menu";
import { shouldKeepNativeContextMenu } from "../../lib/context-menu-policy";
import { requestExport } from "../../lib/export-actions";
import { deleteSessionDrafts } from "../../lib/draft-persistence";
import {
  canArchiveSession,
  canDeleteSession,
  canReloadSession,
  canRenameSession,
  filterSessionItems,
  groupSessionItemsByTime,
  removedArchivedSessionIds,
  requestSessionRpcWithRetry,
  sessionDisplayName,
  sessionStatusDotClass,
  sessionStatusLabelKey,
  shouldClearLastSessionPath,
  type SessionFilter,
  type SessionTimeGroup,
} from "./session-list-policy";

type SessionConfirmAction =
  { kind: "delete"; item: SessionCatalogEntry } | { kind: "cleanup"; count: number };

const SESSION_GROUPS_COLLAPSED_KEY = "piabyss.sidebar.sessionGroupsCollapsed.v1";

function sessionGroupLabelKey(group: SessionTimeGroup): "sessionsGroupToday" | "sessionsGroupThisWeek" | "sessionsGroupEarlier" {
  return group === "today"
    ? "sessionsGroupToday"
    : group === "thisWeek"
      ? "sessionsGroupThisWeek"
      : "sessionsGroupEarlier";
}

function acknowledgeVisitedSession(sessionId: string): void {
  const current = useAppStore.getState();
  const workspaceId = current.workspace?.id;
  const canonicalCwd = current.workspace?.canonicalCwd;
  if (!workspaceId || !canonicalCwd) return;
  const entry = current.sessionTerminalStates[workspaceId]?.[sessionId];
  const state =
    entry?.state ??
    (current.sessionCatalog.entries[sessionId]?.runtimeState === "error" ? "error" : undefined);
  if (state) current.acknowledgeSessionTerminalState(workspaceId, sessionId, state);
  // The Host is authoritative for cross-workspace markers. This is safe even
  // when no marker exists and covers a marker that has not reached the local
  // activity snapshot yet.
  void acknowledgeSessionTerminal(canonicalCwd, sessionId);
}

export function SessionList({
  showCreateAction = true,
  collapsed = false,
  onToggleCollapsed,
}: {
  showCreateAction?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const connecting = useAppStore((s) => s.connecting);
  const rehydrating = useAppStore((s) => s.rehydrating);
  const desynchronized = useAppStore((s) => s.desynchronized);
  const hostFatal = useAppStore((s) => s.hostFatal);
  const sessionCatalog = useAppStore((s) => s.sessionCatalog);
  const extensionUiRequest = useAppStore((s) => s.extensionUiRequest);
  const extensionUiQueue = useAppStore((s) => s.extensionUiQueue);
  const setSession = useAppStore((s) => s.applySessionSnapshot);
  const replaceSessionCatalog = useAppStore((s) => s.replaceSessionCatalog);
  const clearSessionCatalog = useAppStore((s) => s.clearSessionCatalog);
  const setSessionRuntimeState = useAppStore((s) => s.setSessionRuntimeState);
  const updateSessionCatalogInfo = useAppStore((s) => s.updateSessionCatalogInfo);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const sessionTerminalStates = useAppStore((s) => s.sessionTerminalStates);
  const acknowledgeSessionTerminalState = useAppStore((s) => s.acknowledgeSessionTerminalState);
  const removeSessionTerminalStates = useAppStore((s) => s.removeSessionTerminalStates);
  const [sessionMutationPending, setSessionMutationPending] = useState(false);
  const [sessionOpenPending, setSessionOpenPending] = useState(false);
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<SessionTimeGroup>>(
    () => new Set(sidebarJsonPref<SessionTimeGroup[]>(SESSION_GROUPS_COLLAPSED_KEY, [])),
  );
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmAction, setConfirmAction] = useState<SessionConfirmAction | null>(null);
  const [extensionUiExpiryTick, setExtensionUiExpiryTick] = useState(0);
  const ime = useImeComposition();
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() =>
    readPinnedSessionIds(useAppStore.getState().workspace?.id),
  );
  const sessionOpenBlocked = connecting || rehydrating || desynchronized || Boolean(hostFatal);
  const sessionMutationBlocked = sessionMutationPending || sessionOpenPending || sessionOpenBlocked;
  const refreshRequest = useRef(0);
  const mutationRequest = useRef(0);
  const itemsWorkspaceId = useRef<string | null>(null);
  const mounted = useRef(true);
  const performSessionOpenRef = useRef(performSessionOpen);
  performSessionOpenRef.current = performSessionOpen;
  const sessionOpenQueue = useRef<LatestSessionOpenQueue | null>(null);
  if (!sessionOpenQueue.current) {
    sessionOpenQueue.current = new LatestSessionOpenQueue(
      (path, isSuperseded) => performSessionOpenRef.current(path, isSuperseded),
      (running) => {
        if (mounted.current) setSessionOpenPending(running);
      },
      (error) => {
        notifyOperationFailure(error, tCurrent("notifOpenSessionFailed"));
      },
    );
  }

  const refresh = useCallback(async () => {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (!currentHost || !currentWorkspace?.servicesReady) {
      refreshRequest.current += 1;
      itemsWorkspaceId.current = null;
      clearSessionCatalog();
      return;
    }
    if (currentAtStart.connecting || currentAtStart.rehydrating || currentAtStart.desynchronized) {
      refreshRequest.current += 1;
      return;
    }
    if (itemsWorkspaceId.current !== currentWorkspace.id) {
      itemsWorkspaceId.current = currentWorkspace.id;
    }
    const request = ++refreshRequest.current;
    const expectedHostId = currentHost.hostInstanceId;
    const expectedWorkspaceId = currentWorkspace.id;
    const expectedWorkspaceRevision = currentWorkspace.revision;
    try {
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request("session.list", workspaceContext(currentHost, currentWorkspace), null),
      );
      const current = useAppStore.getState();
      if (
        request !== refreshRequest.current ||
        current.host?.hostInstanceId !== expectedHostId ||
        current.workspace?.id !== expectedWorkspaceId ||
        current.workspace?.revision !== expectedWorkspaceRevision
      ) {
        return;
      }
      if (res.ok) {
        itemsWorkspaceId.current = expectedWorkspaceId;
        replaceSessionCatalog(expectedWorkspaceId, res.result.items);
      }
    } catch {
      return;
    }
  }, [clearSessionCatalog, replaceSessionCatalog]);

  useEffect(() => {
    void refresh();
  }, [
    connecting,
    desynchronized,
    host?.hostInstanceId,
    refresh,
    rehydrating,
    workspace?.id,
    workspace?.revision,
    workspace?.servicesReady,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sessionOpenQueue.current?.clearPending();
    };
  }, []);

  useEffect(() => {
    // A recovery epoch (connecting/desynchronized/fatal) invalidates queued
    // intents and supersedes the running open, so its busy retries cannot
    // outlive the epoch and land on the Host after the recovery rehydrate.
    if (sessionOpenBlocked) sessionOpenQueue.current?.clearPending();
  }, [sessionOpenBlocked]);

  useEffect(() => {
    sessionOpenQueue.current?.clearPending();
    setPinnedSessionIds(readPinnedSessionIds(workspace?.id));
    setEditingSessionId(null);
    setNameDraft("");
  }, [workspace?.id]);

  // Returning to a session acknowledges its terminal (done/error) marker so it
  // stops showing in the sidebar. Error without a recorded marker (e.g. the app
  // restarted while the Host kept the session in error) is acknowledged too.
  // The Host pool is told as well so the workspace row's dot downgrades
  // (red → green → gray → none) as the user works through the sessions.
  useEffect(() => {
    if (session?.sessionId) acknowledgeVisitedSession(session.sessionId);
  }, [session?.sessionId, workspace?.id, acknowledgeSessionTerminalState]);

  useEffect(() => {
    const now = Date.now();
    const nextExpiry = [extensionUiRequest, ...extensionUiQueue]
      .flatMap((request) =>
        request?.expiresAt !== undefined && request.expiresAt > now ? [request.expiresAt] : [],
      )
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setExtensionUiExpiryTick((current) => current + 1),
      Math.max(0, nextExpiry - now) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [extensionUiExpiryTick, extensionUiQueue, extensionUiRequest]);

  async function createSession() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    try {
      await createNewSession();
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  /** Create and adopt a fresh session; false when it failed or the request was superseded. */
  async function requestFreshSession(request: number): Promise<boolean> {
    const { host: startHost, workspace: startWorkspace } = useAppStore.getState();
    if (!startHost || !startWorkspace) return false;
    const generation = captureRequestGeneration(startHost);
    const res = await requestSessionRpcWithRetry(() =>
      hostClient.request("session.create", nullableSessionContext(startHost, startWorkspace), {}),
    );
    // The create's own session.snapshot push may advance the session generation
    // before this response resolves, so only host and workspace are validated here.
    if (
      request !== mutationRequest.current ||
      !isCurrentRequestGeneration(useAppStore.getState().host, generation)
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
      return false;
    }
    // Reused-pristine creates return the already-active snapshot, and normal
    // creates push a session.snapshot event first — skip the duplicate apply.
    const appliedSession = useAppStore.getState().session;
    const alreadyApplied =
      appliedSession !== null &&
      appliedSession.sessionId === res.result.sessionId &&
      appliedSession.revision === res.result.revision;
    if (!alreadyApplied) setSession(res.result);
    const currentHost = useAppStore.getState().host;
    if (currentHost) {
      const nextHost = mergeHostIdentity(currentHost, res);
      if (nextHost) useAppStore.getState().setHost(nextHost);
    }
    return true;
  }

  function openSession(path: string) {
    const current = useAppStore.getState();
    if (!current.host || !current.workspace || sessionMutationPending || sessionOpenBlocked) {
      return;
    }
    if (current.page !== "chat") current.setPage("chat");
    if (!sessionOpenQueue.current?.isRunning() && current.session?.sessionPath === path) {
      acknowledgeVisitedSession(current.session.sessionId);
      return;
    }
    sessionOpenQueue.current?.enqueue(path);
  }

  async function performSessionOpen(path: string, isSuperseded: () => boolean): Promise<void> {
    const currentAtStart = useAppStore.getState();
    const currentHost = currentAtStart.host;
    const currentWorkspace = currentAtStart.workspace;
    if (
      !currentHost ||
      !currentWorkspace ||
      currentAtStart.connecting ||
      currentAtStart.rehydrating ||
      currentAtStart.desynchronized ||
      currentAtStart.session?.sessionPath === path
    ) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(currentHost);
    const target = sessionCatalogItems(currentAtStart.sessionCatalog).find(
      (item) => item.sessionPath === path,
    );
    try {
      const authorization = {
        expectedHostInstanceId: currentHost.hostInstanceId,
        expectedWorkspaceId: currentWorkspace.id,
        expectedWorkspaceRevision: currentWorkspace.revision,
      };
      const res = await requestSessionOpenWithRetry(
        () => {
          // The intent is "open this path"; the session generation is only an
          // optimistic-concurrency ticket. Re-read it each attempt so a busy
          // retry that follows another mutation's commit is not rejected as a
          // stale revision.
          const latest = useAppStore.getState().host;
          return hostClient.request(
            "session.open",
            {
              ...authorization,
              expectedSessionId: latest?.sessionId ?? null,
              expectedSessionRevision: latest?.sessionRevision ?? 0,
            },
            { sessionPath: path },
            SESSION_OPEN_TIMEOUT_MS,
          );
        },
        undefined,
        () => {
          const current = useAppStore.getState();
          return (
            !isSuperseded() &&
            current.host?.hostInstanceId === authorization.expectedHostInstanceId &&
            current.workspace?.id === authorization.expectedWorkspaceId &&
            current.workspace?.revision === authorization.expectedWorkspaceRevision
          );
        },
      );
      if (!res) return;
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        if (isSuperseded()) return;
        if (target && res.error?.retryable !== true) {
          setSessionRuntimeState(target.sessionId, "error", localizeHostError(res.error, t));
        }
        pushNotification(
          localizeHostError(res.error, t),
          res.error?.retryable === true ? "warning" : "error",
        );
        return;
      }
      // The Host already pushed this snapshot as a session.snapshot event before
      // the response resolved; applying it again would rebuild the transcript a
      // second time. Apply only when the event has not landed.
      const appliedSession = useAppStore.getState().session;
      const alreadyApplied =
        appliedSession !== null &&
        appliedSession.sessionId === res.result.sessionId &&
        appliedSession.revision === res.result.revision;
      if (!alreadyApplied) setSession(res.result);
      const latestHost = useAppStore.getState().host;
      if (latestHost) {
        const nextHost = mergeHostIdentity(latestHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
    } catch (error) {
      if (isSuperseded()) return;
      // Host-epoch rejections mean the open never committed; the recovery
      // loop rehydrates the session list, so stay silent here.
      if (isHostEpochError(error)) return;
      const message = error instanceof Error ? error.message : t("notifOpenSessionFailed");
      if (target) setSessionRuntimeState(target.sessionId, "error", message);
      pushNotification(message, "error");
    }
  }

  function beginRename(item: SessionCatalogEntry) {
    if (!canRenameSession(item, session) || sessionMutationBlocked) return;
    setEditingSessionId(item.sessionId);
    setNameDraft(sessionDisplayName(item, t("sessionsUntitled")));
  }

  function cancelRename() {
    setEditingSessionId(null);
    setNameDraft("");
  }

  async function renameSession() {
    if (!host || !workspace || !editingSessionId || sessionMutationBlocked) return;
    const item = sessionCatalogItems(sessionCatalog).find(
      (entry) => entry.sessionId === editingSessionId,
    );
    if (!item || !canRenameSession(item, session)) return;
    const name = nameDraft.trim();
    if (!name) {
      pushNotification(t("notifSessionNameEmpty"), "error");
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request("session.rename", workspaceContext(host, workspace), {
        sessionId: item.sessionId,
        sessionPath: item.sessionPath,
        name,
      });
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }
      updateSessionCatalogInfo(res.result.sessionId, res.result.name);
      if (res.result.session) setSession(res.result.session);
      cancelRename();
    } catch (error) {
      notifyOperationFailure(error, t("notifRenameFailed"));
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  function toggleGroupCollapsed(group: SessionTimeGroup) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      setSidebarJsonPref(SESSION_GROUPS_COLLAPSED_KEY, [...next]);
      return next;
    });
  }

  function togglePinnedSession(item: SessionCatalogEntry) {
    if (!workspace) return;
    setPinnedSessionIds((current) => {
      const next = current.includes(item.sessionId)
        ? current.filter((sessionId) => sessionId !== item.sessionId)
        : [...current, item.sessionId];
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
  }

  function removePinnedSessions(sessionIds: readonly string[]) {
    if (!workspace || sessionIds.length === 0) return;
    const removed = new Set(sessionIds);
    setPinnedSessionIds((current) => {
      const next = current.filter((sessionId) => !removed.has(sessionId));
      writePinnedSessionIds(workspace.id, next);
      return next;
    });
  }

  async function runSessionFileAction(
    method: "session.archive" | "session.restore",
    item: SessionCatalogEntry,
  ) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (method === "session.archive" && !canArchiveSession(item, currentSession)) {
      pushNotification(t("sessionsArchiveWait"), "warning");
      return;
    }
    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    try {
      if (
        method === "session.archive" &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const res = await requestSessionRpcWithRetry(() =>
        hostClient.request(method, workspaceContext(latestHost, latestWorkspace), {
          sessionId: item.sessionId,
          sessionPath: item.sessionPath,
        }),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }
      if (method === "session.archive") {
        const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
        if (lastSessionPath && shouldClearLastSessionPath(lastSessionPath, item.sessionPath)) {
          await persistDesktopSettings({ lastSessionPath: null });
        }
      }
      await refresh();
      if (method !== "session.archive") {
        pushNotification(t("notifSessionRestored"), "success");
      }
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionFileOpFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function deleteSessionPermanently(item: SessionCatalogEntry) {
    if (!host || !workspace || sessionMutationBlocked) return;
    const currentSession = useAppStore.getState().session;
    if (!canDeleteSession(item, currentSession)) {
      pushNotification(t("sessionsDeleteWait"), "warning");
      setConfirmAction(null);
      return;
    }

    const request = ++mutationRequest.current;
    setSessionMutationPending(true);
    try {
      if (
        !item.archived &&
        currentSession?.sessionId === item.sessionId &&
        !(await requestFreshSession(request))
      ) {
        return;
      }
      const { host: latestHost, workspace: latestWorkspace } = useAppStore.getState();
      if (!latestHost || !latestWorkspace) return;
      const generation = captureRequestGeneration(latestHost);
      const deleted = await requestSessionRpcWithRetry(() =>
        hostClient.request("session.delete", workspaceContext(latestHost, latestWorkspace), {
          sessionId: item.sessionId,
          sessionPath: item.sessionPath,
        }),
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!deleted.ok) {
        if (deleted.error?.code === "SESSION_NOT_FOUND") {
          deleteSessionDrafts(latestWorkspace.canonicalCwd, [item.sessionId]);
          await refresh();
          removePinnedSessions([item.sessionId]);
          removeSessionTerminalStates(latestWorkspace.id, [item.sessionId]);
          setConfirmAction(null);
          pushNotification(t("notifSessionGone"), "warning");
          return;
        }
        pushNotification(localizeHostError(deleted.error, t), hostErrorLevel(deleted.error));
        return;
      }

      deleteSessionDrafts(latestWorkspace.canonicalCwd, [item.sessionId]);

      const lastSessionPath = useAppStore.getState().desktopSettings?.lastSessionPath;
      if (lastSessionPath && shouldClearLastSessionPath(lastSessionPath, item.sessionPath)) {
        await persistDesktopSettings({ lastSessionPath: null });
      }
      await refresh();
      removePinnedSessions([item.sessionId]);
      removeSessionTerminalStates(latestWorkspace.id, [item.sessionId]);
      setConfirmAction(null);
      pushNotification(t("notifSessionDeleted"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionDeleteFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function cleanupArchivedSessions() {
    if (!host || !workspace || sessionMutationBlocked) return;
    const sessionsBeforeCleanup = sessionCatalogItems(useAppStore.getState().sessionCatalog);
    const cleanupWorkspace = {
      hostInstanceId: host.hostInstanceId,
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      canonicalCwd: workspace.canonicalCwd,
    };
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.cleanupArchived",
        workspaceContext(host, workspace),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }
      await refresh();
      const current = useAppStore.getState();
      if (
        request !== mutationRequest.current ||
        current.host?.hostInstanceId !== cleanupWorkspace.hostInstanceId ||
        current.workspace?.id !== cleanupWorkspace.workspaceId ||
        current.workspace?.revision !== cleanupWorkspace.workspaceRevision
      ) {
        return;
      }
      const removedSessionIds = removedArchivedSessionIds(
        sessionsBeforeCleanup,
        sessionCatalogItems(current.sessionCatalog),
      );
      deleteSessionDrafts(cleanupWorkspace.canonicalCwd, removedSessionIds);
      removePinnedSessions(removedSessionIds);
      removeSessionTerminalStates(cleanupWorkspace.workspaceId, removedSessionIds);
      setConfirmAction(null);
      pushNotification(
        res.result.failedCount > 0
          ? t("notifCleanupPartial", {
              deleted: res.result.deletedCount,
              failed: res.result.failedCount,
            })
          : t("notifCleanupDone", { deleted: res.result.deletedCount }),
        res.result.failedCount > 0 ? "warning" : "success",
      );
    } catch (error) {
      notifyOperationFailure(error, t("notifCleanupFailed"));
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  async function reloadSessionFromDisk() {
    if (!host || !workspace || !session || sessionMutationBlocked || !session.isIdle) {
      return;
    }
    const request = ++mutationRequest.current;
    const generation = captureRequestGeneration(host);
    setSessionMutationPending(true);
    try {
      const res = await hostClient.request(
        "session.reload",
        activeSessionContext(host, workspace, session),
        null,
      );
      if (
        request !== mutationRequest.current ||
        !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
          session: true,
        })
      ) {
        return;
      }
      if (!res.ok) {
        pushNotification(localizeHostError(res.error, t), hostErrorLevel(res.error));
        return;
      }
      setSession(res.result);
      const currentHost = useAppStore.getState().host;
      if (currentHost) {
        const nextHost = mergeHostIdentity(currentHost, res);
        if (nextHost) useAppStore.getState().setHost(nextHost);
      }
      pushNotification(t("notifSessionReloaded"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifSessionReloadFailed"),
        "error",
      );
    } finally {
      if (request === mutationRequest.current) setSessionMutationPending(false);
    }
  }

  const allItems = prioritizePinnedSessions(sessionCatalogItems(sessionCatalog), pinnedSessionIds);
  const visibleItems = filterSessionItems(allItems, filter);
  const groupedItems = groupSessionItemsByTime(visibleItems);
  const archivedCount = allItems.filter((item) => item.archived).length;
  const showArchivedToggle = archivedCount > 0 || filter === "archived";
  const extensionUiWaitingBySession = deriveExtensionUiWaitingBySession(
    extensionUiRequest,
    extensionUiQueue,
    Date.now(),
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-8 items-center justify-between px-2">
        {onToggleCollapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="session-list-region"
            title={collapsed ? t("sessionsExpand") : t("sessionsCollapse")}
            className="group flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-foreground"
          >
            <span>{t("sessionsRecent")}</span>
            <ChevronDown
              size={12}
              className={`opacity-0 transition-all group-hover:opacity-100 ${
                collapsed ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <span className="text-[13px] font-medium text-muted">{t("sessionsRecent")}</span>
        )}
        <div className="flex items-center gap-0.5">
          {filter === "archived" && archivedCount > 0 && (
            <button
              type="button"
              title={t("sessionsClearArchivedTitle", { count: archivedCount })}
              aria-label={t("sessionsClearArchivedAria")}
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-danger"
              onClick={() => setConfirmAction({ kind: "cleanup", count: archivedCount })}
              disabled={sessionMutationBlocked}
            >
              <Trash2 size={13} />
            </button>
          )}
          {showArchivedToggle && (
            <button
              type="button"
              aria-pressed={filter === "archived"}
              title={
                filter === "archived"
                  ? t("sessionsShowActiveTitle")
                  : t("sessionsShowArchivedTitle", { count: archivedCount })
              }
              aria-label={
                filter === "archived"
                  ? t("sessionsShowActiveTitle")
                  : t("sessionsShowArchivedTitle", { count: archivedCount })
              }
              className={`rounded p-1 transition-colors ${
                filter === "archived"
                  ? "bg-selection text-selection-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
              onClick={() => setFilter(filter === "archived" ? "active" : "archived")}
            >
              <Archive size={13} />
            </button>
          )}
          {showCreateAction && (
            <button
              type="button"
              title={t("sessionsNew")}
              className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => void createSession()}
              disabled={!workspace?.servicesReady || sessionMutationBlocked}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>
      <CollapsibleRegion open={!collapsed} id="session-list-region">
        <>
          {!workspace?.servicesReady && (
            <p className="px-1 text-xs text-muted">{t("sessionsSelectWorkspaceFirst")}</p>
          )}
          <div className="flex flex-col gap-2">
            {groupedItems.map(({ group, items }) =>
              items.length === 0 ? null : (
                <div key={group} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    aria-expanded={!collapsedGroups.has(group)}
                    aria-controls={`session-group-${group}`}
                    title={collapsedGroups.has(group) ? t("sessionsGroupExpand") : t("sessionsGroupCollapse")}
                    onClick={() => toggleGroupCollapsed(group)}
                    className="group flex min-w-0 items-center gap-1 px-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted transition-colors hover:text-foreground"
                  >
                    <span>{t(sessionGroupLabelKey(group))}</span>
                    <ChevronDown
                      size={12}
                      className={`opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100 ${
                        collapsedGroups.has(group) ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  <CollapsibleRegion open={!collapsedGroups.has(group)} id={`session-group-${group}`}>
                    <ul className="flex flex-col gap-0.5">
                    {items.map((item) => {
                      const active = !item.archived && session?.sessionId === item.sessionId;
                      const editing = editingSessionId === item.sessionId;
                      const pinned = pinnedSessionIds.includes(item.sessionId);
                      const canRename = canRenameSession(item, session);
                      const canDelete = canDeleteSession(item, session);
                      const canReload = canReloadSession(item, session);
                      const canArchive = canArchiveSession(item, session);
                      const terminalState = item.archived
                        ? undefined
                        : sessionTerminalStates[workspace?.id ?? ""]?.[item.sessionId];
                      const statusDot = item.archived
                        ? null
                        : sessionStatusDotClass(item.runtimeState, terminalState);
                      const statusLabelKey = item.archived
                        ? null
                        : sessionStatusLabelKey(item.runtimeState, terminalState);
                      const statusLabel = statusLabelKey ? t(statusLabelKey) : null;
                      const decisionWaiting = item.archived
                        ? undefined
                        : extensionUiWaitingBySession[item.sessionId];
                      const decisionWaitingLabel = decisionWaiting
                        ? t(
                            decisionWaiting.hasHighRisk
                              ? "sessionsDecisionWaitingHighRisk"
                              : "sessionsDecisionWaiting",
                            { count: decisionWaiting.count },
                          )
                        : undefined;
                      return (
                        <li
                          key={item.sessionId}
                          data-ui="nav-item"
                          data-state={active ? "active" : "inactive"}
                          className={`interface-density-nav-row group flex h-9 items-center rounded-md text-[13px] ${
                            active
                              ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                              : "hover:bg-surface-overlay/70"
                          }`}
                          onContextMenu={(event) => {
                            if (shouldKeepNativeContextMenu(event.nativeEvent)) return;
                            if (
                              event.target instanceof Element &&
                              event.target.closest("input, textarea, [contenteditable='true']")
                            ) {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            openContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              trigger: contextMenuTrigger(event.target),
                              items: [
                                {
                                  id: "session.open",
                                  label: t("menuOpenSession"),
                                  disabled:
                                    item.archived ||
                                    !item.sessionPath ||
                                    sessionMutationPending ||
                                    sessionOpenBlocked,
                                  onSelect: () => openSession(item.sessionPath),
                                },
                                {
                                  id: "session.rename",
                                  label: t("sessionsRename"),
                                  icon: Pencil,
                                  disabled: !canRename,
                                  onSelect: () => beginRename(item),
                                },
                                {
                                  id: "session.pin",
                                  label: pinned ? t("sessionsUnpin") : t("sessionsPin"),
                                  icon: pinned ? PinOff : Pin,
                                  onSelect: () => togglePinnedSession(item),
                                },
                                {
                                  id: "session.reload",
                                  label: t("sessionsReload"),
                                  icon: RefreshCw,
                                  disabled: !canReload,
                                  onSelect: () => void reloadSessionFromDisk(),
                                },
                                {
                                  id: item.archived ? "session.restore" : "session.archive",
                                  label: item.archived
                                    ? t("sessionsRestore")
                                    : t("sessionsArchive"),
                                  icon: item.archived ? ArchiveRestore : Archive,
                                  separatorBefore: true,
                                  disabled: !item.archived && !canArchive,
                                  onSelect: () =>
                                    runSessionFileAction(
                                      item.archived ? "session.restore" : "session.archive",
                                      item,
                                    ),
                                },
                                {
                                  id: "session.exportHtml",
                                  label: t("statsExportHtml"),
                                  icon: FileOutput,
                                  disabled: !active || !session?.isIdle,
                                  onSelect: () => requestExport("html"),
                                },
                                {
                                  id: "session.exportJsonl",
                                  label: t("statsExportJsonl"),
                                  icon: FileOutput,
                                  disabled: !active || !session?.isIdle,
                                  onSelect: () => requestExport("jsonl"),
                                },
                                {
                                  id: "session.reveal",
                                  label: t("menuRevealSession"),
                                  icon: FolderOpen,
                                  separatorBefore: true,
                                  onSelect: async () => {
                                    try {
                                      const { invoke } = await import("@tauri-apps/api/core");
                                      await invoke("desktop_open_path", {
                                        path: item.sessionPath,
                                        mode: "reveal",
                                      });
                                    } catch {
                                      pushNotification(t("sessionsRevealFailed"), "warning");
                                    }
                                  },
                                },
                                {
                                  id: "session.copyPath",
                                  label: t("menuCopySessionPath"),
                                  icon: Copy,
                                  onSelect: async () => {
                                    try {
                                      await navigator.clipboard.writeText(item.sessionPath);
                                      pushNotification(t("sessionsPathCopied"), "info");
                                    } catch {
                                      pushNotification(t("sessionsCopyPathFailed"), "warning");
                                    }
                                  },
                                },
                                {
                                  id: "session.delete",
                                  label: t("commonDelete"),
                                  icon: Trash2,
                                  danger: true,
                                  separatorBefore: true,
                                  disabled: !canDelete,
                                  onSelect: () => setConfirmAction({ kind: "delete", item }),
                                },
                              ],
                            });
                          }}
                        >
                          {editing ? (
                            <form
                              className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void renameSession();
                              }}
                            >
                              <input
                                autoFocus
                                aria-label={t("sessionsNameAria")}
                                value={nameDraft}
                                maxLength={120}
                                onChange={(event) => setNameDraft(event.target.value)}
                                onCompositionStart={ime.onCompositionStart}
                                onCompositionEnd={ime.onCompositionEnd}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && ime.isImeKey(event)) {
                                    event.preventDefault();
                                    return;
                                  }
                                  if (event.key === "Escape") cancelRename();
                                }}
                                className="h-7 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs text-foreground outline-none"
                              />
                              <button
                                type="submit"
                                title={t("sessionsSaveName")}
                                disabled={sessionMutationBlocked || !nameDraft.trim()}
                                className="rounded p-1 text-accent hover:bg-surface-overlay disabled:opacity-40"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                type="button"
                                title={t("sessionsCancelRename")}
                                onClick={cancelRename}
                                disabled={sessionMutationBlocked}
                                className="rounded p-1 text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                              >
                                <X size={14} />
                              </button>
                            </form>
                          ) : (
                            <>
                              <button
                                type="button"
                                aria-current={active ? "page" : undefined}
                                onClick={() => openSession(item.sessionPath)}
                                disabled={
                                  sessionMutationPending ||
                                  sessionOpenBlocked ||
                                  !item.sessionPath ||
                                  item.archived
                                }
                                className="min-w-0 flex-1 px-2.5 py-2 text-left"
                                title={
                                  item.runtimeState === "error" && item.lastError
                                    ? `${sessionDisplayName(item, t("sessionsUntitled"))} — ${item.lastError}`
                                    : sessionDisplayName(item, t("sessionsUntitled"))
                                }
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}
                                  >
                                    {sessionDisplayName(item, t("sessionsUntitled"))}
                                  </span>
                                  {decisionWaiting && decisionWaitingLabel ? (
                                    <span
                                      aria-label={decisionWaitingLabel}
                                      title={decisionWaitingLabel}
                                      data-session-decision-count={decisionWaiting.count}
                                      className={`ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] tabular-nums ${
                                        decisionWaiting.hasHighRisk
                                          ? "border-warning/40 bg-warning/10 text-warning"
                                          : "border-border bg-surface text-muted"
                                      }`}
                                    >
                                      {decisionWaiting.hasHighRisk ? (
                                        <CircleAlert size={11} aria-hidden="true" />
                                      ) : (
                                        <MessageCircleQuestion size={11} aria-hidden="true" />
                                      )}
                                      <span aria-hidden="true">{decisionWaiting.count}</span>
                                    </span>
                                  ) : null}
                                  {statusDot && (
                                    <span
                                      className="flex size-[9.2px] shrink-0 items-center justify-center"
                                      aria-label={statusLabel ?? undefined}
                                      title={statusLabel ?? undefined}
                                    >
                                      <span className={`size-[8.2px] rounded-full ${statusDot}`} />
                                    </span>
                                  )}
                                </div>
                              </button>
                              {pinned && (
                                <button
                                  type="button"
                                  title={t("sessionsUnpin")}
                                  aria-label={t("sessionsUnpin")}
                                  onClick={() => removePinnedSessions([item.sessionId])}
                                  className="mr-1 flex size-[22px] shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-foreground"
                                >
                                  <Pin size={12} aria-hidden="true" />
                                </button>
                              )}
                              {/* A session showing any status dot (live green/yellow or
                                  unacknowledged terminal red/gray) is not archivable
                                  right now — hide the action instead of offering a
                                  disabled button. Archived entries have no dot and
                                  keep their restore action. */}
                              {statusDot ? null : (
                                <div className="relative mr-1 flex size-[22px] shrink-0 items-center justify-center">
                                  <button
                                    type="button"
                                    title={
                                      item.archived
                                        ? t("sessionsRestoreTitle")
                                        : canArchive
                                          ? t("sessionsArchiveTitle")
                                          : t("sessionsArchiveWait")
                                    }
                                    aria-label={
                                      item.archived ? t("sessionsRestore") : t("sessionsArchive")
                                    }
                                    onClick={() =>
                                      void runSessionFileAction(
                                        item.archived ? "session.restore" : "session.archive",
                                        item,
                                      )
                                    }
                                    disabled={
                                      sessionMutationBlocked || (!item.archived && !canArchive)
                                    }
                                    className="pointer-events-none rounded p-1 text-muted opacity-0 transition-opacity hover:bg-surface hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:disabled:opacity-30 group-focus-within:disabled:opacity-30"
                                  >
                                    {item.archived ? (
                                      <ArchiveRestore size={14} />
                                    ) : (
                                      <Archive size={14} />
                                    )}
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                    </ul>
                  </CollapsibleRegion>
                </div>
              ),
            )}
          </div>
          {workspace?.servicesReady && allItems.length > 0 && visibleItems.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted">{t("sessionsNoMatch")}</p>
          )}
          {confirmAction &&
            createPortal(
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="session-delete-title"
                  className="theme-floating-surface w-full max-w-sm rounded-lg border border-border bg-surface-raised p-5 shadow-xl"
                >
                  <h2 id="session-delete-title" className="text-base font-semibold">
                    {confirmAction.kind === "delete"
                      ? t("sessionsDeleteConfirmTitle")
                      : t("sessionsCleanupConfirmTitle")}
                  </h2>
                  <p className="mt-2 text-sm text-muted">
                    {confirmAction.kind === "delete"
                      ? t("sessionsDeleteConfirmBody", {
                          name: sessionDisplayName(confirmAction.item, t("sessionsUntitled")),
                        })
                      : t("sessionsCleanupConfirmBody", { count: confirmAction.count })}
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      autoFocus
                      type="button"
                      className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-overlay"
                      onClick={() => setConfirmAction(null)}
                      disabled={sessionMutationBlocked}
                    >
                      {t("commonCancel")}
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-danger px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
                      onClick={() => {
                        if (confirmAction.kind === "delete") {
                          void deleteSessionPermanently(confirmAction.item);
                        } else {
                          void cleanupArchivedSessions();
                        }
                      }}
                      disabled={sessionMutationBlocked}
                    >
                      {t("sessionsDeletePermanently")}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )}
        </>
      </CollapsibleRegion>
    </div>
  );
}
