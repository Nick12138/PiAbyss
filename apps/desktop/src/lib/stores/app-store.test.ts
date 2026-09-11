/**
 * R7: app-store epoch wiring — host/workspace changes clear stale state.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore, type SettingsSection } from "./app-store";
import {
  deriveExtensionUiWaitingBySession,
  isExtensionDecisionBlockingSession,
} from "./extension-ui-state";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { emptySessionCatalog } from "./session-catalog";

function host(id: string): HostStatusSnapshot {
  return {
    hostInstanceId: id,
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    protocolVersion: 1,
    sdkVersion: "0.82.1",
    nodeVersion: "v22",
    agentDir: "/tmp",
    phase: "waitingForWorkspace",
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(id: string, rev: number): WorkspaceSnapshot {
  return {
    id,
    cwd: `/p/${id}`,
    canonicalCwd: `/p/${id}`,
    revision: rev,
    servicesReady: true,
  };
}

function session(id: string, revision = 1): SessionSnapshot {
  return {
    sessionId: id,
    cwd: "/p",
    revision,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: "hi" }],
    tools: {
      revision: 1,
      workspaceId: "w",
      sessionId: id,
      sessionRevision: revision,
      tools: [],
      active: [],
    },
  };
}

describe("app-store epoch wiring", () => {
  beforeEach(() => {
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      packages: null,
      tools: null,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      collapsedExtensionWidgetKeys: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      sessionRuntimeStates: {},
      boundWorkspaces: {},
      sessionTerminalStates: {},
      workspaceActivities: {},
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
      notifications: [],
      desynchronized: false,
      lastSequence: 0,
      hostFatal: null,
      rehydrating: false,
    });
  });

  it("preserves an unclaimed optimistic message when an authoritative snapshot is stale", () => {
    const current = session("s1");
    current.messages = [
      ...current.messages,
      { role: "user", content: "pending", _optimisticKey: "opt-1" },
    ];
    useAppStore.getState().applySessionSnapshot(current);

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      messages: [{ role: "user", content: "hi" }],
    });

    expect(useAppStore.getState().session?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "pending", _optimisticKey: "opt-1" },
    ]);
  });

  it("preserves an active optimistic send when a same-session generation snapshot races it", () => {
    const current = session("s1", 1);
    current.isIdle = false;
    current.isStreaming = true;
    current.messages = [
      ...current.messages,
      { role: "user", content: "pending", _optimisticKey: "opt-race" },
    ];
    useAppStore.getState().applySessionSnapshot(current);

    useAppStore.getState().applySessionSnapshot({
      ...session("s1", 2),
      isIdle: false,
      isStreaming: true,
      messages: [{ role: "user", content: "hi" }],
    });

    const next = useAppStore.getState().session;
    expect(next?.revision).toBe(2);
    expect(next?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "pending", _optimisticKey: "opt-race" },
    ]);
  });

  it("does not preserve an optimistic message already present in the snapshot", () => {
    const current = session("s1");
    current.messages = [
      ...current.messages,
      { role: "user", content: "pending", _optimisticKey: "opt-1" },
    ];
    useAppStore.getState().applySessionSnapshot(current);

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: [{ type: "text", text: "pending" }] },
      ],
    });

    expect(useAppStore.getState().session?.messages).toHaveLength(2);
    expect(useAppStore.getState().session?.messages[1]?._optimisticKey).toBeUndefined();
  });
  it("treats an authoritative message with attachment blocks as the pending row", () => {
    const block = '<piabyss-attachments version="1">\n[{"id":"a1"}]\n</piabyss-attachments>';
    const current = session("s1");
    current.messages = [
      ...current.messages,
      { role: "user", content: "please look", _optimisticKey: "opt-2" },
    ];
    useAppStore.getState().applySessionSnapshot(current);

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: [{ type: "text", text: `please look\n\n${block}` }] },
      ],
    });

    const messages = useAppStore.getState().session?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[1]?._optimisticKey).toBeUndefined();
  });

  it("retains redacted decision group steps until Host completion", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const groupKey = "tool:0123456789abcdef";
    const first = {
      requestId: "11111111-1111-4111-8111-111111111111",
      kind: "select" as const,
      groupKey,
      presentation: "inline" as const,
      context,
    };
    const second = {
      requestId: "22222222-2222-4222-8222-222222222222",
      kind: "input" as const,
      groupKey,
      presentation: "inline" as const,
      context: { ...context, expectedSessionRevision: 2 },
    };

    useAppStore.getState().setExtensionUiRequest(first);
    useAppStore.getState().closeExtensionUiRequest(first.requestId, "answered");

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toMatchObject({
      activeRequestId: null,
      answeredCount: 1,
      status: "active",
      steps: [{ requestId: first.requestId, kind: "select", status: "answered" }],
    });
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).not.toHaveProperty("value");

    useAppStore.getState().setExtensionUiRequest(second);
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toMatchObject({
      activeRequestId: second.requestId,
      context: { expectedSessionRevision: 2 },
      answeredCount: 1,
      steps: [
        { requestId: first.requestId, kind: "select", status: "answered" },
        { requestId: second.requestId, kind: "input", status: "active" },
      ],
    });

    useAppStore.getState().closeExtensionDecisionGroup(groupKey, "completed");
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]?.status).toBe("completed");
    useAppStore.getState().closeExtensionUiRequest(second.requestId, "answered");
    expect(useAppStore.getState().extensionDecisionGroups[groupKey]).toBeUndefined();
  });

  it("bounds retained group steps while preserving the answered count", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const groupKey = "tool:bounded";
    for (let index = 0; index < 105; index += 1) {
      const requestId = `request-${index}`;
      useAppStore.getState().setExtensionUiRequest({
        requestId,
        kind: "input",
        groupKey,
        presentation: "inline",
        context,
      });
      useAppStore.getState().closeExtensionUiRequest(requestId, "answered");
    }

    const group = useAppStore.getState().extensionDecisionGroups[groupKey];
    expect(group?.steps).toHaveLength(100);
    expect(group?.answeredCount).toBe(105);
    expect(group?.steps[0]?.requestId).toBe("request-5");
  });

  it("keeps concurrent decision groups isolated", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    useAppStore.getState().setExtensionUiRequest({
      requestId: "33333333-3333-4333-8333-333333333333",
      kind: "confirm",
      groupKey: "tool:first",
      presentation: "inline",
      context,
    });
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      groupKey: "tool:second",
      presentation: "inline",
      context,
    });

    expect(Object.keys(useAppStore.getState().extensionDecisionGroups)).toEqual([
      "tool:first",
      "tool:second",
    ]);
    useAppStore.getState().closeExtensionDecisionGroup("tool:second", "failed");
    expect(useAppStore.getState().extensionDecisionGroups["tool:first"]?.status).toBe("active");
    expect(useAppStore.getState().extensionDecisionGroups["tool:second"]?.status).toBe("failed");
  });

  it("beginHostEpoch clears prior workspace/session/packages/tools", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setSessionRuntimeState("s1", "running");
    useAppStore.getState().applyPackageSnapshot({
      revision: 1,
      workspaceId: "w1",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });

    useAppStore.getState().beginHostEpoch(host("h2"));
    const s = useAppStore.getState();
    expect(s.host?.hostInstanceId).toBe("h2");
    expect(s.workspace).toBeNull();
    expect(s.session).toBeNull();
    expect(s.packages).toBeNull();
    expect(s.tools).toBeNull();
    expect(s.sessionRuntimeStates).toEqual({});
  });

  it("advances Host session identity with authoritative session snapshots", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));

    useAppStore.getState().applySessionSnapshot(session("s1", 1));
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: "s1",
      sessionRevision: 1,
    });

    useAppStore.getState().applySessionSnapshot(session("s2", 2));
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: "s2",
      sessionRevision: 2,
    });

    useAppStore.getState().applySessionSnapshot(null);
    expect(useAppStore.getState().host).toMatchObject({
      sessionId: null,
      sessionRevision: 0,
    });
  });

  it("setHost with new hostInstanceId begins epoch", () => {
    useAppStore.getState().setHost(host("h1"));
    useAppStore.getState().setWorkspace(workspace("w1", 1));
    useAppStore.getState().setSession(session("s1"));
    useAppStore.getState().setHost(host("h2"));
    const s = useAppStore.getState();
    expect(s.session).toBeNull();
    expect(s.workspace).toBeNull();
  });

  it("workspace A→B clears session/tools/packages", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("A", 1));
    useAppStore.getState().applySessionSnapshot(session("sA"));
    useAppStore.getState().applyPackageSnapshot({
      revision: 1,
      workspaceId: "A",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });
    useAppStore.getState().applyWorkspaceSnapshot(workspace("B", 2));
    const s = useAppStore.getState();
    expect(s.workspace?.id).toBe("B");
    expect(s.session).toBeNull();
    expect(s.packages).toBeNull();
    expect(s.tools).toBeNull();
  });

  it("sequence gap marks desynchronized", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    expect(useAppStore.getState().noteSequence(1)).toBe("apply");
    expect(useAppStore.getState().noteSequence(2)).toBe("apply");
    expect(useAppStore.getState().noteSequence(5)).toBe("gap");
    expect(useAppStore.getState().desynchronized).toBe(true);
    expect(useAppStore.getState().lastSequence).toBe(5);
  });

  it("gap then rehydrate then next sequence applies (not infinite re-gap)", () => {
    // Spec: last=3, note(6)=gap, rehydrate, note(7)=apply
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.setState({ lastSequence: 3, desynchronized: false });
    expect(useAppStore.getState().noteSequence(6)).toBe("gap");
    expect(useAppStore.getState().desynchronized).toBe(true);
    expect(useAppStore.getState().lastSequence).toBe(6);

    useAppStore.getState().completeRehydrate({
      host: host("h1"),
      lastSequence: 6, // from the atomic Host recovery snapshot
    });
    expect(useAppStore.getState().desynchronized).toBe(false);
    expect(useAppStore.getState().lastSequence).toBe(6);
    expect(useAppStore.getState().noteSequence(7)).toBe("apply");
    expect(useAppStore.getState().lastSequence).toBe(7);
    expect(useAppStore.getState().desynchronized).toBe(false);
  });

  it("keeps an unclaimed optimistic row across a full rehydrate", () => {
    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "pending send", _optimisticKey: "opt-1" },
      ],
    });

    useAppStore.getState().completeRehydrate({
      host: host("h1"),
      session: session("s1"), // snapshot predates the optimistic send
      lastSequence: 6,
    });

    expect(useAppStore.getState().session?.messages.map((m) => m.content)).toEqual([
      "hi",
      "pending send",
    ]);
    expect(useAppStore.getState().session?.messages[1]?._optimisticKey).toBe("opt-1");
  });

  it("duplicate sequence drops", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    expect(useAppStore.getState().noteSequence(1)).toBe("apply");
    expect(useAppStore.getState().noteSequence(1)).toBe("drop");
  });

  it("stores keyed Extension widgets and clears them on session generation change", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setExtensionWidget({
      key: "summary",
      widget: { text: "ready" },
      placement: "belowEditor",
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    });
    expect(useAppStore.getState().extensionWidgets.summary?.widget).toEqual({ text: "ready" });
    expect(useAppStore.getState().extensionWidgets.summary?.placement).toBe("belowEditor");
    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    useAppStore.getState().setExtensionWidgetsOpen(true);
    useAppStore.getState().setExtensionWidgetsOpen(false);
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    useAppStore.getState().setExtensionWidget({
      ...useAppStore.getState().extensionWidgets.summary!,
      widget: { text: "updated" },
    });
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });
    useAppStore.getState().requestExtensionWidgetAttention("run-before-switch", "summary");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().extensionWidgets).toEqual({});
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
    expect(useAppStore.getState().lastExtensionWidgetAttentionRunId).toBeNull();
  });

  it("toggles collapse only for mounted widgets and prunes it on removal", () => {
    const widget = {
      key: "summary",
      widget: ["active"],
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    };

    useAppStore.getState().toggleExtensionWidgetCollapsed("missing");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});

    useAppStore.getState().setExtensionWidget(widget);
    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({ summary: true });

    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});

    useAppStore.getState().toggleExtensionWidgetCollapsed("summary");
    useAppStore.getState().setExtensionWidget({ ...widget, widget: null });
    expect(useAppStore.getState().extensionWidgets).toEqual({});
    expect(useAppStore.getState().collapsedExtensionWidgetKeys).toEqual({});
  });

  it("opens once per widget attention run and closes on navigation or final clear", () => {
    const widget = {
      key: "brainstorm",
      widget: ["active"],
      hostInstanceId: "h1",
      workspaceId: "w",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
    };

    useAppStore.getState().setExtensionWidget(widget);
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);

    useAppStore.getState().setExtensionWidgetsOpen(false);
    useAppStore.getState().requestExtensionWidgetAttention("run-1", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-2", "brainstorm");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(true);

    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
    useAppStore.getState().requestExtensionWidgetAttention("run-3", "brainstorm");
    useAppStore.getState().setPage("chat");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().requestExtensionWidgetAttention("run-missing", "missing");
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);

    useAppStore.getState().setExtensionWidgetsOpen(true);
    useAppStore.getState().setExtensionWidget({ ...widget, widget: null });
    expect(useAppStore.getState().extensionWidgetsOpen).toBe(false);
  });

  it("keeps extension statuses by key and clears them independently", () => {
    useAppStore.getState().setExtensionStatus("planner", "Planning");
    useAppStore.getState().setExtensionStatus("review", "Reviewing");
    expect(useAppStore.getState().extensionStatuses).toEqual({
      planner: "Planning",
      review: "Reviewing",
    });
    expect(useAppStore.getState().extensionStatus).toBe("Reviewing");

    useAppStore.getState().setExtensionStatus("review", "");
    expect(useAppStore.getState().extensionStatuses).toEqual({ planner: "Planning" });
    expect(useAppStore.getState().extensionStatus).toBe("Planning");
  });

  it("ignores extension statuses for telegram / wechat / pi-vision", () => {
    useAppStore.getState().setExtensionStatus("telegram", "telegram not configured");
    useAppStore.getState().setExtensionStatus("wechat", "[微信 ✅ 已连接]");
    useAppStore.getState().setExtensionStatus("pi-vision", "👁 deepseek-vl2");
    useAppStore.getState().setExtensionStatus("planner", "Planning");
    expect(useAppStore.getState().extensionStatuses).toEqual({ planner: "Planning" });
    expect(useAppStore.getState().extensionStatus).toBe("Planning");

    useAppStore.getState().setExtensionStatus("planner", "");
    expect(useAppStore.getState().extensionStatuses).toEqual({});
    expect(useAppStore.getState().extensionStatus).toBeNull();
  });

  it("queues concurrent Extension UI requests with their response contexts", () => {
    const context = {
      expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
      expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "33333333-3333-4333-8333-333333333333",
      expectedSessionRevision: 1,
    };
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      title: "First",
      context,
    });
    useAppStore.getState().setExtensionUiRequest({
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input",
      title: "Second",
      context: { ...context, expectedSessionRevision: 2 },
    });

    expect(useAppStore.getState().extensionUiRequest?.title).toBe("First");
    expect(useAppStore.getState().extensionUiQueue).toHaveLength(1);
    useAppStore.getState().setExtensionUiRequest(null);
    expect(useAppStore.getState().extensionUiRequest?.title).toBe("Second");
    expect(useAppStore.getState().extensionUiRequest?.context.expectedSessionRevision).toBe(2);
  });

  it("closes Extension UI requests by ID without disturbing unrelated work", () => {
    const activeContext = {
      expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
      expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "33333333-3333-4333-8333-333333333333",
      expectedSessionRevision: 1,
    };
    const first = {
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm" as const,
      title: "First",
      context: activeContext,
    };
    const second = {
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input" as const,
      title: "Second",
      context: activeContext,
    };
    const background = {
      requestId: "66666666-6666-4666-8666-666666666666",
      kind: "editor" as const,
      title: "Background",
      context: {
        ...activeContext,
        expectedSessionId: "77777777-7777-4777-8777-777777777777",
      },
    };

    useAppStore.getState().setExtensionUiRequest(first);
    useAppStore.getState().setExtensionUiRequest(second);
    useAppStore.getState().enqueueExtensionUiRequest(background);

    useAppStore.getState().closeExtensionUiRequest(second.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(first.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest("88888888-8888-4888-8888-888888888888");
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(first.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().setExtensionUiRequest(second);
    useAppStore.getState().closeExtensionUiRequest(first.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(second.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      background.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest(first.requestId);
    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(second.requestId);
    useAppStore.getState().closeExtensionUiRequest(background.requestId);
    expect(useAppStore.getState().extensionUiQueue).toEqual([]);
  });

  it("keeps background Extension UI queued until its Session becomes active", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().enqueueExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      title: "Background request",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s2",
        expectedSessionRevision: 1,
      },
    });

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionUiQueue).toHaveLength(1);

    useAppStore.getState().applySessionSnapshot(session("s2"));

    expect(useAppStore.getState().extensionUiRequest?.title).toBe("Background request");
    expect(useAppStore.getState().extensionUiQueue).toEqual([]);
  });

  it("presents a candidate request without losing the outgoing Session request", () => {
    const outgoing = {
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm" as const,
      title: "Outgoing request",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s1",
        expectedSessionRevision: 1,
      },
    };
    const candidate = {
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "input" as const,
      title: "Candidate request",
      context: {
        ...outgoing.context,
        expectedSessionId: "s2",
      },
    };

    useAppStore.getState().setExtensionUiRequest(outgoing);
    useAppStore.getState().presentCandidateExtensionUiRequest(candidate);

    expect(useAppStore.getState().extensionUiRequest?.requestId).toBe(candidate.requestId);
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      outgoing.requestId,
    ]);

    useAppStore.getState().closeExtensionUiRequest(candidate.requestId, "answered");

    expect(useAppStore.getState().extensionUiRequest).toBeNull();
    expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
      outgoing.requestId,
    ]);
  });

  it("derives expiry-aware waiting decision summaries by Session", () => {
    const now = 10_000;
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const active = {
      requestId: "active",
      kind: "confirm" as const,
      risk: "normal" as const,
      context,
    };
    const background = {
      requestId: "background",
      kind: "input" as const,
      risk: "high" as const,
      context: { ...context, expectedSessionId: "s2" },
    };
    const expired = {
      requestId: "expired",
      kind: "select" as const,
      expiresAt: now,
      context: { ...context, expectedSessionId: "s2" },
    };

    expect(deriveExtensionUiWaitingBySession(active, [active, background, expired], now)).toEqual({
      s1: { count: 1, hasHighRisk: false },
      s2: { count: 1, hasHighRisk: true },
    });
  });

  it("keeps a Session blocked through a decision group's waiting interval", () => {
    const context = {
      expectedHostInstanceId: "h1",
      expectedWorkspaceId: "w1",
      expectedWorkspaceRevision: 1,
      expectedSessionId: "s1",
      expectedSessionRevision: 1,
    };
    const group = {
      groupKey: "tool:blocking",
      context,
      presentation: "inline" as const,
      risk: "normal" as const,
      activeRequestId: null,
      answeredCount: 1,
      steps: [],
      status: "active" as const,
    };

    expect(isExtensionDecisionBlockingSession(null, { [group.groupKey]: group }, "s1")).toBe(true);
    expect(isExtensionDecisionBlockingSession(null, { [group.groupKey]: group }, "s2")).toBe(false);
    expect(
      isExtensionDecisionBlockingSession(
        null,
        { [group.groupKey]: { ...group, status: "completed" } },
        "s1",
      ),
    ).toBe(false);
  });

  it("stores Package progress globally and clears it on a new Host epoch", () => {
    useAppStore.getState().setPackageProgress({
      operationId: "11111111-1111-4111-8111-111111111111",
      type: "progress",
      action: "install",
      source: "npm:test",
      message: "working",
      lastEventAt: 123,
    });
    expect(useAppStore.getState().packageProgress?.message).toBe("working");

    useAppStore.getState().beginHostEpoch(host("h2"));
    expect(useAppStore.getState().packageProgress).toBeNull();
  });

  it("applies Package and Session mutation results through generation cleanup", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setThinkingLevels(["off", "high"]);
    useAppStore.getState().setExtensionUiRequest({
      requestId: "44444444-4444-4444-8444-444444444444",
      kind: "confirm",
      context: {
        expectedHostInstanceId: "h1",
        expectedWorkspaceId: "w",
        expectedWorkspaceRevision: 1,
        expectedSessionId: "s1",
        expectedSessionRevision: 1,
      },
    });

    useAppStore.getState().applyPackageMutationResult({
      operationId: "55555555-5555-4555-8555-555555555555",
      status: "committed",
      packageSnapshot: {
        revision: 2,
        workspaceId: "w",
        scope: "all",
        configured: [],
        resources: [],
        updateCheck: { supported: false },
        diagnostics: [],
      },
      session: { ...session("s2"), revision: 2 },
      warnings: [],
      reconcileRequired: false,
    });

    const state = useAppStore.getState();
    expect(state.packages?.revision).toBe(2);
    expect(state.session?.sessionId).toBe("s2");
    expect(state.extensionUiRequest).toBeNull();
    expect(state.extensionUiQueue).toEqual([]);
    expect(state.thinkingLevels).toEqual([]);
  });

  it("owns thinking levels for the active session generation", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().setThinkingLevels(["off", "high"]);
    expect(useAppStore.getState().thinkingLevels).toEqual(["off", "high"]);

    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().thinkingLevels).toEqual([]);
  });

  it("invalidates the chat model catalog after Provider changes", () => {
    expect(useAppStore.getState().providerConfigRevision).toBe(0);
    useAppStore.getState().refreshProviderConfig();
    useAppStore.getState().refreshProviderConfig();
    expect(useAppStore.getState().providerConfigRevision).toBe(2);
  });

  it("keeps Package retry state across navigation until reconciliation clears", () => {
    useAppStore.getState().setPackageRetry({
      method: "package.install",
      params: { source: "npm:test", scope: "user" },
    });
    useAppStore.getState().setPage("chat");
    useAppStore.getState().setPage("packages");
    expect(useAppStore.getState().packageRetry?.method).toBe("package.install");

    useAppStore.getState().applyPackageSnapshot({
      revision: 2,
      workspaceId: "w1",
      scope: "all",
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
    });
    expect(useAppStore.getState().packageRetry).toBeNull();
  });

  it("keeps the Session Catalog and live drafts across page navigation", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().replaceSessionCatalog("w1", [
      {
        sessionId: "s1",
        sessionPath: "/sessions/s1.jsonl",
        name: "Catalog session",
        cwd: "/p/w1",
        updatedAt: 1,
        messageCount: 2,
      },
    ]);
    const target = { kind: "session" as const, canonicalCwd: "/p/w1", sessionId: "s1" };
    useAppStore.getState().setDraftTextLocal(target, "unfinished prompt");

    useAppStore.getState().setPage("packages");
    useAppStore.getState().setPage("settings");
    useAppStore.getState().setPage("chat");

    const state = useAppStore.getState();
    expect(state.sessionCatalog.entries.s1?.name).toBe("Catalog session");
    expect(state.draftTexts["session:s1"]).toBe("unfinished prompt");
  });

  it("keeps live draft edits across Host restart and merges hydration only when untouched", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    const target = { kind: "session" as const, canonicalCwd: "/p/w1", sessionId: "s1" };
    useAppStore.getState().setDraftTextLocal(target, "live");

    useAppStore.getState().beginHostEpoch(host("h2"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore
      .getState()
      .mergeHydratedDrafts("/p/w1", [{ ...target, text: "stale disk", updatedAt: 1 }], {
        "session:s1": 0,
      });

    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("live");
  });

  it("hydrates an untouched new-conversation draft by canonical workspace", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().mergeHydratedDrafts(
      "/p/w1",
      [
        {
          kind: "new-conversation",
          canonicalCwd: "/p/w1",
          text: "restored",
          updatedAt: 1,
        },
      ],
      {},
    );

    expect(useAppStore.getState().draftTexts["new:/p/w1"]).toBe("restored");
    expect(useAppStore.getState().draftHydratedWorkspace).toBe("/p/w1");
  });

  it("ignores a workspace hydration result after switching elsewhere", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    useAppStore.getState().mergeHydratedDrafts(
      "/p/w1",
      [
        {
          kind: "new-conversation",
          canonicalCwd: "/p/w1",
          text: "wrong workspace",
          updatedAt: 1,
        },
      ],
      {},
    );

    expect(useAppStore.getState().draftTexts).toEqual({});
  });

  it("projects the active Pi snapshot into the Session Catalog runtime state", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("idle");

    useAppStore.getState().applySessionSnapshot({
      ...session("s1"),
      isIdle: false,
      isStreaming: true,
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");

    useAppStore.getState().applySessionSnapshot(session("s2"));
    // A still-busy previous session keeps its live state after switching away.
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");
    expect(useAppStore.getState().sessionCatalog.entries.s2?.runtimeState).toBe("idle");

    // An idle previous session is demoted to inactive on the next switch.
    useAppStore.getState().applySessionSnapshot(session("s3"));
    expect(useAppStore.getState().sessionCatalog.entries.s2?.runtimeState).toBe("inactive");

    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 20);
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");
  });

  it("keeps a still-busy previous session running when switching sessions", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // s1 starts a run; the user switches to s2 while s1 is still busy.
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    useAppStore.getState().applySessionSnapshot(session("s2"));

    // The switch must not demote s1 — its live dot stays visible.
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("running");
    expect(useAppStore.getState().sessionCatalog.entries.s2?.runtimeState).toBe("idle");
  });

  it("records an unacknowledged done marker when a busy session settles after switching away", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // Real event order: s1 runs (active) → user switches to s2 while busy →
    // the background run settles. The busy state must survive the switch so
    // the settle creates the done marker for the session the user left.
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    useAppStore.getState().applySessionSnapshot(session("s2"));
    useAppStore.getState().setSessionRuntimeState("s1", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
    });
  });

  it("records an unacknowledged done marker for a background session that settles", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applySessionSnapshot(session("s2"));

    // s1 runs in the background, then settles — a real busy→idle completion.
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    useAppStore.getState().setSessionRuntimeState("s1", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
    });
  });

  it("records completion when the settled snapshot arrives before runtime idle", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    // agent_settled is rendered first and projects the active snapshot to idle.
    useAppStore.getState().applySessionSnapshot(session("s1"));
    expect(useAppStore.getState().sessionCatalog.entries.s1?.runtimeState).toBe("idle");

    // The explicit runtime edge arrives afterwards and must still remember that
    // the previous explicit runtime state was busy. The marker remains
    // unacknowledged so the done dot shows on the active row.
    useAppStore.getState().setSessionRuntimeState("s1", "idle", undefined, 20);
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
    });
  });

  it("does not mark a session that was never busy as done", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applySessionSnapshot(session("s2"));

    // A plain idle announcement for an idle restored session is not a completion.
    useAppStore.getState().setSessionRuntimeState("s1", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toBeUndefined();
  });

  it("records an unacknowledged done marker for a session completing in focus and clears it on switch-away", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // s1 completes while in focus → the marker remains unacknowledged so the
    // status dot shows on the active row.
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    useAppStore.getState().setSessionRuntimeState("s1", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
    });

    // Switching away acknowledges the marker so the departed row stops showing it.
    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: true,
    });
  });

  it("records an unacknowledged failure for the session in focus and clears it on switch-away", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // s1 fails while focused → the error marker remains unacknowledged so the
    // red dot shows on the active row.
    useAppStore.getState().setSessionRuntimeState("s1", "error", "boom");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "error",
      acknowledged: false,
    });
    // Settling to idle preserves the unacknowledged error marker.
    useAppStore.getState().setSessionRuntimeState("s1", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "error",
      acknowledged: false,
    });

    // Switching to another session acknowledges the error marker.
    useAppStore.getState().applySessionSnapshot(session("s3"));
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "error",
      acknowledged: true,
    });
  });

  it("keeps an unacknowledged error marker across the settle-to-idle transition", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s2"));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    useAppStore.getState().setSessionRuntimeState("s2", "error", "boom");
    useAppStore.getState().setSessionRuntimeState("s2", "idle");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s2).toEqual({
      state: "error",
      acknowledged: false,
    });
  });

  it("acknowledgeSessionTerminalState is idempotent and persists", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applySessionSnapshot(session("s2"));
    useAppStore.getState().setSessionRuntimeState("s2", "error", "boom");

    const store = useAppStore.getState();
    store.acknowledgeSessionTerminalState("w1", "s2", "error");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s2).toEqual({
      state: "error",
      acknowledged: true,
    });

    const before = useAppStore.getState().sessionTerminalStates;
    useAppStore.getState().acknowledgeSessionTerminalState("w1", "s2", "error");
    expect(useAppStore.getState().sessionTerminalStates).toBe(before);
  });

  it("records an acknowledgement when only the catalog error state exists", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().replaceSessionCatalog("w1", [
      {
        sessionId: "s1",
        sessionPath: "/sessions/s1.jsonl",
        cwd: "/p/w1",
        updatedAt: 1,
        runtimeState: "error",
      },
    ]);

    useAppStore.getState().acknowledgeSessionTerminalState("w1", "s1", "error");

    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "error",
      acknowledged: true,
    });
  });

  it("merges cross-workspace terminal snapshots and reopens newer generations", () => {
    useAppStore.getState().mergeSessionTerminalSnapshots("w1", {
      s1: { state: "done", generation: 7 },
    });
    useAppStore.getState().acknowledgeSessionTerminalState("w1", "s1", "done");
    useAppStore.getState().mergeSessionTerminalSnapshots("w1", {
      s1: { state: "done", generation: 8 },
    });

    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
      generation: 8,
    });
  });

  it("merges cross-workspace terminal snapshots across runs", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10);
    useAppStore.getState().mergeSessionTerminalSnapshots("w1", {
      s1: { state: "done", generation: 1 },
    });
    useAppStore.getState().setSessionRuntimeState("s1", "idle", undefined, 20);

    // Switching to another session acknowledges the marker.
    useAppStore.getState().applySessionSnapshot(session("s2"));
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "done",
      acknowledged: true,
      generation: 1,
    });
  });

  it("removes terminal states for deleted sessions", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().applySessionSnapshot(session("s2"));
    useAppStore.getState().setSessionRuntimeState("s2", "error", "boom");

    useAppStore.getState().removeSessionTerminalStates("w1", ["s2"]);
    expect(useAppStore.getState().sessionTerminalStates.w1?.s2).toBeUndefined();
    expect(useAppStore.getState().sessionRuntimeStates.s2).toBeUndefined();
  });

  it("exposes workspace activity from the Host pool snapshot", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/w1": {
        busy: true,
        hasBeenBusy: true,
        errorCount: 1,
        doneCount: 2,
        terminalSessions: {
          s1: { state: "error", generation: 1 },
          s2: { state: "done", generation: 2 },
        },
      },
    });
    expect(useAppStore.getState().workspaceActivities["/p/w1"]).toEqual({
      busy: true,
      hasBeenBusy: true,
      errorCount: 1,
      doneCount: 2,
      terminalSessions: {
        s1: { state: "error", generation: 1 },
        s2: { state: "done", generation: 2 },
      },
    });
  });

  it("clears the Session Catalog only when the workspace epoch changes", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().replaceSessionCatalog("w1", [
      {
        sessionId: "s1",
        sessionPath: "/sessions/s1.jsonl",
        cwd: "/p/w1",
        updatedAt: 1,
      },
    ]);

    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 2));
    expect(useAppStore.getState().sessionCatalog).toEqual(emptySessionCatalog());
  });

  it("retains a bounded notification history with dismiss and clear actions", () => {
    for (let index = 0; index < 51; index += 1) {
      useAppStore.getState().pushNotification(`message-${index}`, "error");
    }
    const retained = useAppStore.getState().notifications;
    expect(retained).toHaveLength(50);
    expect(retained[0]?.message).toBe("message-1");
    expect(retained.at(-1)).toMatchObject({ message: "message-50", level: "error" });
    expect(typeof retained.at(-1)?.createdAt).toBe("number");

    useAppStore.getState().dismissNotification(retained.at(-1)!.id);
    expect(useAppStore.getState().notifications).toHaveLength(49);
    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toEqual([]);
    expect(useAppStore.getState().transientNotifications).toEqual([]);
  });

  it("anchorHostEpochForRecovery keeps the visible epoch until rehydrate completes", () => {
    const store = useAppStore.getState();
    store.beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));
    useAppStore.getState().markDesynchronized("sequence gap 3 -> 5");
    expect(useAppStore.getState().lastSequence).toBe(0);

    // The recovery loop anchors the fresh hello handshake: identity moves to
    // the new Host and the sequence watermark resets, but nothing the user is
    // looking at is torn down — an empty-shell repaint here is exactly the
    // "global refresh" regression this action exists to prevent.
    useAppStore.getState().anchorHostEpochForRecovery(host("h2"));

    let next = useAppStore.getState();
    expect(next.host?.hostInstanceId).toBe("h2");
    expect(next.lastSequence).toBe(0);
    expect(next.workspace?.id).toBe("w1");
    expect(next.session?.sessionId).toBe("s1");
    // The desync marker must hold until completeRehydrate — otherwise stray
    // events landing mid-recovery would apply against the stale snapshot.
    expect(next.desynchronized).toBe(true);

    useAppStore.getState().completeRehydrate({
      host: host("h2"),
      workspace: workspace("w1", 1),
      session: session("s2"),
      lastSequence: 12,
    });
    next = useAppStore.getState();
    expect(next.session?.sessionId).toBe("s2");
    expect(next.lastSequence).toBe(12);
    expect(next.desynchronized).toBe(false);
  });

  it("completeRehydrate rebuilds catalog/runtime records after a Host epoch change", () => {
    const store = useAppStore.getState();
    store.beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    // Catalog entry + flat runtime state accumulated under h1.
    useAppStore
      .getState()
      .replaceSessionCatalog("w1", [
        { sessionId: "s1", sessionPath: "/sessions/s1.jsonl", cwd: "/p/w1", updatedAt: 1 },
      ]);
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10, "w1");
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // The Host restarts: recovery anchors h2 while keeping the h1 view.
    useAppStore.getState().anchorHostEpochForRecovery(host("h2"));
    expect(useAppStore.getState().sessionCatalog.entries.s1).toBeDefined();

    useAppStore.getState().completeRehydrate({
      host: host("h2"),
      workspace: workspace("w1", 1),
      session: session("s2"),
      lastSequence: 12,
    });
    const next = useAppStore.getState();
    // Merging would retain s1 (a live session missing from the fresh catalog
    // is kept optimistically); the new Host epoch must instead rebuild the
    // catalog from the fresh snapshot so h1-only sessions cannot linger.
    expect(next.sessionCatalog.entries.s1).toBeUndefined();
    expect(next.sessionCatalog.entries.s2).toBeDefined();
    // Flat runtime bookkeeping from the dead epoch must not outlive it.
    expect(next.sessionRuntimeStates).toEqual({});
  });

  it("completeRehydrate keeps in-epoch runtime records across a same-host recovery", () => {
    const store = useAppStore.getState();
    store.beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore
      .getState()
      .replaceSessionCatalog("w1", [
        { sessionId: "s1", sessionPath: "/sessions/s1.jsonl", cwd: "/p/w1", updatedAt: 1 },
      ]);
    useAppStore.getState().setSessionRuntimeState("s1", "running", undefined, 10, "w1");
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // Same Host, no epoch change (e.g. a transport-level resync): nothing is
    // stale, so the catalog/runtime records must survive the rehydrate.
    useAppStore.getState().anchorHostEpochForRecovery(host("h1"));
    useAppStore.getState().completeRehydrate({
      host: host("h1"),
      workspace: workspace("w1", 1),
      session: session("s1", 2),
      lastSequence: 12,
    });
    const next = useAppStore.getState();
    expect(next.sessionCatalog.entries.s1).toBeDefined();
    expect(next.sessionRuntimeStates.s1).toBe("running");
  });

  it("keeps transient info/success notifications out of the history (toast only)", () => {
    useAppStore.getState().pushNotification("Agent 正忙，请等待当前运行结束后再试。");
    useAppStore.getState().pushNotification("Session exported", "success");
    useAppStore.getState().pushNotification("Disk is full", "error");
    useAppStore.getState().pushNotification("restart Pi Host to apply", "warning");

    // Info/success never enter the persistent history; error/warning do.
    const history = useAppStore.getState().notifications;
    expect(history.map((n) => n.message)).toEqual(["Disk is full", "restart Pi Host to apply"]);
    expect(history.every((n) => n.level === "error" || n.level === "warning")).toBe(true);

    // The transient feed holds exactly the toast-only entries, in arrival order.
    const transient = useAppStore.getState().transientNotifications;
    expect(transient.map((n) => n.message)).toEqual([
      "Agent 正忙，请等待当前运行结束后再试。",
      "Session exported",
    ]);
    // seq is a global arrival stamp: transient entries precede the persistent ones.
    expect(transient[0]!.seq).toBeLessThan(transient[1]!.seq ?? 0);
    expect(transient[1]!.seq ?? 0).toBeLessThan(history[0]!.seq ?? 0);

    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toEqual([]);
    expect(useAppStore.getState().transientNotifications).toEqual([]);
  });
});

describe("provider login flow state", () => {
  beforeEach(() => {
    useAppStore.setState({ providerLogin: null });
  });

  it("keeps a prompt adopted from an event that outran the loginStart response", () => {
    // API-key flows prompt synchronously on the host, so the loginEvent can
    // arrive before the loginStart RPC resolves and beginProviderLogin runs.
    useAppStore.getState().applyProviderLoginEvent({
      loginId: "login-1",
      providerId: "groq",
      event: {
        kind: "prompt",
        prompt: { promptId: "p1", kind: "secret", message: "Enter GROQ_API_KEY" },
      },
    });
    useAppStore.getState().beginProviderLogin("login-1", "groq");
    expect(useAppStore.getState().providerLogin?.prompt?.promptId).toBe("p1");
  });

  it("replaces state from a different login flow", () => {
    useAppStore.getState().beginProviderLogin("login-1", "groq");
    useAppStore.getState().applyProviderLoginEvent({
      loginId: "login-1",
      providerId: "groq",
      event: {
        kind: "prompt",
        prompt: { promptId: "p1", kind: "secret", message: "Enter GROQ_API_KEY" },
      },
    });
    useAppStore.getState().beginProviderLogin("login-2", "anthropic");
    const state = useAppStore.getState().providerLogin;
    expect(state?.loginId).toBe("login-2");
    expect(state?.prompt).toBeNull();
  });
});

describe("Extension message renderer state", () => {
  beforeEach(() => {
    useAppStore.setState({ session: session("s-render") });
  });

  it("merges and removes renderer snapshots without replacing the Session", () => {
    const render = { version: 1 as const, collapsed: ["working"], expanded: ["done"] };
    useAppStore.getState().setExtensionMessageRender("entry-1", render);
    expect(useAppStore.getState().session?.extensionMessageRenders).toEqual({
      "entry-1": render,
    });

    useAppStore.getState().setExtensionMessageRender("entry-1", null);
    expect(useAppStore.getState().session?.extensionMessageRenders).toBeUndefined();
  });
});

describe("settings nav cache", () => {
  beforeEach(() => {
    useAppStore.getState().setPage("chat");
    useAppStore.setState({ workspace: null, settingsSection: null, settingsNavCache: null });
  });

  function seedCache(section: SettingsSection, savedAt = Date.now()) {
    useAppStore.getState().setSettingsNavCache({
      workspaceId: "w1",
      section,
      scroll: { [section]: 120 },
      savedAt,
    });
  }

  it("returns to the remembered section on a generic open within the TTL", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("providers");
    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().page).toBe("settings");
    expect(useAppStore.getState().settingsSection).toBe("providers");
  });

  it("restores the cache for the generic openSettingsSection('general')", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("skills");
    useAppStore.getState().openSettingsSection("general");
    expect(useAppStore.getState().settingsSection).toBe("skills");
  });

  it("expires the cache after 30 minutes and falls back to general", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("host", Date.now() - 31 * 60 * 1000);
    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().settingsSection).toBeNull();
    expect(useAppStore.getState().settingsNavCache).toBeNull();
  });

  it("drops the cache when switching to another workspace", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("host");
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 1));
    expect(useAppStore.getState().settingsNavCache).toBeNull();
  });

  it("keeps the cache across a revision bump of the same workspace", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("host");
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 2));
    expect(useAppStore.getState().settingsNavCache).not.toBeNull();
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 3));
    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().settingsSection).toBe("host");
  });

  it("clears a cache belonging to a different workspace on open", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w2", 1));
    seedCache("host"); // cache is scoped to w1
    useAppStore.getState().setPage("settings");
    expect(useAppStore.getState().settingsSection).toBeNull();
    expect(useAppStore.getState().settingsNavCache).toBeNull();
  });

  it("keeps explicit section opens even when a cache exists", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    seedCache("providers");
    useAppStore.getState().openSettingsSection("host");
    expect(useAppStore.getState().settingsSection).toBe("host");
  });

  it("clears the section request when leaving for chat", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().setSettingsSection("host");
    useAppStore.getState().setPage("chat");
    expect(useAppStore.getState().settingsSection).toBeNull();
  });
});

describe("bound-workspace bookkeeping (shared-host multi-workspace)", () => {
  beforeEach(() => {
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      sessionCatalog: emptySessionCatalog(),
      sessionRuntimeStates: {},
      boundWorkspaces: {},
      sessionTerminalStates: {},
      desynchronized: false,
      lastSequence: 0,
    });
  });

  it("seeds the map from the hello status's boundWorkspaces", () => {
    useAppStore.getState().beginHostEpoch({
      ...host("h1"),
      boundWorkspaces: [
        { workspaceId: "w-active", revision: 1, cwd: "/p/active" },
        { workspaceId: "w-parked", revision: 3, cwd: "/p/parked" },
      ],
    });
    expect(useAppStore.getState().boundWorkspaces).toEqual({
      "w-active": { revision: 1, cwd: "/p/active" },
      "w-parked": { revision: 3, cwd: "/p/parked" },
    });

    // A new epoch without the field (older Host) resets the map.
    useAppStore.getState().beginHostEpoch(host("h2"));
    expect(useAppStore.getState().boundWorkspaces).toEqual({});
  });

  it("replaces the map from a status list and keeps it on undefined", () => {
    useAppStore.getState().applyBoundWorkspaces([{ workspaceId: "w1", revision: 1, cwd: "/p/1" }]);
    useAppStore.getState().applyBoundWorkspaces([
      { workspaceId: "w2", revision: 2, cwd: "/p/2" },
      { workspaceId: "w3", revision: 3, cwd: "/p/3" },
    ]);
    expect(useAppStore.getState().boundWorkspaces).toEqual({
      w2: { revision: 2, cwd: "/p/2" },
      w3: { revision: 3, cwd: "/p/3" },
    });

    // An undefined list (older Host / field omitted) is not emptiness.
    useAppStore.getState().applyBoundWorkspaces(undefined);
    expect(useAppStore.getState().boundWorkspaces["w2"]).toBeDefined();
  });

  it("upserts and refreshes single entries", () => {
    useAppStore.getState().upsertBoundWorkspace("w1", 1, "/p/1");
    expect(useAppStore.getState().boundWorkspaces["w1"]).toEqual({ revision: 1, cwd: "/p/1" });
    useAppStore.getState().upsertBoundWorkspace("w1", 2, "/p/1");
    expect(useAppStore.getState().boundWorkspaces["w1"]).toEqual({ revision: 2, cwd: "/p/1" });
  });

  it("upserts the active workspace from workspace snapshots", () => {
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    expect(useAppStore.getState().boundWorkspaces["w1"]).toEqual({ revision: 1, cwd: "/p/w1" });

    // A revision bump refreshes the entry; a parked entry is not dropped.
    useAppStore.getState().upsertBoundWorkspace("w2", 5, "/p/w2");
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 2));
    expect(useAppStore.getState().boundWorkspaces).toEqual({
      w1: { revision: 2, cwd: "/p/w1" },
      w2: { revision: 5, cwd: "/p/w2" },
    });
  });

  it("re-seeds from the rehydrate Host snapshot", () => {
    useAppStore
      .getState()
      .applyBoundWorkspaces([{ workspaceId: "w-old", revision: 1, cwd: "/p/old" }]);
    useAppStore.getState().completeRehydrate({
      host: {
        ...host("h1"),
        boundWorkspaces: [{ workspaceId: "w-new", revision: 2, cwd: "/p/new" }],
      },
    });
    expect(useAppStore.getState().boundWorkspaces).toEqual({
      "w-new": { revision: 2, cwd: "/p/new" },
    });
  });

  it("keys runtime markers by the owning workspace for parked events", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // Parked workspace w2's session settles: busy→idle edge arrives from w2.
    useAppStore.getState().setSessionRuntimeState("s2", "running", undefined, 10, "w2");
    useAppStore.getState().setSessionRuntimeState("s2", "idle", undefined, 20, "w2");

    const state = useAppStore.getState();
    expect(state.sessionTerminalStates.w2?.s2).toEqual({ state: "done", acknowledged: false });
    expect(state.sessionTerminalStates.w1?.s2).toBeUndefined();
    // Flat runtime state is recorded regardless of ownership.
    expect(state.sessionRuntimeStates.s2).toBe("idle");
    // The active workspace's catalog is untouched by parked events.
    expect(state.sessionCatalog.entries.s2).toBeUndefined();
  });

  it("keeps the active workspace's catalog and markers without ownership info", () => {
    useAppStore.getState().beginHostEpoch(host("h1"));
    useAppStore.getState().applyWorkspaceSnapshot(workspace("w1", 1));
    useAppStore.getState().applySessionSnapshot(session("s1"));

    // Local optimistic rollback (no owning workspace) keeps legacy behavior.
    useAppStore.getState().setSessionRuntimeState("s1", "error", "boom");
    expect(useAppStore.getState().sessionTerminalStates.w1?.s1).toEqual({
      state: "error",
      acknowledged: false,
    });
    expect(useAppStore.getState().sessionCatalog.entries.s1?.lastError).toBe("boom");
  });
});
