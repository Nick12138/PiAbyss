import type {
  ExtensionUiGroupStatus,
  ExtensionUiRequest,
  SessionTargetContext,
} from "@piabyss/protocol";

export type ExtensionUiRequestState = ExtensionUiRequest & {
  context: SessionTargetContext;
  expiresAt?: number;
};

export type ExtensionDecisionStepOutcome = "answered" | "cancelled" | "expired" | "stale";

export type ExtensionDecisionGroupState = {
  groupKey: string;
  context: SessionTargetContext;
  origin?: ExtensionUiRequest["origin"];
  presentation: "inline" | "modal";
  risk: "normal" | "high";
  activeRequestId: string | null;
  answeredCount: number;
  steps: Array<{
    requestId: string;
    kind: ExtensionUiRequest["kind"];
    status: "active" | ExtensionDecisionStepOutcome;
  }>;
  status: "active" | ExtensionUiGroupStatus;
};

export type ExtensionUiWaitingSummary = {
  count: number;
  hasHighRisk: boolean;
};

const MAX_EXTENSION_DECISION_GROUP_STEPS = 100;

function sameDecisionGroupSession(
  left: SessionTargetContext,
  right: SessionTargetContext,
): boolean {
  return (
    left.expectedHostInstanceId === right.expectedHostInstanceId &&
    left.expectedWorkspaceId === right.expectedWorkspaceId &&
    left.expectedWorkspaceRevision === right.expectedWorkspaceRevision &&
    left.expectedSessionId === right.expectedSessionId
  );
}

export function registerDecisionGroupRequest(
  groups: Record<string, ExtensionDecisionGroupState>,
  request: ExtensionUiRequestState,
): Record<string, ExtensionDecisionGroupState> {
  if (!request.groupKey) return groups;
  const existing = groups[request.groupKey];
  const current =
    existing && sameDecisionGroupSession(existing.context, request.context) ? existing : undefined;
  const stepIndex = current?.steps.findIndex((step) => step.requestId === request.requestId) ?? -1;
  const steps = current ? [...current.steps] : [];
  const step = {
    requestId: request.requestId,
    kind: request.kind,
    status: "active" as const,
  };
  if (stepIndex >= 0) steps[stepIndex] = step;
  else steps.push(step);
  return {
    ...groups,
    [request.groupKey]: {
      groupKey: request.groupKey,
      context: request.context,
      ...(request.origin ? { origin: request.origin } : {}),
      presentation: request.presentation ?? "modal",
      risk: request.risk ?? "normal",
      activeRequestId: request.requestId,
      answeredCount: current?.answeredCount ?? 0,
      steps: steps.slice(-MAX_EXTENSION_DECISION_GROUP_STEPS),
      status: "active",
    },
  };
}

export function settleDecisionGroupRequest(
  groups: Record<string, ExtensionDecisionGroupState>,
  request: ExtensionUiRequestState,
  outcome: ExtensionDecisionStepOutcome,
): Record<string, ExtensionDecisionGroupState> {
  if (!request.groupKey) return groups;
  const group = groups[request.groupKey];
  if (!group || !sameDecisionGroupSession(group.context, request.context)) return groups;
  const previousStep = group.steps.find((step) => step.requestId === request.requestId);
  const steps = group.steps.map((step) =>
    step.requestId === request.requestId ? { ...step, status: outcome } : step,
  );
  const next = {
    ...group,
    activeRequestId: group.activeRequestId === request.requestId ? null : group.activeRequestId,
    answeredCount:
      outcome === "answered" && previousStep?.status !== "answered"
        ? group.answeredCount + 1
        : group.answeredCount,
    steps,
  };
  if (next.status !== "active" && next.activeRequestId === null) {
    const remaining = { ...groups };
    delete remaining[request.groupKey];
    return remaining;
  }
  return { ...groups, [request.groupKey]: next };
}

export function isExtensionUiRequestExpired(
  request: ExtensionUiRequestState,
  now = Date.now(),
): boolean {
  return request.expiresAt !== undefined && request.expiresAt <= now;
}

export function extensionUiSessionId(request: ExtensionUiRequestState): string | null {
  return request.context.expectedSessionId;
}

/** Derive sidebar visibility from the authoritative request queue. */
export function deriveExtensionUiWaitingBySession(
  activeRequest: ExtensionUiRequestState | null,
  queuedRequests: readonly ExtensionUiRequestState[],
  now = Date.now(),
): Record<string, ExtensionUiWaitingSummary> {
  const summaries: Record<string, ExtensionUiWaitingSummary> = {};
  const seen = new Set<string>();
  for (const request of activeRequest ? [activeRequest, ...queuedRequests] : queuedRequests) {
    if (seen.has(request.requestId) || isExtensionUiRequestExpired(request, now)) continue;
    seen.add(request.requestId);
    const sessionId = extensionUiSessionId(request);
    if (!sessionId) continue;
    const current = summaries[sessionId];
    summaries[sessionId] = {
      count: (current?.count ?? 0) + 1,
      hasHighRisk: (current?.hasHighRisk ?? false) || request.risk === "high",
    };
  }
  return summaries;
}

export function isExtensionDecisionBlockingSession(
  activeRequest: ExtensionUiRequestState | null,
  groups: Readonly<Record<string, ExtensionDecisionGroupState>>,
  sessionId: string | null,
  now = Date.now(),
): boolean {
  if (!sessionId) return false;
  if (
    activeRequest &&
    !isExtensionUiRequestExpired(activeRequest, now) &&
    extensionUiSessionId(activeRequest) === sessionId
  ) {
    return true;
  }
  return Object.values(groups).some(
    (group) => group.status === "active" && group.context.expectedSessionId === sessionId,
  );
}

export function alignExtensionUiToSession(
  activeRequest: ExtensionUiRequestState | null,
  queuedRequests: ExtensionUiRequestState[],
  sessionId: string | null,
  now = Date.now(),
): {
  extensionUiRequest: ExtensionUiRequestState | null;
  extensionUiQueue: ExtensionUiRequestState[];
} {
  let active =
    activeRequest && !isExtensionUiRequestExpired(activeRequest, now) ? activeRequest : null;
  let queue = queuedRequests.filter((request) => !isExtensionUiRequestExpired(request, now));
  if (!sessionId) return { extensionUiRequest: active, extensionUiQueue: queue };
  if (active && extensionUiSessionId(active) === sessionId) {
    return { extensionUiRequest: active, extensionUiQueue: queue };
  }
  if (active) queue = [active, ...queue];
  const nextIndex = queue.findIndex((request) => extensionUiSessionId(request) === sessionId);
  if (nextIndex < 0) return { extensionUiRequest: null, extensionUiQueue: queue };
  active = queue[nextIndex]!;
  queue = queue.filter((_, index) => index !== nextIndex);
  return { extensionUiRequest: active, extensionUiQueue: queue };
}
