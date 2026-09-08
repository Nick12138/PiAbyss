import { hostClient } from "./host-client";
import {
  activateWorkspaceHost,
  prepareWorkspaceHost,
  rebindActiveWorkspaceHost,
  replayActiveHostReady,
} from "./tauri-transport";
import { mergeHostIdentity, workspaceContext } from "./host-context";
import { requestSessionOpenWithRetry, SESSION_OPEN_TIMEOUT_MS } from "./session-open-request";
import { hostErrorLevel, localizeHostError } from "./localize-host-error";
import { tCurrent } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";
import {
  isWorkspaceSwitchBusyError,
  waitForWorkspaceActivation,
  workspaceHasActiveAgent,
} from "../../features/workspaces/workspace-switch-policy";

/**
 * A cross-workspace "jump to this session" request shared by the global search
 * modal and the system-notification click router. Owns the full dedicated-Host
 * activation (or in-place `workspace.setCurrent` fallback) plus the guarded
 * `session.open` handshake, without any component-local UI state.
 */
export type SessionNavigationTarget = {
  cwd: string;
  sessionPath?: string;
  /** Present without sessionPath for cross-workspace system notifications. */
  sessionId?: string;
  archived?: boolean;
};

export type SessionNavigationOptions = {
  /**
   * Resolves the session path for targets that only know the sessionId.
   * Called after the target workspace's Host has become active, so the
   * resolver may query the now-active Host (e.g. via session.list).
   */
  resolveSessionPath?: (
    sessionId: string,
  ) => Promise<{ sessionPath: string; archived?: boolean } | null>;
};

export type SessionNavigationOutcome =
  /** The session is now the active conversation. */
  | { status: "opened" }
  /** The requested session was already the active conversation. */
  | { status: "already-active" }
  /** The target is an archived session; navigation intentionally stopped. */
  | { status: "archived" }
  /** App was connecting/rehydrating/desynchronized — silently gave up. */
  | { status: "blocked" }
  /** A failure occurred; it has already been surfaced via pushNotification. */
  | { status: "failed" };

export async function openSessionAcrossWorkspaces(
  target: SessionNavigationTarget,
  options: SessionNavigationOptions = {},
): Promise<SessionNavigationOutcome> {
  const state = useAppStore.getState();
  const host = state.host;
  if (
    !host ||
    state.connecting ||
    state.rehydrating ||
    state.desynchronized ||
    Boolean(state.hostFatal)
  ) {
    return { status: "blocked" };
  }

  if (state.workspace?.canonicalCwd !== target.cwd) {
    // Shared-host mode: one Host serves every workspace — skip the dedicated
    // Host activation entirely and take the in-place `workspace.setCurrent`
    // path below (same connection, so no prepareForHostSwitch/replay). False
    // while settings are still loading, keeping the dedicated-Host flow.
    const sharedHostMode = useAppStore.getState().desktopSettings?.sharedHostMode === true;
    const connectDedicatedHost = async (force: boolean): Promise<boolean> => {
      const activated = force
        ? await activateWorkspaceHost(target.cwd)
        : await prepareWorkspaceHost(target.cwd, workspaceHasActiveAgent(useAppStore.getState()));
      if (!activated) return false;
      hostClient.prepareForHostSwitch();
      useAppStore.getState().setConnecting(true);
      await replayActiveHostReady();
      await waitForWorkspaceActivation(host.hostInstanceId);
      return true;
    };
    if (!(sharedHostMode || (await connectDedicatedHost(false)))) {
      useAppStore.getState().setWorkspaceSwitchTarget(target.cwd);
      let switched;
      try {
        switched = await hostClient.request(
          "workspace.setCurrent",
          workspaceContext(host, state.workspace),
          { cwd: target.cwd },
          60_000,
        );
      } finally {
        useAppStore.getState().setWorkspaceSwitchTarget(null);
      }
      if (!switched.ok) {
        // In shared mode a busy rejection cannot be resolved by a dedicated
        // Host (there is none) — surface it instead of retrying.
        if (
          isWorkspaceSwitchBusyError(switched.error) &&
          !sharedHostMode &&
          (await connectDedicatedHost(true))
        ) {
          // The Host became busy after the initial decision; isolation completed.
        } else {
          useAppStore
            .getState()
            .pushNotification(
              localizeHostError(switched.error, tCurrent),
              hostErrorLevel(switched.error),
            );
          return { status: "failed" };
        }
      } else {
        const result = switched.result;
        try {
          await rebindActiveWorkspaceHost(result.workspace.canonicalCwd);
        } catch (rebindError) {
          // Registration failure must not break an already-successful switch:
          // rebind only feeds Rust bookkeeping (activity cwds / restart restore).
          console.warn("[piabyss] workspace host rebind failed", rebindError);
        }
        // workspace.changed / session.snapshot events usually land before this
        // response resolves; apply only what the event stream has not.
        const appliedWorkspace = useAppStore.getState().workspace;
        if (
          appliedWorkspace === null ||
          appliedWorkspace.id !== result.workspace.id ||
          appliedWorkspace.revision !== result.workspace.revision
        ) {
          useAppStore.getState().setWorkspace(result.workspace);
        }
        if (result.session) {
          const appliedSession = useAppStore.getState().session;
          if (
            appliedSession === null ||
            appliedSession.sessionId !== result.session.sessionId ||
            appliedSession.revision !== result.session.revision
          ) {
            useAppStore.getState().setSession(result.session);
          }
        }
        useAppStore.getState().setHost({
          ...host,
          workspaceId: switched.workspaceId,
          workspaceRevision: switched.workspaceRevision,
          sessionId: switched.sessionId,
          sessionRevision: switched.sessionRevision,
          packageRevision: switched.packageRevision,
        });
      }
    }
  }

  if (target.archived) {
    return { status: "archived" };
  }
  const activeSession = useAppStore.getState().session;
  if (
    (target.sessionPath && activeSession?.sessionPath === target.sessionPath) ||
    (target.sessionId && activeSession?.sessionId === target.sessionId)
  ) {
    return { status: "already-active" };
  }

  let sessionPath = target.sessionPath;
  let archived = false;
  if (!sessionPath) {
    if (!target.sessionId || !options.resolveSessionPath) return { status: "blocked" };
    // A resolver failure (transport detached, timeout) must surface as a
    // normal failure, not bubble to callers that intentionally swallow
    // errors (the notification click router).
    let resolved: { sessionPath: string; archived?: boolean } | null = null;
    try {
      resolved = await options.resolveSessionPath(target.sessionId);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      useAppStore.getState().pushNotification(tCurrent("notifOpenSessionFailed"), "error");
      return { status: "failed" };
    }
    sessionPath = resolved.sessionPath;
    archived = resolved.archived === true;
  }
  if (archived) {
    return { status: "archived" };
  }

  const res = await requestSessionOpenWithRetry(() => {
    const latest = useAppStore.getState();
    if (!latest.host || !latest.workspace) {
      throw new Error(tCurrent("notifOpenSessionFailed"));
    }
    return hostClient.request(
      "session.open",
      {
        expectedHostInstanceId: latest.host.hostInstanceId,
        expectedWorkspaceId: latest.workspace.id,
        expectedWorkspaceRevision: latest.workspace.revision,
        expectedSessionId: latest.host.sessionId,
        expectedSessionRevision: latest.host.sessionRevision,
      },
      { sessionPath },
      SESSION_OPEN_TIMEOUT_MS,
    );
  });
  if (!res) return { status: "blocked" };
  if (!res.ok) {
    useAppStore
      .getState()
      .pushNotification(localizeHostError(res.error, tCurrent), hostErrorLevel(res.error));
    return { status: "failed" };
  }
  const appliedSession = useAppStore.getState().session;
  const alreadyApplied =
    appliedSession !== null &&
    appliedSession.sessionId === res.result.sessionId &&
    appliedSession.revision === res.result.revision;
  if (!alreadyApplied) useAppStore.getState().applySessionSnapshot(res.result);
  const latestHost = useAppStore.getState().host;
  if (latestHost) {
    const nextHost = mergeHostIdentity(latestHost, res);
    if (nextHost) useAppStore.getState().setHost(nextHost);
  }
  return { status: "opened" };
}
