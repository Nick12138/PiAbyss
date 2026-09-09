import type { SessionSnapshot } from "@piabyss/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureActiveSessionState,
  commitActiveSessionState,
  IDLE_SESSION_CACHE_TTL_MS,
  MAX_IDLE_SESSION_CACHE,
  SESSION_DISPOSAL_STEP_TIMEOUT_MS,
  SessionRuntimeCache,
  type ActiveSessionState,
} from "./session-runtime-cache.js";
import type { PiHostServer } from "./server.js";
import type { BackgroundSessionRuntime, WorkspaceGraph } from "./workspace-graph-types.js";

function activeSlots(seed: string): ActiveSessionState {
  return {
    sessionManager: { seed } as unknown as ActiveSessionState["sessionManager"],
    agentSession: { seed } as unknown as ActiveSessionState["agentSession"],
    extensionsResult: { seed },
    resourceLoader: { seed } as unknown as ActiveSessionState["resourceLoader"],
    toolRevision: seed === "next" ? 9 : 3,
    sessionSnapshot: { sessionId: seed } as ActiveSessionState["sessionSnapshot"],
    extensionUiActivate: vi.fn(),
    extensionUiCleanup: vi.fn(),
    extensionUiUpdateIdentity: vi.fn(),
    extensionUiReplayState: vi.fn(),
    unsubscribeAgent: vi.fn(),
    sessionId: seed,
    sessionRevision: seed === "next" ? 7 : 2,
  };
}

function graphFrom(state: ActiveSessionState): WorkspaceGraph {
  return {
    sessionManager: state.sessionManager,
    agentSession: state.agentSession,
    extensionsResult: state.extensionsResult,
    resourceLoader: state.resourceLoader,
    toolRevision: state.toolRevision,
    sessionSnapshot: state.sessionSnapshot,
    extensionUiActivate: state.extensionUiActivate,
    extensionUiCleanup: state.extensionUiCleanup,
    extensionUiUpdateIdentity: state.extensionUiUpdateIdentity,
    extensionUiReplayState: state.extensionUiReplayState,
    unsubscribeAgent: state.unsubscribeAgent,
  } as WorkspaceGraph;
}

function disposalCache(): SessionRuntimeCache {
  return new SessionRuntimeCache({
    getGraph: () => null,
    getServer: () => null,
    getCurrentRunId: () => null,
    sessionPathsEqual: () => false,
  });
}

function disposalSession(
  options: {
    emit?: () => Promise<void>;
    abort?: () => Promise<void>;
  } = {},
) {
  const emit = vi.fn(options.emit ?? (async () => undefined));
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const dispose = vi.fn();
  const session = {
    isIdle: false,
    extensionRunner: {
      hasHandlers: vi.fn(() => true),
      emit,
    },
    abort,
    dispose,
  } as unknown as AgentSession;
  return { session, emit, abort, dispose };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session disposal bounds", () => {
  it("continues through abort and dispose when session_shutdown never settles", async () => {
    vi.useFakeTimers();
    const cache = disposalCache();
    const { session, emit, abort, dispose } = disposalSession({
      emit: () => new Promise<void>(() => undefined),
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(emit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("continues through dispose and handles a late abort rejection", async () => {
    vi.useFakeTimers();
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const abortPromise = new Promise<void>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cache = disposalCache();
    const { session, abort, dispose } = disposalSession({
      abort: () => abortPromise,
    });
    let settled = false;

    void cache.disposeAgentSessionOnly(session).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SESSION_DISPOSAL_STEP_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();

    rejectAbort?.(new Error("late abort failure"));
    await Promise.resolve();
  });
});

describe("idle Session cache", () => {
  it("retains an idle Session without treating it as a busy background runtime", () => {
    const cache = disposalCache();
    const state = activeSlots("idle");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = {
      ...graphFrom(state),
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;

    const runtime = cache.retainSessionRuntime(graph, state);

    expect(runtime?.agentSession).toBe(state.agentSession);
    expect(graph.backgroundSessions.size).toBe(0);
    expect(graph.idleSessionCache?.get("idle")).toBe(runtime);
  });

  it("keeps the five most recently active idle Sessions and evicts the oldest runtime", () => {
    const cache = disposalCache();
    const graph = { backgroundSessions: new Map() } as unknown as WorkspaceGraph;
    const states = ["A", "B", "C", "D", "E"].map((sessionId) => {
      const state = activeSlots(sessionId);
      Reflect.set(state.agentSession!, "isIdle", true);
      cache.retainSessionRuntime(graph, state);
      return state;
    });

    cache.touchIdleSession(graph, "F");

    expect(MAX_IDLE_SESSION_CACHE).toBe(5);
    expect([...(graph.idleSessionRecency?.keys() ?? [])]).toEqual(["B", "C", "D", "E", "F"]);
    expect([...(graph.idleSessionCache?.keys() ?? [])]).toEqual(["B", "C", "D", "E"]);
    expect(graph.idleSessionCache?.has("A")).toBe(false);
    expect(states[0]!.agentSession).not.toBeNull();
  });

  it("expires an untouched cached Session after the configured idle timeout", async () => {
    vi.useFakeTimers();
    const cache = disposalCache();
    const state = activeSlots("idle");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = { backgroundSessions: new Map() } as unknown as WorkspaceGraph;

    cache.retainSessionRuntime(graph, state);
    await vi.advanceTimersByTimeAsync(IDLE_SESSION_CACHE_TTL_MS);

    expect(graph.idleSessionCache?.has("idle")).toBe(false);
    expect(graph.idleSessionRecency?.has("idle")).toBe(false);
  });

  it("removes a running Session from the idle queue", () => {
    const cache = disposalCache();
    const state = activeSlots("running");
    Reflect.set(state.agentSession!, "isIdle", true);
    const graph = {
      ...graphFrom(state),
      backgroundSessions: new Map(),
    } as unknown as WorkspaceGraph;

    cache.touchIdleSession(graph, "running");
    Reflect.set(state.agentSession!, "isIdle", false);
    cache.touchIdleSession(graph, "running");

    expect(graph.idleSessionRecency?.has("running")).toBe(false);
  });
});
describe("active Session state", () => {
  it("captures all Session graph slots and both identity fields", () => {
    const state = activeSlots("current");
    const captured = captureActiveSessionState(graphFrom(state), {
      sessionId: state.sessionId,
      sessionRevision: state.sessionRevision,
    });

    expect(captured).toEqual(state);
  });

  it("commits only Session graph slots and identity", () => {
    const current = activeSlots("current");
    const next = activeSlots("next");
    const graph = {
      ...graphFrom(current),
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
      backgroundSessions: new Map([["background", {}]]),
    } as unknown as WorkspaceGraph;
    const identity = {
      sessionId: current.sessionId,
      sessionRevision: current.sessionRevision,
      workspaceRevision: 11,
      packageRevision: 13,
    };

    commitActiveSessionState(graph, identity, next);

    expect(captureActiveSessionState(graph, identity)).toEqual(next);
    expect(graph).toMatchObject({
      workspaceId: "workspace-stable",
      revision: 11,
      packageSnapshot: { revision: 13 },
    });
    expect(graph.backgroundSessions.has("background")).toBe(true);
    expect(identity).toMatchObject({ workspaceRevision: 11, packageRevision: 13 });
  });
});

describe("background runtime promotion", () => {
  const HOST_IDENTITY = {
    hostInstanceId: "host-1",
    workspaceId: "ws-1",
    workspaceRevision: 1,
    sessionId: "foreground-session",
    sessionRevision: 5,
    packageRevision: 1,
  };

  const STREAMING_MESSAGE = {
    role: "assistant",
    content: [{ type: "text", text: "123" }],
  };

  function promotionServer() {
    const identity = { ...HOST_IDENTITY };
    return {
      identity,
      getIdentity: () => identity,
      emit: vi.fn(),
    };
  }

  function streamingSessionFixture(): AgentSession {
    return {
      sessionId: "bg-session",
      sessionFile: "C:/workspace/bg-session.jsonl",
      sessionName: undefined,
      isIdle: false,
      isCompacting: false,
      isRetrying: false,
      model: undefined,
      messages: [{ role: "user", content: "Hi" }],
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getAllTools: () => [],
      getActiveToolNames: () => [],
      agent: { state: { streamingMessage: STREAMING_MESSAGE } },
    } as unknown as AgentSession;
  }

  function busyRuntimeFixture() {
    const runtime = {
      sessionId: "bg-session",
      sessionRevision: 2,
      sessionManager: {} as BackgroundSessionRuntime["sessionManager"],
      agentSession: streamingSessionFixture(),
      resourceLoader: {} as BackgroundSessionRuntime["resourceLoader"],
      extensionsResult: {},
      toolRevision: 3,
      sessionSnapshot: { sessionId: "bg-session", revision: 2 } as SessionSnapshot,
      unsubscribeAgent: vi.fn(),
      extensionUiActivate: vi.fn(),
      extensionUiCleanup: vi.fn(),
      extensionUiUpdateIdentity: vi.fn(),
      extensionUiReplayState: vi.fn(),
    };
    return runtime as BackgroundSessionRuntime;
  }

  function promotionGraph(runtime: BackgroundSessionRuntime): WorkspaceGraph {
    return {
      canonicalCwd: "C:/workspace",
      workspaceId: HOST_IDENTITY.workspaceId,
      toolRevision: 1,
      backgroundSessions: new Map([[runtime.sessionId, runtime]]),
    } as unknown as WorkspaceGraph;
  }

  function promotionCache(graph: WorkspaceGraph, server: ReturnType<typeof promotionServer>) {
    return new SessionRuntimeCache({
      getGraph: () => graph,
      getServer: () => server as unknown as PiHostServer,
      getCurrentRunId: () => null,
      sessionPathsEqual: (left, right) => left === right,
    });
  }

  it("projects the in-flight assistant message into the promoted snapshot", async () => {
    const runtime = busyRuntimeFixture();
    const graph = promotionGraph(runtime);
    const server = promotionServer();
    const cache = promotionCache(graph, server);

    const promoted = await cache.promoteBackgroundRuntime(graph, runtime);

    expect("error" in promoted).toBe(false);
    const snapshot = promoted as SessionSnapshot;
    // Persisted messages plus the in-flight streaming tail: the desktop must
    // be able to render everything streamed while the session was backgrounded.
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({ role: "user", content: "Hi" });
    expect(snapshot.messages[1]).toEqual(STREAMING_MESSAGE);
    expect(snapshot.isStreaming).toBe(true);
    expect(runtime.sessionSnapshot).toBe(snapshot);
    expect(server.emit).toHaveBeenCalledWith("session.snapshot", snapshot);
  });

  it("omits the streaming tail once the promoted Session is idle", async () => {
    const runtime = busyRuntimeFixture();
    Reflect.set(runtime.agentSession, "isIdle", true);
    Reflect.set(runtime.agentSession, "agent", { state: { streamingMessage: undefined } });
    const graph = promotionGraph(runtime);
    const server = promotionServer();
    const cache = promotionCache(graph, server);

    const promoted = await cache.promoteBackgroundRuntime(graph, runtime);

    expect("error" in promoted).toBe(false);
    expect((promoted as SessionSnapshot).messages).toHaveLength(1);
  });
});
