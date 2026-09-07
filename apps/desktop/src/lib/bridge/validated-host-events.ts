import type { HostEventEnvelope, HostEventName } from "@piabyss/protocol";

export type HostEventScope = {
  expectedHostInstanceId: string;
  expectedWorkspaceId?: string | null;
  expectedWorkspaceRevision?: number;
  expectedSessionId?: string | null;
  expectedSessionRevision?: number;
};

type Subscriber = {
  scope: HostEventScope;
  handler: (event: HostEventEnvelope) => void;
};

const subscribers = new Map<HostEventName, Set<Subscriber>>();

function matchesScope(event: HostEventEnvelope, scope: HostEventScope): boolean {
  if (event.hostInstanceId !== scope.expectedHostInstanceId) return false;
  if (scope.expectedWorkspaceId !== undefined && event.workspaceId !== scope.expectedWorkspaceId) {
    return false;
  }
  if (
    scope.expectedWorkspaceRevision !== undefined &&
    event.workspaceRevision !== scope.expectedWorkspaceRevision
  ) {
    return false;
  }
  if (scope.expectedSessionId !== undefined && event.sessionId !== scope.expectedSessionId) {
    return false;
  }
  if (
    scope.expectedSessionRevision !== undefined &&
    event.sessionRevision !== scope.expectedSessionRevision
  ) {
    return false;
  }
  return true;
}

/**
 * Subscribe to events only after App has accepted sequence and active-epoch
 * identity. The captured request context also prevents a stale React closure
 * from consuming an event for a newer Workspace or Session generation.
 */
export function subscribeValidatedHostEvent<E extends HostEventName>(
  eventName: E,
  scope: HostEventScope,
  handler: (event: HostEventEnvelope<E>) => void,
): () => void {
  const subscriber: Subscriber = {
    scope,
    handler: handler as (event: HostEventEnvelope) => void,
  };
  const eventSubscribers = subscribers.get(eventName) ?? new Set<Subscriber>();
  eventSubscribers.add(subscriber);
  subscribers.set(eventName, eventSubscribers);
  return () => {
    eventSubscribers.delete(subscriber);
    if (eventSubscribers.size === 0) subscribers.delete(eventName);
  };
}

/** App-only dispatch point: call after handleHostEvent returns true. */
export function publishValidatedHostEvent(event: HostEventEnvelope): void {
  const eventSubscribers = subscribers.get(event.event);
  if (!eventSubscribers) return;
  for (const subscriber of [...eventSubscribers]) {
    if (!matchesScope(event, subscriber.scope)) continue;
    try {
      subscriber.handler(event);
    } catch (error) {
      console.error(`[piabyss] ${event.event} subscriber failed`, error);
    }
  }
}
