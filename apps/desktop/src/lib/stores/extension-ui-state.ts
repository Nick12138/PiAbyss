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
    /**
     * Which question of a multi-question questionnaire this step was. Verifies a
     * rewind: the plugin re-asks the same question with a *new* request id, so
     * the count has to be keyed by the question rather than the request.
     */
    questionIndex?: number;
  }>;
  status: "active" | ExtensionUiGroupStatus;
};

export type ExtensionUiWaitingSummary = {
  count: number;
  hasHighRisk: boolean;
};

const MAX_EXTENSION_DECISION_GROUP_STEPS = 100;

/**
 * How many questions the group has already answered.
 *
 * Questionnaire steps are counted by question index so that rewinding and
 * answering again does not inflate the number — the user sees how many of the
 * questions are done, not how many responses were posted.
 */
function countAnsweredSteps(
  steps: ReadonlyArray<{ status: string; questionIndex?: number }>,
): number {
  const indices = new Set<number>();
  let anonymous = 0;
  for (const step of steps) {
    if (step.status !== "answered") continue;
    if (step.questionIndex === undefined) anonymous += 1;
    else indices.add(step.questionIndex);
  }
  return indices.size + anonymous;
}

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
  // A re-asked question arrives with a new request id but the same question
  // index; supersede the old step in place instead of appending, or the group
  // would accumulate one entry per re-answer.
  const questionIndex = request.questionIndex;
  const steps = current ? [...current.steps] : [];
  const stepIndex =
    questionIndex === undefined
      ? steps.findIndex((step) => step.requestId === request.requestId)
      : steps.findIndex((step) => step.questionIndex === questionIndex);
  const step = {
    requestId: request.requestId,
    kind: request.kind,
    status: "active" as const,
    ...(questionIndex !== undefined ? { questionIndex } : {}),
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
      // Recomputed, not carried over: a rewind flips the question it goes back
      // to out of "answered", and the badge must follow.
      answeredCount: countAnsweredSteps(steps),
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
  const steps = group.steps.map((step) =>
    step.requestId === request.requestId ? { ...step, status: outcome } : step,
  );
  const next = {
    ...group,
    activeRequestId: group.activeRequestId === request.requestId ? null : group.activeRequestId,
    answeredCount: countAnsweredSteps(steps),
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
