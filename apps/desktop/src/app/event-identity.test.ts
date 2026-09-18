import { describe, expect, it } from "vitest";
import type { HostEventEnvelope, HostStatusSnapshot, SessionSnapshot } from "@piabyss/protocol";
import { HostClient } from "../lib/bridge/host-client";
import { applySessionSnapshot, emptyEpoch } from "../lib/stores/epoch-store";
import { expectedIdentityForEvent, extensionUiRequestDelivery } from "./event-identity";

const state = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 4,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 7,
};

function event(
  name: HostEventEnvelope["event"],
  overrides: Partial<HostEventEnvelope> = {},
): HostEventEnvelope {
  return {
    protocolVersion: 1,
    event: name,
    hostInstanceId: state.hostInstanceId,
    workspaceId: state.workspaceId,
    workspaceRevision: state.workspaceRevision,
    sessionId: state.sessionId,
    sessionRevision: state.sessionRevision,
    packageRevision: 2,
    sequence: 10,
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  } as HostEventEnvelope;
}

describe("expectedIdentityForEvent", () => {
  const client = new HostClient();

  it("allows authoritative workspace snapshots to advance the workspace generation", () => {
    const incoming = event("workspace.changed", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: 5,
      sessionId: null,
      sessionRevision: 8,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("allows session and package snapshots to advance the session generation", () => {
    for (const name of [
      "session.snapshot",
      "package.snapshot",
      "package.resourcesChanged",
    ] as const) {
      const incoming = event(name, { sessionRevision: state.sessionRevision + 1 });
      expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
        true,
      );
    }
  });

  it("allows a candidate Extension UI request to carry its response identity before snapshots", () => {
    const incoming = event("extensionUi.request", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: state.workspaceRevision + 1,
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: state.sessionRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("allows a candidate Extension UI close before snapshots", () => {
    const incoming = event("extensionUi.closed", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: state.workspaceRevision + 1,
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: state.sessionRevision + 1,
      payload: {
        requestId: "66666666-6666-4666-8666-666666666666",
        reason: "aborted",
      },
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("allows a candidate Extension UI group close before snapshots", () => {
    const incoming = event("extensionUi.groupClosed", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: state.workspaceRevision + 1,
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: state.sessionRevision + 1,
      payload: {
        groupKey: "tool:0123456789abcdef",
        status: "completed",
      },
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("still rejects non-authoritative events from a different session generation", () => {
    const incoming = event("agent.toolsChanged", {
      sessionRevision: state.sessionRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      false,
    );
  });

  it("accepts tools immediately after an authoritative Session transition", () => {
    const nextSession: SessionSnapshot = {
      sessionId: "55555555-5555-4555-8555-555555555555",
      cwd: "/workspace",
      revision: state.sessionRevision + 1,
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pending: { revision: 0, steering: [], followUp: [] },
      messages: [],
      tools: {
        revision: 1,
        workspaceId: state.workspaceId,
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionRevision: state.sessionRevision + 1,
        tools: [],
        active: [],
      },
    };
    const epoch = applySessionSnapshot(
      { ...emptyEpoch(), host: state as HostStatusSnapshot },
      nextSession,
    );
    const incoming = event("agent.toolsChanged", {
      sessionId: nextSession.sessionId,
      sessionRevision: nextSession.revision,
      payload: nextSession.tools,
    });
    const currentIdentity = {
      hostInstanceId: epoch.host?.hostInstanceId ?? null,
      workspaceId: epoch.host?.workspaceId ?? null,
      workspaceRevision: epoch.host?.workspaceRevision,
      sessionId: epoch.host?.sessionId ?? null,
      sessionRevision: epoch.host?.sessionRevision,
    };

    expect(
      client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, currentIdentity)),
    ).toBe(true);
  });

  it("accepts a runtime update from a background Session in the current Workspace", () => {
    const incoming = event("session.runtimeChanged", {
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionRevision: 3,
      payload: {
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionRevision: 3,
        state: "running",
        updatedAt: 1,
      },
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      true,
    );
  });

  it("accepts background Session events that are routed or safely ignored", () => {
    for (const name of [
      "session.infoChanged",
      "agent.event",
      "package.diagnostic",
      "extensionUi.statusChanged",
      "extensionUi.widgetChanged",
      "extensionUi.widgetAttentionRequested",
      "extensionUi.notification",
    ] as const) {
      const incoming = event(name, {
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionRevision: 3,
      });
      expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
        true,
      );
    }
  });

  it("still rejects snapshots from a different workspace generation", () => {
    const incoming = event("package.snapshot", {
      workspaceRevision: state.workspaceRevision + 1,
    });

    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      false,
    );
  });

  it("accepts git.changed across Session switches and package reloads", () => {
    // A watcher armed under Session A keeps emitting after the user switches to
    // Session B, and a package reload only bumps the Session revision. Git state
    // is workspace-scoped, so neither may reject the event.
    for (const stale of [
      { sessionId: "55555555-5555-4555-8555-555555555555", sessionRevision: 3 },
      { sessionId: state.sessionId, sessionRevision: state.sessionRevision + 1 },
      { sessionId: null, sessionRevision: 0 },
    ]) {
      const incoming = event("git.changed", stale);
      expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
        true,
      );
    }
  });

  it("still rejects git.changed from another workspace generation", () => {
    const incoming = event("git.changed", { workspaceRevision: state.workspaceRevision + 1 });
    expect(client.shouldAcceptEvent(incoming, expectedIdentityForEvent(incoming, state))).toBe(
      false,
    );
  });

  it("narrows git.taskFinished to the Host plus workspace generation", () => {
    // A parked workspace's revision is validated against the bound-workspace map
    // by App.handleHostEvent (which excuses the Session stamp); this identity
    // helper only guarantees the Host and workspace never drift silently.
    const parked = event("git.taskFinished", {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      workspaceRevision: 5,
      sessionId: null,
      sessionRevision: 0,
      payload: { taskId: "t", operation: "pull", workspaceName: "w", ok: true },
    });
    expect(client.shouldAcceptEvent(parked, expectedIdentityForEvent(parked, state))).toBe(false);

    const foreign = event("git.taskFinished", {
      hostInstanceId: "99999999-9999-4999-8999-999999999999",
    });
    expect(client.shouldAcceptEvent(foreign, expectedIdentityForEvent(foreign, state))).toBe(false);

    const activeWorkspace = event("git.taskFinished", {
      sessionId: null,
      sessionRevision: 0,
      payload: { taskId: "t", operation: "pull", workspaceName: "w", ok: true },
    });
    expect(
      client.shouldAcceptEvent(activeWorkspace, expectedIdentityForEvent(activeWorkspace, state)),
    ).toBe(true);
  });
});

describe("extensionUiRequestDelivery", () => {
  it("keeps the active Session on the ordinary request path", () => {
    expect(
      extensionUiRequestDelivery({
        eventSessionId: state.sessionId,
        activeSessionId: state.sessionId,
        catalogRuntimeState: "running",
      }),
    ).toBe("active");
  });

  it("queues a known running background Session request", () => {
    expect(
      extensionUiRequestDelivery({
        eventSessionId: "55555555-5555-4555-8555-555555555555",
        activeSessionId: state.sessionId,
        catalogRuntimeState: "running",
      }),
    ).toBe("background");
  });

  it("prioritizes a candidate Session request before its snapshot commits", () => {
    expect(
      extensionUiRequestDelivery({
        eventSessionId: "55555555-5555-4555-8555-555555555555",
        activeSessionId: state.sessionId,
        catalogRuntimeState: "inactive",
      }),
    ).toBe("candidate");
  });

  it("treats a not-yet-catalogued Session as a candidate", () => {
    expect(
      extensionUiRequestDelivery({
        eventSessionId: "55555555-5555-4555-8555-555555555555",
        activeSessionId: state.sessionId,
      }),
    ).toBe("candidate");
  });
});
