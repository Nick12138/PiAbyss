import type { HostEventEnvelope, SessionRuntimeState } from "@piabyss/protocol";

export type EventIdentityState = {
  hostInstanceId: string | null;
  workspaceId: string | null;
  workspaceRevision: number | undefined;
  sessionId: string | null;
  sessionRevision: number | undefined;
};

/**
 * Authoritative snapshot events are allowed to advance their own generation.
 * Sequence ordering plus payload/envelope validation guards those transitions;
 * unrelated business events must still match the full active identity.
 */
export function expectedIdentityForEvent(
  event: HostEventEnvelope,
  state: EventIdentityState,
): {
  hostInstanceId: string | null;
  workspaceId?: string | null;
  workspaceRevision?: number;
  sessionId?: string | null;
  sessionRevision?: number;
} {
  const host = { hostInstanceId: state.hostInstanceId };

  switch (event.event) {
    case "host.ready":
    case "host.statusChanged":
    case "host.fatal":
    case "workspace.changed":
    case "provider.loginEvent":
    case "extensionUi.request":
    case "extensionUi.closed":
    case "extensionUi.groupClosed":
    case "extensionUi.customStarted":
    case "extensionUi.customFrame":
    case "extensionUi.customClosed":
      return host;
    case "session.snapshot":
    case "session.infoChanged":
    case "session.runtimeChanged":
    case "agent.event":
    // Git status is workspace-scoped state (the working tree), so it is
    // validated against the Host + workspace generation only. Requiring the
    // Session identity here used to drop every `git.changed` whose envelope
    // predated a Session switch or a package reload (which only bumps the
    // Session revision), leaving the Changes panel stale until a manual
    // refresh — no rehydrate path re-fetches git status.
    case "git.changed":
    // Async pull/push results may only be excused down to workspace scope: the
    // requesting workspace can be parked by the time they land, but a foreign
    // or unbound workspace is still an identity mismatch.
    case "git.taskFinished":
    case "package.diagnostic":
    case "extensionUi.statusChanged":
    case "extensionUi.widgetChanged":
    case "extensionUi.widgetAttentionRequested":
    case "extensionUi.notification":
    case "package.progress":
    case "package.snapshot":
    case "package.resourcesChanged":
      return {
        ...host,
        workspaceId: state.workspaceId,
        workspaceRevision: state.workspaceRevision,
      };
    default:
      return {
        ...host,
        workspaceId: state.workspaceId,
        workspaceRevision: state.workspaceRevision,
        sessionId: state.sessionId,
        sessionRevision: state.sessionRevision,
      };
  }
}

export type ExtensionUiRequestDelivery = "active" | "background" | "candidate";

export function extensionUiRequestDelivery(args: {
  eventSessionId: string;
  activeSessionId: string | null;
  catalogRuntimeState?: SessionRuntimeState;
}): ExtensionUiRequestDelivery {
  if (args.eventSessionId === args.activeSessionId) return "active";
  if (args.catalogRuntimeState === "running" || args.catalogRuntimeState === "queued") {
    return "background";
  }
  return "candidate";
}
