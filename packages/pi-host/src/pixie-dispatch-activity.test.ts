/**
 * 委派会话的运行态发布（工作区忙灯的数据源）。
 *
 * 现场症状（本次修复的 bug）：「小精灵委派任务发起后，目标工作区在侧边栏没有
 * 忙灯；切到那个工作区之后灯才亮」。
 *
 * 根因在 Host：`createTargetSession` 给委派会话挂的是一条空订阅
 * （`session.subscribe(() => undefined)`），后台图里没有任何别的东西替它转发
 * agent 事件，于是整条委派回合一个 `session.runtimeChanged` 都没发。Rust 池子的
 * `busy_sessions` 只能靠这些帧建立，自然一直是空的；用户切到该工作区时激活路径
 * 才补发一次运行态（`promoteBackgroundRuntime`），灯于是「切过去才亮」。
 *
 * 本文件锁：
 * a) 委派会话（新建分支）真的接上了 `factory.handleAgentEvent` —— 开跑即上报；
 * b) 上报走的是目标工作区图自己的身份（parked 图用 `parkedIdentity` /
 *    图自身 workspaceId），不是前台工作区的 —— 后台跑也要归到正确的工作区；
 * c) 回合结束、失败分别落到 idle / error（Rust 侧转 done / error 未读标记）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { configurePixieEventEmitter, resetPixieStateForTests } from "./pixie-agent-runner.js";
import { createPixieControlPlaneDeps } from "./pixie-controller.js";
import { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { PiHostServer } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

/**
 * 建会话所需的三件真货（SDK 的 SessionManager / DefaultResourceLoader 与
 * Host 的 agent-session-factory）在单测里换成可编排的假件：委派引擎对这些的
 * 要求只是「能拿到一个会话对象 + 会话文件路径」。
 */
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeResourceLoader {
    async reload(): Promise<void> {}
  }
  return {
    ...actual,
    SessionManager: {
      ...(actual.SessionManager as object),
      create: () => ({
        getCwd: () => WS,
        getSessionId: () => "sess-delegated",
        getSessionFile: () => join(WS, "sess-delegated.jsonl"),
        getLeafId: () => null,
        appendCustomEntry: () => undefined,
      }),
    },
    DefaultResourceLoader: FakeResourceLoader,
  };
});

const WS = "D:/ws-delegated";

vi.mock("./agent-session-factory.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createHostAgentSession: async () => ({
      session: fakeSessionHolder.session,
      extensionsResult: {},
    }),
  };
});

vi.mock("./session-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildSessionSnapshot: (input: { sessionId: string; revision: number }) => ({
      sessionId: input.sessionId,
      revision: input.revision,
      entries: [],
      messages: [],
      cwd: WS,
      workspaceId: "ws-delegated",
      toolRevision: 0,
    }),
  };
});

// `createTargetSession` 通过工厂函数建会话，假件在用例里注入。
const fakeSessionHolder: { session: AgentSession | null } = { session: null };

type Listenable = { type: string } & Record<string, unknown>;

/**
 * 最小委派会话假件：`prompt` 真的按 SDK 顺序发 agent_start → agent_settled，
 * 这样断言的是「真实事件流经订阅到达 handleAgentEvent」，而不是空跑。
 */
function fakeSession(sessionId: string) {
  const listeners = new Set<(event: Listenable) => void>();
  const prompts: string[] = [];
  const session = {
    sessionId,
    sessionFile: join(WS, `${sessionId}.jsonl`),
    sessionName: null as string | null,
    model: { provider: "test", id: "test-model" },
    isIdle: true,
    isStreaming: false,
    messages: [],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    setSessionName: (name: string) => {
      session.sessionName = name;
    },
    subscribe: (listener: (event: Listenable) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (text: string) => {
      prompts.push(text);
      session.isIdle = false;
      session.isStreaming = true;
      emit({ type: "agent_start" });
      emit({ type: "agent_settled" });
      session.isIdle = true;
      session.isStreaming = false;
      return undefined;
    },
    followUp: (text: string) => {
      prompts.push(text);
    },
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
    getTree: () => [],
  };
  function emit(event: Listenable): void {
    for (const listener of [...listeners]) listener(event);
  }
  return { session: session as unknown as AgentSession, emit, prompts };
}

const trackedDirs: string[] = [];

function freshAgentDir(): string {
  resetPixieStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "pixie-activity-test-"));
  trackedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of trackedDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  fakeSessionHolder.session = null;
  resetPixieStateForTests();
});

/** 目标工作区的「后台图」：不是当前前台图（getGraph 返回别的图）。 */
function backgroundGraph(agentDir: string): WorkspaceGraph {
  return {
    workspaceId: "ws-delegated",
    cwd: WS,
    canonicalCwd: WS,
    revision: 7,
    servicesReady: true,
    settingsManager: {},
    sessionManager: null,
    agentSession: null,
    sessionSnapshot: null,
    toolRevision: 0,
    backgroundSessions: new Map(),
    idleSessionCache: new Map(),
    unsubscribeAgent: null,
    resourceLoader: null,
    packageManager: null,
    extensionsResult: {},
    packageSnapshot: null,
    resourceIdMap: new Map(),
    resourceReloadRequired: false,
    extensionUiActivate: null,
    extensionUiCleanup: null,
    extensionUiUpdateIdentity: null,
    extensionUiReplayState: null,
    ...{ agentDir },
  } as unknown as WorkspaceGraph;
}

describe("委派会话的事件接线（忙灯数据源）", () => {
  it("新建的委派会话开跑即把 agent 事件转给 handleAgentEvent（不再是空订阅）", async () => {
    const agentDir = freshAgentDir();
    const fake = fakeSession("sess-delegated");
    fakeSessionHolder.session = fake.session;
    const graph = backgroundGraph(agentDir);
    const handleAgentEvent = vi.fn();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: (cwd: string) => (cwd === WS ? graph : null),
      ensureBackgroundGraph: () =>
        Promise.resolve({ error: { message: "测试：目标图已绑定，不该重建" } } as never),
      isSessionBusy: () => false,
      handleAgentEvent,
      publishEngineRuntimeState: vi.fn(),
    } as unknown as WorkspaceGraphFactory;

    const outcome = await createPixieControlPlaneDeps(factory).dispatch({
      cwd: WS,
      task: "从 1 数到 100",
    });
    expect(outcome.ok).toBe(true);
    expect(fake.prompts).toHaveLength(1);

    // 关键断言：委派回合的 agent 事件确实到了 factory.handleAgentEvent，
    // 并且带的是目标工作区图（不是前台图）。
    expect(handleAgentEvent).toHaveBeenCalled();
    const calls = handleAgentEvent.mock.calls;
    expect(calls[0]?.[0]).toBe(graph);
    expect(calls[0]?.[1]).toBe(fake.session);
    expect(calls.map((call) => (call[2] as Listenable).type)).toContain("agent_start");
    expect(calls.map((call) => (call[2] as Listenable).type)).toContain("agent_settled");

    // 运行中的那个 runtime 就是挂了真实订阅的那条（后台图里唯一的委派会话）。
    const runtime = graph.backgroundSessions.get("sess-delegated");
    expect(runtime?.sessionId).toBe("sess-delegated");
    expect(runtime?.unsubscribeAgent).toBeTypeOf("function");
  });

  it("排队中的委派：会话空闲时补一条 engine 级 queued 忙态（有活在等这个工作区）", async () => {
    const agentDir = freshAgentDir();
    const fake = fakeSession("sess-delegated");
    fakeSessionHolder.session = fake.session;
    const graph = backgroundGraph(agentDir);
    // 目标会话上先有一条「等用户答复」的活跃委派：新任务只能排队。
    const { registerDispatch, askDispatch } = await import("./pixie-agent-runner.js");
    const live = registerDispatch({
      cwd: WS,
      sessionId: "sess-delegated",
      sessionPath: join(WS, "sess-delegated.jsonl"),
      task: "先前的任务（正在等用户答复）",
      agentDir,
    });
    askDispatch(live.id, "要继续吗？", ["继续"], agentDir);
    const publishEngineRuntimeState = vi.fn();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: (cwd: string) => (cwd === WS ? graph : null),
      isSessionBusy: () => false,
      handleAgentEvent: vi.fn(),
      publishEngineRuntimeState,
    } as unknown as WorkspaceGraphFactory;
    // 让引擎在排队分支拿得到会话对象（复用路径）。
    const { setDispatchSessionForTests } = await import("./pixie-controller.js");
    setDispatchSessionForTests(live.id, fake.session);

    const outcome = await createPixieControlPlaneDeps(factory).dispatch({
      cwd: WS,
      task: "排队等前一条完成",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.queued).toBe(true);
    // 排队也计入忙（用户不用切过去就知道这个工作区还有活）。
    expect(publishEngineRuntimeState).toHaveBeenCalledWith(fake.session, "queued");
  });
});

describe("parked 图里的委派会话：运行态按目标工作区身份发布", () => {
  function parkedServer() {
    const identity = {
      hostInstanceId: "host-1",
      // 前台是别的工作区（用户停在小精灵页）。
      workspaceId: "ws-pixie",
      workspaceRevision: 1,
      sessionId: "pixie-session",
      sessionRevision: 3,
      packageRevision: 1,
    };
    const emit = vi.fn();
    const emitForBoundIdentity = vi.fn();
    const emitForIdentity = vi.fn();
    const server = {
      identity,
      getIdentity: () => identity,
      emit,
      emitForIdentity,
      emitForBoundIdentity,
      getPhase: () => "ready",
    };
    return server;
  }

  it("agent_start → session.runtimeChanged(running) 带目标工作区的 workspaceId", () => {
    const server = parkedServer();
    const parkedIdentity = {
      hostInstanceId: "host-1",
      workspaceId: "ws-delegated",
      workspaceRevision: 7,
      sessionId: "graph-own-session",
      sessionRevision: 0,
      packageRevision: 0,
    };
    const delegated = fakeSession("sess-delegated");
    const graph = {
      workspaceId: "ws-delegated",
      canonicalCwd: WS,
      revision: 7,
      backgroundSessions: new Map(),
      sessionManager: {},
      sessionSnapshot: { sessionId: "sess-delegated", revision: 0 } as never,
      parkedIdentity,
      toolRevision: 0,
      backgroundRunning: true,
    } as unknown as WorkspaceGraph;
    const runtime = {
      sessionId: "sess-delegated",
      sessionRevision: 0,
      sessionManager: {} as never,
      agentSession: delegated.session,
      resourceLoader: {} as never,
      extensionsResult: {},
      toolRevision: 0,
      sessionSnapshot: { sessionId: "sess-delegated", revision: 0 } as never,
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      extensionUiReplayState: null,
    };
    graph.backgroundSessions.set("sess-delegated", runtime);
    const cache = new SessionRuntimeCache({
      getGraph: () => null, // 前台图是别的工作区：这是一张 parked 图
      getServer: () => server as unknown as PiHostServer,
      getCurrentRunId: () => null,
      sessionPathsEqual: (left, right) => left === right,
      isGraphBound: () => true,
    });

    // 回合开跑：SDK 在 agent_start 之前已把会话置为非 idle。
    Reflect.set(delegated.session, "isIdle", false);
    cache.handleAgentEvent(graph, delegated.session, { type: "agent_start" });

    const runtimeFrames = server.emitForBoundIdentity.mock.calls.filter(
      (call) => call[1] === "session.runtimeChanged",
    );
    expect(runtimeFrames.length).toBeGreaterThanOrEqual(1);
    const [identity, , payload] = runtimeFrames[0] as unknown as [
      { workspaceId: string },
      string,
      { sessionId: string; state: string },
    ];
    // 归属必须是目标工作区（Rust 侧据此把会话挂到正确工作区的灯上）。
    expect(identity.workspaceId).toBe("ws-delegated");
    expect(payload.sessionId).toBe("sess-delegated");
    expect(payload.state).toBe("running");

    // 回合结束 → idle（Rust 把这条转成 done 未读标记）。
    Reflect.set(delegated.session, "isIdle", true);
    cache.handleAgentEvent(graph, delegated.session, { type: "agent_settled" });
    const settleFrames = server.emitForBoundIdentity.mock.calls.filter(
      (call) => call[1] === "session.runtimeChanged",
    );
    const last = settleFrames.at(-1) as unknown as [
      { workspaceId: string },
      string,
      { state: string },
    ];
    expect(last[0].workspaceId).toBe("ws-delegated");
    expect(last[2].state).toBe("idle");
  });
});

describe("叫停/取消的终态标记", () => {
  it("叫停正在跑的委派 → 发 error 终态（红点），不是 done", async () => {
    const agentDir = freshAgentDir();
    configurePixieEventEmitter(() => undefined);
    const fake = fakeSession("sess-stopped");
    const { registerDispatch } = await import("./pixie-agent-runner.js");
    const record = registerDispatch({
      cwd: WS,
      sessionId: "sess-stopped",
      sessionPath: join(WS, "sess-stopped.jsonl"),
      task: "从 1 数到 100",
      agentDir,
    });
    const publishEngineRuntimeState = vi.fn();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: () => null,
      isSessionBusy: () => true,
      handleAgentEvent: vi.fn(),
      publishEngineRuntimeState,
      // 回调投递是 fire-and-forget：这里明确「不建图」，让它走既有的
      // 「小精灵工作区不可达」分支而不是抛出未处理异常。
      getGraph: () => null,
      getServer: () => null,
      ensureBackgroundGraph: () => Promise.resolve({ error: { message: "测试：不建图" } } as never),
    } as unknown as WorkspaceGraphFactory;
    const { setDispatchSessionForTests } = await import("./pixie-controller.js");
    setDispatchSessionForTests(record.id, fake.session);

    const outcome = await createPixieControlPlaneDeps(factory).stop({ dispatchId: record.id });
    expect(outcome).toEqual({ ok: true, action: "aborted" });
    // 叫停不是「正常完成」：工作区要留红点（error 终态）。
    expect(publishEngineRuntimeState).toHaveBeenCalledWith(fake.session, "error");
  });

  it("取消排队中的委派且队列空了 → 收回 queued 忙态（灯熄灭）", async () => {
    const agentDir = freshAgentDir();
    configurePixieEventEmitter(() => undefined);
    const fake = fakeSession("sess-queued");
    const { registerDispatch } = await import("./pixie-agent-runner.js");
    const record = registerDispatch({
      cwd: WS,
      sessionId: "sess-queued",
      sessionPath: join(WS, "sess-queued.jsonl"),
      task: "排队后被取消的任务",
      agentDir,
      queued: true,
    });
    const graph = backgroundGraph(agentDir);
    graph.backgroundSessions.set("sess-queued", {
      sessionId: "sess-queued",
      sessionRevision: 0,
      sessionManager: {} as never,
      agentSession: fake.session,
      resourceLoader: {} as never,
      extensionsResult: {},
      toolRevision: 0,
      sessionSnapshot: { sessionId: "sess-queued", revision: 0 } as never,
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      extensionUiReplayState: null,
    });
    const publishEngineRuntimeState = vi.fn();
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: (cwd: string) => (cwd === WS ? graph : null),
      isSessionBusy: () => false,
      handleAgentEvent: vi.fn(),
      publishEngineRuntimeState,
      getGraph: () => null,
      getServer: () => null,
      ensureBackgroundGraph: () => Promise.resolve({ error: { message: "测试：不建图" } } as never),
    } as unknown as WorkspaceGraphFactory;

    const outcome = await createPixieControlPlaneDeps(factory).stop({ dispatchId: record.id });
    expect(outcome).toEqual({ ok: true, action: "cancelled" });
    // 队列空了、会话也不在跑 → 收回忙态，别留一个永远不熄的绿灯。
    expect(publishEngineRuntimeState).toHaveBeenCalledWith(fake.session, "idle");
  });
});
