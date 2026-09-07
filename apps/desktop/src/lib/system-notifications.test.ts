import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEventEnvelope } from "@piabyss/protocol";
import { useAppStore } from "./stores/app-store";
import {
  SystemNotificationController,
  SystemNotificationTracker,
  systemNotificationCopy,
  type SystemNotificationTarget,
} from "./system-notifications";

const notifyMocks = vi.hoisted(() => {
  const state = {
    permission: "granted" as "granted" | "denied",
    permissionGate: null as Promise<void> | null,
    onActionShouldReject: false,
    actionHandler: null as ((notification: { extra?: unknown }) => void) | null,
    invoke: vi.fn(async () => undefined),
  };
  return state;
});

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => {
    if (notifyMocks.permissionGate) await notifyMocks.permissionGate;
    return notifyMocks.permission === "granted";
  }),
  requestPermission: vi.fn(async () => notifyMocks.permission),
  onAction: vi.fn(async (handler: (notification: { extra?: unknown }) => void) => {
    if (notifyMocks.onActionShouldReject) throw new Error("no action listener");
    notifyMocks.actionHandler = handler;
    return { unregister: async () => {} };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: notifyMocks.invoke,
  isTauri: vi.fn(() => true),
}));

const target: SystemNotificationTarget = {
  workspaceId: "workspace-1",
  workspaceRevision: 2,
  workspacePath: "/workspace",
  sessionId: "session-1",
  sessionPath: "/workspace/session.jsonl",
  sessionRevision: 4,
};

function event(
  eventName: HostEventEnvelope["event"],
  payload: unknown,
  overrides: Partial<HostEventEnvelope> = {},
): HostEventEnvelope {
  return {
    protocolVersion: 1,
    hostInstanceId: "host-1",
    workspaceId: "workspace-1",
    workspaceRevision: 2,
    sessionId: "session-1",
    sessionRevision: 4,
    packageRevision: 1,
    sequence: 1,
    timestamp: 1,
    event: eventName,
    payload,
    ...overrides,
  } as HostEventEnvelope;
}

function context(attention: "foreground" | "background" | "unknown" = "background") {
  return {
    attention,
    targetForSession: () => target,
  };
}

describe("SystemNotificationTracker", () => {
  it("notifies for a background response once and suppresses foreground events", () => {
    const tracker = new SystemNotificationTracker();
    const response = event("agent.event", {
      runId: "run-1",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });
    const backgroundResponse = event("agent.event", {
      runId: "run-1-background",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(response, context("foreground"))).toBeNull();
    expect(tracker.observe(response, context())).toBeNull();
    expect(tracker.observe(backgroundResponse, context())).toMatchObject({
      kind: "response-ready",
      target,
    });
  });

  it("waits through retries and suppresses aborted responses", () => {
    const tracker = new SystemNotificationTracker();
    const retry = event("agent.event", {
      runId: "run-2",
      event: { type: "agent_end", willRetry: true, messages: [] },
    });
    const final = event("agent.event", {
      runId: "run-2",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });
    const aborted = event("agent.event", {
      runId: "run-3",
      event: {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
    });

    expect(tracker.observe(retry, context())).toBeNull();
    expect(tracker.observe(final, context())).toMatchObject({ kind: "response-ready" });
    expect(tracker.observe(aborted, context())).toBeNull();
  });

  it("does not duplicate a failure reported before agent_end", () => {
    const tracker = new SystemNotificationTracker();
    const failure = event("agent.event", {
      runId: "run-4",
      event: { type: "error", message: "x" },
    });
    const end = event("agent.event", {
      runId: "run-4",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(failure, context())).toMatchObject({ kind: "session-failed" });
    expect(tracker.observe(end, context())).toBeNull();
  });

  it("does not replay a foreground failure after the session moves to background", () => {
    const tracker = new SystemNotificationTracker();
    const failure = event("agent.event", {
      runId: "run-foreground-error",
      event: { type: "error" },
    });
    const end = event("agent.event", {
      runId: "run-foreground-error",
      event: { type: "agent_end", willRetry: false, messages: [] },
    });

    expect(tracker.observe(failure, context("foreground"))).toBeNull();
    expect(tracker.observe(end, context())).toBeNull();
  });

  it("notifies for input-required and Host fatal attention", () => {
    const tracker = new SystemNotificationTracker();
    expect(
      tracker.observe(
        event("extensionUi.request", { requestId: "request-1", kind: "confirm" }),
        context(),
      ),
    ).toMatchObject({ kind: "input-required", target });
    expect(tracker.observe(event("host.fatal", { error: { message: "down" } }), context())).toEqual(
      {
        kind: "host-fatal",
      },
    );
  });
});

describe("systemNotificationCopy", () => {
  afterEach(() => useAppStore.getState().setDesktopSettings(null));

  it.each([
    ["en", "A response is ready"],
    ["zh", "有新的回复"],
  ] as const)("uses the %s locale", (language, body) => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language,
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    });
    expect(systemNotificationCopy("response-ready")).toEqual({ title: "PiAbyss", body });
  });

  it.each([
    ["en", "A response is ready — Fix login"],
    ["zh", "有新的回复 — Fix login"],
  ] as const)("appends the session name under the %s locale", (language, body) => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language,
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    });
    expect(systemNotificationCopy("response-ready", "Fix login")).toEqual({
      title: "PiAbyss",
      body,
    });
    expect(systemNotificationCopy("response-ready", "   ")).toEqual({
      title: "PiAbyss",
      body: body.split(" — ")[0]!,
    });
  });
});

describe("SystemNotificationController", () => {
  let attentionState: "foreground" | "background" | "unknown";
  let controller: SystemNotificationController;
  const openTarget = vi.fn(async () => {});

  function agentEndEvent(runId: string): HostEventEnvelope {
    return {
      protocolVersion: 1,
      hostInstanceId: "host-1",
      workspaceId: "workspace-1",
      workspaceRevision: 2,
      sessionId: "session-1",
      sessionRevision: 4,
      packageRevision: 1,
      sequence: 1,
      timestamp: 1,
      event: "agent.event",
      payload: { runId, event: { type: "agent_end", willRetry: false, messages: [] } },
    } as HostEventEnvelope;
  }

  function makeController(): SystemNotificationController {
    return new SystemNotificationController({
      enabled: () => useAppStore.getState().desktopSettings?.systemNotificationsEnabled ?? true,
      attention: () => attentionState,
      targetForSession: () => target,
      openTarget,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    notifyMocks.permission = "granted";
    notifyMocks.permissionGate = null;
    notifyMocks.onActionShouldReject = false;
    notifyMocks.actionHandler = null;
    attentionState = "background";
    controller = makeController();
  });

  afterEach(() => {
    controller.dispose();
  });

  it("delivers a background completion through the OS command", async () => {
    controller.observe(agentEndEvent("run-1"));
    await vi.waitFor(() => expect(notifyMocks.invoke).toHaveBeenCalled());
    expect(notifyMocks.invoke).toHaveBeenCalledWith(
      "plugin:notification|notify",
      expect.objectContaining({
        options: expect.objectContaining({
          title: "PiAbyss",
          extra: { kind: "response-ready", target },
        }),
      }),
    );
  });

  it("suppresses candidates while the window is in the foreground", async () => {
    attentionState = "foreground";
    controller.observe(agentEndEvent("run-fg"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifyMocks.invoke).not.toHaveBeenCalled();
  });

  it("suppresses candidates when the setting is disabled", async () => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      systemNotificationsEnabled: false,
    });
    try {
      controller.observe(agentEndEvent("run-disabled"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(notifyMocks.invoke).not.toHaveBeenCalled();
    } finally {
      useAppStore.getState().setDesktopSettings(null);
    }
  });

  it("sticks a permission denial and stops requesting again", async () => {
    notifyMocks.permission = "denied";
    controller.observe(agentEndEvent("run-denied"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifyMocks.invoke).not.toHaveBeenCalled();

    controller.observe(agentEndEvent("run-denied-2"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("drops a queued alert when focus returns before permission settles", async () => {
    const gate: { release?: () => void } = {};
    notifyMocks.permissionGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    controller.observe(agentEndEvent("run-race"));
    // Let the queue reach the permission check, then flip focus.
    await new Promise((resolve) => setTimeout(resolve, 10));
    attentionState = "foreground";
    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifyMocks.invoke).not.toHaveBeenCalled();
  });

  it("does not deliver after dispose", async () => {
    controller.observe(agentEndEvent("run-disposed"));
    controller.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifyMocks.invoke).not.toHaveBeenCalled();
  });

  it("routes validated click actions to openTarget", async () => {
    await controller.start();
    expect(notifyMocks.actionHandler).toBeTypeOf("function");
    notifyMocks.actionHandler!({ extra: { kind: "response-ready", target } });
    await vi.waitFor(() => expect(openTarget).toHaveBeenCalledWith(target));
  });

  it("ignores click payloads that fail validation", async () => {
    await controller.start();
    notifyMocks.actionHandler!({ extra: { kind: "bogus" } });
    notifyMocks.actionHandler!({ extra: { kind: "response-ready", target: { workspaceId: 7 } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("still delivers when the action listener cannot register", async () => {
    notifyMocks.onActionShouldReject = true;
    await controller.start();
    controller.observe(agentEndEvent("run-no-listener"));
    await vi.waitFor(() => expect(notifyMocks.invoke).toHaveBeenCalled());
    expect(notifyMocks.invoke).toHaveBeenCalledWith(
      "plugin:notification|notify",
      expect.objectContaining({
        options: expect.objectContaining({ extra: { kind: "response-ready", target } }),
      }),
    );
  });
});
