import { hostClient } from "./host-client";
import { rebindActiveWorkspaceHost } from "./tauri-transport";
import type { HostResponseEnvelope, HostStatusSnapshot } from "@piabyss/protocol";
import { mergeHostIdentity, workspaceContext } from "./host-context";
import { requestSessionOpenWithRetry, SESSION_OPEN_TIMEOUT_MS } from "./session-open-request";
import { hostErrorLevel, localizeHostError } from "./localize-host-error";
import { requestWithRetry } from "./request-retry";
import { tCurrent } from "../i18n/use-t";
import { useAppStore } from "../stores/app-store";

/**
 * A cross-workspace "jump to this session" request shared by the global search
 * modal and the system-notification click router. Owns the in-place
 * `workspace.setCurrent` switch plus the guarded `session.open` handshake,
 * without any component-local UI state.
 */
export type SessionNavigationTarget = {
  cwd: string;
  sessionPath?: string;
  /** Present without sessionPath for cross-workspace system notifications. */
  sessionId?: string;
  archived?: boolean;
  /**
   * Suppress the toast notifications this navigation normally surfaces on
   * failure — for callers that retry the navigation on a longer window and
   * report the final error themselves.
   */
  quiet?: boolean;
  /**
   * Hold the workspaceSwitchTarget slot across the whole navigation and leave
   * releasing it to the caller (via releaseWorkspaceSwitchSlot). See
   * activateWorkspaceAcrossWorkspaces' holdSlot.
   */
  holdSlot?: boolean;
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

/** Result of a cross-workspace activation: the requested cwd is active or why not. */
export type WorkspaceActivationOutcome = Extract<
  SessionNavigationOutcome,
  { status: "opened" | "already-active" | "blocked" | "failed" }
>;

/** A workspace switch may build a cold service graph; the picker documents a
 *  build that can exceed 10s (cold tsx compile), so the request stays patient. */
const WORKSPACE_SWITCH_TIMEOUT_MS = 60_000;

/** The switch that beat us committed before rejecting this request and published
 *  its identity in the same tick, so this wait only has to outlive the pipe. */
const STALE_IDENTITY_RETRY_DELAY_MS = 200;

/**
 * `workspace.setCurrent` for both the workspace picker and every cross-workspace
 * activation, with the two identity hazards behind
 * 「界面状态已过期，该操作未生效，请重试。」 handled:
 *
 * 1. The context is rebuilt from the store on every attempt. The Host compares a
 *    request against its already COMMITTED generation, so re-sending a context
 *    captured before the request only reproduces the same rejection.
 * 2. A `STALE_REVISION` rejection gets one silent re-attempt. The Host reports it
 *    as retryable:false because it never replays a committed mutation, but the UI
 *    can recover: the winning switch has by now published its own identity, so
 *    the re-attempt lands instead of asking the user to click again.
 *
 * Returns null when `isCurrent` reports this request was superseded.
 */
export async function requestWorkspaceSwitch(
  cwd: string,
  fallbackHost: HostStatusSnapshot,
  options: { optimistic: boolean; isCurrent?: () => boolean; delays?: readonly number[] },
): Promise<HostResponseEnvelope<"workspace.setCurrent"> | null> {
  const isCurrent = options.isCurrent ?? (() => true);
  const send = () => {
    const latest = useAppStore.getState();
    return hostClient.request(
      "workspace.setCurrent",
      workspaceContext(latest.host ?? fallbackHost, latest.workspace),
      { cwd, optimistic: options.optimistic },
      WORKSPACE_SWITCH_TIMEOUT_MS,
    );
  };
  const attempted = await requestWithRetry(send, undefined, isCurrent, options.delays);
  if (!attempted) return null;
  if (attempted.ok || attempted.error?.code !== "STALE_REVISION") return attempted;
  await new Promise((resolve) => setTimeout(resolve, STALE_IDENTITY_RETRY_DELAY_MS));
  // One heal only: if a third switch beat us again, the caller surfaces it.
  return await requestWithRetry(send, undefined, isCurrent, options.delays);
}

/**
 * Cross-workspace "make this cwd the active workspace" request shared by the
 * session jump navigation and the memo agent handoff. One shared Host serves
 * every workspace, so this always switches in place via `workspace.setCurrent`
 * on the same connection. Pass `optimistic: false` when graph operations
 * (e.g. session.create) must run right after the switch so the call blocks
 * until the build settles.
 */
export async function activateWorkspaceAcrossWorkspaces(
  cwd: string,
  options: {
    optimistic?: boolean;
    quiet?: boolean;
    /**
     * 整个调用期间（含返回后直到调用方显式释放）占用 workspaceSwitchTarget
     * 槽位，默认 false（返回前在 finally 里释放）。请求方后续还有第二拍
     * 动作（如 session.open）时必须传 true：槽位一空，PixiePage 的
     * workspaceStrayed 防卫就会把工作区抢回 pixie，第二拍对着的已经是被
     * 换走的图（历史 bug：委派面板跳转切完工作区就被抢回，留在小精灵页）。
     */
    holdSlot?: boolean;
  } = {},
): Promise<WorkspaceActivationOutcome> {
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

  if (state.workspace?.canonicalCwd === cwd) return { status: "already-active" };

  // One shared Host serves every workspace: switch in place via
  // `workspace.setCurrent` (same connection, no Host swap) and register the
  // workspace through `rebindActiveWorkspaceHost` afterwards.
  useAppStore.getState().setWorkspaceSwitchTarget(cwd);
  let switched;
  try {
    // Transient SERVICE_GRAPH_BUSY collisions (an in-flight read holding
    // the serviceGraphLock) are retryable by design; give the switch a
    // short retry window instead of surfacing a one-off busy toast.
    const attempted = await requestWorkspaceSwitch(cwd, host, {
      optimistic: options.optimistic !== false,
      // Only a *different* cwd seizing the slot supersedes this switch. A
      // cleared slot just means the sibling activation finished — not that
      // anyone replaced us. Two activations of the same cwd are legitimate
      // (React StrictMode replays mount effects in dev, so the pixie page
      // acquires twice) and must both settle; otherwise the slower one
      // reports a bogus "blocked" and the page flashes 「暂不可用」.
      isCurrent: () => {
        const target = useAppStore.getState().workspaceSwitchTarget;
        return target === null || target === cwd;
      },
    });
    if (!attempted) return { status: "blocked" };
    switched = attempted;
  } finally {
    // Release the slot only while it is still ours: a newer activation for a
    // different cwd may have claimed it during the retry window. With
    // holdSlot the caller owns the release (it still has a second move to
    // make — e.g. session.open — and an empty slot lets PixiePage's
    // workspaceStrayed guard yank the workspace back mid-jump).
    if (!options.holdSlot && useAppStore.getState().workspaceSwitchTarget === cwd) {
      useAppStore.getState().setWorkspaceSwitchTarget(null);
    }
  }
  if (!switched.ok) {
    // A busy rejection cannot be resolved by another Host (there is none) —
    // surface it instead of retrying.
    if (!options.quiet) {
      useAppStore
        .getState()
        .pushNotification(
          localizeHostError(switched.error, tCurrent),
          hostErrorLevel(switched.error),
        );
    }
    return { status: "failed" };
  }
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
  return { status: "opened" };
}

/**
 * Release the workspaceSwitchTarget slot when it still holds `cwd` (a no-op if
 * a newer activation claimed it). Pair with `holdSlot: true` navigation
 * targets: acquire before the jump, release in a finally.
 */
export function releaseWorkspaceSwitchSlot(cwd: string): void {
  if (useAppStore.getState().workspaceSwitchTarget === cwd) {
    useAppStore.getState().setWorkspaceSwitchTarget(null);
  }
}

export async function openSessionAcrossWorkspaces(
  target: SessionNavigationTarget,
  options: SessionNavigationOptions = {},
): Promise<SessionNavigationOutcome> {
  // Avoid workspace activation when the requested session is already active.
  // In shared-host mode, an unnecessary setCurrent can switch the transcript to
  // that workspace's default/newest session before the later sessionId check.
  const initialSession = useAppStore.getState().session;
  if (
    (target.sessionPath && initialSession?.sessionPath === target.sessionPath) ||
    // Session IDs are globally unique; check before activating the target
    // workspace because shared-host setCurrent can replace the active session
    // with that workspace's default session as a side effect.
    (target.sessionId && initialSession?.sessionId === target.sessionId)
  ) {
    return { status: "already-active" };
  }

  // Cross-workspace activation (in-place setCurrent); the helper owns the
  // retry window and busy-surface policy. Always blocking here: every path
  // below either opens a session or stops, and the Host refuses
  // `session.open`/`session.create` while an optimistic switch still holds a
  // pending shell (AGENT_NOT_READY "Workspace services not ready"). A jump is
  // only useful once the target conversation is actually open, so the switch
  // must wait for the graph instead of handing the user a half-built workspace.
  const activation = await activateWorkspaceAcrossWorkspaces(target.cwd, {
    optimistic: false,
    quiet: target.quiet,
    // Keep PixiePage's workspaceStrayed guard quiet across the whole jump:
    // the slot must stay held until every step below has settled (the caller
    // releases it; see releaseWorkspaceSwitchSlot in pixie-session-jump).
    holdSlot: target.holdSlot,
  });
  if (activation.status === "already-active") {
    // Fall through: the caller may still want session.open below (an active
    // workspace can hold a different session than the requested one).
  } else if (activation.status !== "opened") {
    return activation;
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
      if (!target.quiet) {
        useAppStore.getState().pushNotification(tCurrent("notifOpenSessionFailed"), "error");
      }
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
    if (!target.quiet) {
      useAppStore
        .getState()
        .pushNotification(localizeHostError(res.error, tCurrent), hostErrorLevel(res.error));
    }
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
