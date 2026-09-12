import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostResponseEnvelope,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { activateWorkspaceHost, prepareWorkspaceHost } from "./tauri-transport";
import { waitForWorkspaceActivation } from "../../features/workspaces/workspace-switch-policy";
import { hostClient } from "./host-client";
import { useAppStore } from "../stores/app-store";
import { openSessionAcrossWorkspaces } from "./session-navigation";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_SESSION_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("./tauri-transport", () => ({
  activateWorkspaceHost: vi.fn(async () => false),
  prepareWorkspaceHost: vi.fn(async () => false),
  rebindActiveWorkspaceHost: vi.fn(async () => false),
  replayActiveHostReady: vi.fn(async () => false),
  acknowledgeSessionTerminal: vi.fn(async () => {}),
}));
vi.mock("../../features/workspaces/workspace-switch-policy", () => ({
  workspaceHasActiveAgent: vi.fn(() => false),
  isWorkspaceSwitchBusyError: vi.fn(
    (error: { code?: string }) =>
      error.code === "AGENT_BUSY" || error.code === "SERVICE_GRAPH_BUSY",
  ),
  waitForWorkspaceActivation: vi.fn(async () => {}),
}));
vi.mock("./host-context", () => ({
  mergeHostIdentity: vi.fn((host: object) => host),
  workspaceContext: vi.fn((host: object, workspace: object) => ({
    ...host,
    ...workspace,
  })),
  nullableSessionContext: vi.fn(() => ({})),
}));

function host(): ReturnType<typeof useAppStore.getState>["host"] {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.84.2",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  } as ReturnType<typeof useAppStore.getState>["host"];
}

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/proj/current",
    canonicalCwd: "/proj/current",
    revision: 1,
    servicesReady: true,
    ...overrides,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    sessionPath: "/sessions/current/active.jsonl",
    cwd: "/proj/current",
    revision: 3,
    name: "Active session",
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  } as SessionSnapshot;
}

function envelope<T>(method: string, result: T): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

function errorEnvelope(method: string, code: string): HostResponseEnvelope {
  return {
    ...envelope(method, null),
    ok: false,
    error: { code, message: code },
  } as HostResponseEnvelope;
}

function otherWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    id: OTHER_WORKSPACE_ID,
    cwd: "/proj/other",
    canonicalCwd: "/proj/other",
    revision: 4,
    servicesReady: true,
  };
}

function openedSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return session({
    sessionId: TARGET_SESSION_ID,
    sessionPath: "/sessions/current/target.jsonl",
    name: "Target session",
    ...overrides,
  });
}

describe("openSessionAcrossWorkspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.open", openedSession()) as never,
    );
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHostFatal(null);
    useAppStore.getState().setRehydrating(false);
    useAppStore.getState().setConnecting(false);
    useAppStore.getState().setDesktopSettings(null);
  });

  function dedicatedHostMode(): void {
    // These tests pin the dedicated-Host flow: shared-host mode is the
    // default, so opt out explicitly.
    useAppStore.getState().setDesktopSettings({ sharedHostMode: false } as DesktopSettings);
  }

  it("blocks when no Host is attached", async () => {
    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/current",
      sessionPath: "/sessions/current/target.jsonl",
    });
    expect(outcome.status).toBe("blocked");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("blocks while connecting, rehydrating, or after a fatal error", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().setConnecting(true);
    expect(
      (await openSessionAcrossWorkspaces({ cwd: "/proj/current", sessionPath: "/x" })).status,
    ).toBe("blocked");

    useAppStore.getState().setConnecting(false);
    useAppStore.getState().setRehydrating(true);
    expect(
      (await openSessionAcrossWorkspaces({ cwd: "/proj/current", sessionPath: "/x" })).status,
    ).toBe("blocked");

    useAppStore.getState().setRehydrating(false);
    useAppStore.getState().setHostFatal("host down");
    expect(
      (await openSessionAcrossWorkspaces({ cwd: "/proj/current", sessionPath: "/x" })).status,
    ).toBe("blocked");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("opens a same-workspace session and applies the snapshot", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/current",
      sessionPath: "/sessions/current/target.jsonl",
    });

    expect(outcome.status).toBe("opened");
    expect(useAppStore.getState().session?.sessionId).toBe(TARGET_SESSION_ID);
    expect(hostClient.request).toHaveBeenCalledTimes(1);
    expect(hostClient.request).toHaveBeenCalledWith(
      "session.open",
      expect.objectContaining({ expectedHostInstanceId: HOST_ID }),
      { sessionPath: "/sessions/current/target.jsonl" },
      expect.any(Number),
    );
  });

  it("reports already-active without reopening the session", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/current",
      sessionPath: "/sessions/current/active.jsonl",
    });

    expect(outcome.status).toBe("already-active");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("matches already-active by sessionId for pathless targets", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/current",
      sessionId: SESSION_ID,
    });

    expect(outcome.status).toBe("already-active");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("stops with archived when the target session is archived", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/current",
      sessionPath: "/sessions/current/target.jsonl",
      archived: true,
    });

    expect(outcome.status).toBe("archived");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("stops with archived when the resolver reports an archived session", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces(
      { cwd: "/proj/current", sessionId: TARGET_SESSION_ID },
      {
        resolveSessionPath: vi.fn(async () => ({
          sessionPath: "/sessions/current/target.jsonl",
          archived: true,
        })),
      },
    );

    expect(outcome.status).toBe("archived");
    expect(hostClient.request).not.toHaveBeenCalled();
  });

  it("resolves pathless same-workspace targets through the resolver", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces(
      { cwd: "/proj/current", sessionId: TARGET_SESSION_ID },
      {
        resolveSessionPath: vi.fn(async () => ({
          sessionPath: "/sessions/current/target.jsonl",
        })),
      },
    );

    expect(outcome.status).toBe("opened");
    expect(useAppStore.getState().session?.sessionId).toBe(TARGET_SESSION_ID);
  });

  it("fails with a notification when the resolver cannot find the session", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces(
      { cwd: "/proj/current", sessionId: TARGET_SESSION_ID },
      { resolveSessionPath: vi.fn(async () => null) },
    );

    expect(outcome.status).toBe("failed");
    expect(
      useAppStore.getState().notifications.some((notification) => notification.message.length > 0),
    ).toBe(true);
  });

  it("fails with a notification when the resolver throws", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const outcome = await openSessionAcrossWorkspaces(
      { cwd: "/proj/current", sessionId: TARGET_SESSION_ID },
      {
        resolveSessionPath: vi.fn(async () => {
          throw new Error("transport detached");
        }),
      },
    );

    expect(outcome.status).toBe("failed");
    expect(
      useAppStore.getState().notifications.some((notification) => notification.message.length > 0),
    ).toBe(true);
  });

  it("falls back to workspace.setCurrent when dedicated activation is unavailable", async () => {
    dedicatedHostMode();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "workspace.setCurrent") {
        return {
          ...envelope("workspace.setCurrent", {
            workspace: otherWorkspaceSnapshot(),
            session: openedSession({ cwd: "/proj/other" }),
          }),
          workspaceId: OTHER_WORKSPACE_ID,
          workspaceRevision: 4,
          sessionId: TARGET_SESSION_ID,
          sessionRevision: 1,
          packageRevision: 1,
        } as never;
      }
      return envelope("session.open", openedSession({ cwd: "/proj/other" })) as never;
    });

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/other",
      sessionPath: "/sessions/other/target.jsonl",
    });

    expect(outcome.status).toBe("opened");
    expect(request).toHaveBeenCalledWith(
      "workspace.setCurrent",
      expect.objectContaining({ hostInstanceId: HOST_ID }),
      { cwd: "/proj/other", optimistic: true },
      60_000,
    );
    expect(useAppStore.getState().workspace?.id).toBe(OTHER_WORKSPACE_ID);
    expect(useAppStore.getState().session?.sessionId).toBe(TARGET_SESSION_ID);
  });

  it("switches workspace in place in shared-host mode without preparing a dedicated host", async () => {
    // Settings unset → shared-host mode is the default. The in-place setCurrent
    // path must run without any dedicated-Host activation.
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "workspace.setCurrent") {
        return {
          ...envelope("workspace.setCurrent", {
            workspace: otherWorkspaceSnapshot(),
            session: openedSession({ cwd: "/proj/other" }),
          }),
          workspaceId: OTHER_WORKSPACE_ID,
          workspaceRevision: 4,
          sessionId: TARGET_SESSION_ID,
          sessionRevision: 1,
          packageRevision: 1,
        } as never;
      }
      return envelope("session.open", openedSession({ cwd: "/proj/other" })) as never;
    });

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/other",
      sessionPath: "/sessions/other/target.jsonl",
    });

    expect(outcome.status).toBe("opened");
    expect(prepareWorkspaceHost).not.toHaveBeenCalled();
    expect(activateWorkspaceHost).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "workspace.setCurrent",
      expect.objectContaining({ hostInstanceId: HOST_ID }),
      { cwd: "/proj/other", optimistic: true },
      60_000,
    );
    expect(useAppStore.getState().workspace?.id).toBe(OTHER_WORKSPACE_ID);
    expect(useAppStore.getState().session?.sessionId).toBe(TARGET_SESSION_ID);
  });

  it("retries a transient SERVICE_GRAPH_BUSY switch and succeeds", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());

    let setCurrentCalls = 0;
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "workspace.setCurrent") {
        setCurrentCalls += 1;
        if (setCurrentCalls === 1) {
          return {
            ...envelope("workspace.setCurrent", null),
            ok: false,
            error: {
              code: "SERVICE_GRAPH_BUSY",
              message: "Service graph is busy",
              retryable: true,
            },
          } as never;
        }
        return {
          ...envelope("workspace.setCurrent", {
            workspace: otherWorkspaceSnapshot(),
            session: openedSession({ cwd: "/proj/other" }),
          }),
          workspaceId: OTHER_WORKSPACE_ID,
          workspaceRevision: 4,
          sessionId: TARGET_SESSION_ID,
          sessionRevision: 1,
          packageRevision: 1,
        } as never;
      }
      return envelope("session.open", openedSession({ cwd: "/proj/other" })) as never;
    });

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/other",
      sessionPath: "/sessions/other/target.jsonl",
    });

    expect(outcome.status).toBe("opened");
    expect(setCurrentCalls).toBe(2);
    expect(useAppStore.getState().workspace?.id).toBe(OTHER_WORKSPACE_ID);
  });

  it("reports failed when the workspace switch fails with a non-busy error", async () => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    vi.spyOn(hostClient, "request").mockResolvedValue(
      errorEnvelope("workspace.setCurrent", "WORKSPACE_NOT_FOUND") as never,
    );

    const outcome = await openSessionAcrossWorkspaces({
      cwd: "/proj/other",
      sessionPath: "/sessions/other/target.jsonl",
    });

    expect(outcome.status).toBe("failed");
    expect(useAppStore.getState().notifications.length).toBeGreaterThan(0);
  });

  it("force-activates a dedicated Host after a busy switch error", async () => {
    dedicatedHostMode();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    // First (non-forced) prepare is refused; the busy setCurrent error then
    // triggers the forced activateWorkspaceHost(true) isolation path.
    vi.mocked(prepareWorkspaceHost).mockResolvedValueOnce(false);
    vi.mocked(activateWorkspaceHost).mockResolvedValueOnce(true);
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "workspace.setCurrent") {
        return errorEnvelope("workspace.setCurrent", "AGENT_BUSY") as never;
      }
      return envelope("session.open", openedSession({ cwd: "/proj/other" })) as never;
    });

    const outcome = await openSessionAcrossWorkspaces(
      { cwd: "/proj/other", sessionId: TARGET_SESSION_ID },
      {
        resolveSessionPath: vi.fn(async () => ({
          sessionPath: "/sessions/other/target.jsonl",
        })),
      },
    );

    expect(outcome.status).toBe("opened");
    expect(request).toHaveBeenCalledWith(
      "workspace.setCurrent",
      expect.objectContaining({ hostInstanceId: HOST_ID }),
      { cwd: "/proj/other", optimistic: true },
      60_000,
    );
    expect(waitForWorkspaceActivation).toHaveBeenCalled();
    expect(useAppStore.getState().session?.sessionId).toBe(TARGET_SESSION_ID);
  });
});
