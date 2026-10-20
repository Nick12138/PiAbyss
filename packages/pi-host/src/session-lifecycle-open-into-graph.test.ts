/**
 * `openSessionIntoGraph`（session-lifecycle）：把一条已有 Session JSONL 重新
 * 打开并注册进工作区图（后台驻留，不抢前台会话位）。
 *
 * 这是委派 resume 在「运行时对象已被释放」时的底层能力（切工作区 /
 * disposeGraph / idle TTL 都会释放对象，但文件一直在盘上）。这里锁住：
 * a) 会话被注册进 backgroundSessions（snapshot / runtime 状态齐备），
 *    handleAgentEvent 接通，前台槽位不被占用、前台快照不被替换；
 * b) adoptForegroundSlots（小精灵驻留路径）才补前台槽位；
 * c) 文件不存在 / 会话加载失败 → 结构化、可重试的错误码；
 * d) sessionId 沿用文件（open 不新建段落）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { openSessionIntoGraph } from "./session-lifecycle.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

const created = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  session: null as unknown as AgentSession | null,
  error: null as Error | null,
}));

vi.mock("./agent-session-factory.js", () => ({
  createHostAgentSession: async (options: Record<string, unknown>) => {
    created.calls.push(options);
    if (created.error) throw created.error;
    return { session: created.session, extensionsResult: { mocked: true } };
  },
}));

const tracked: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  created.calls.length = 0;
  created.session = null;
  created.error = null;
  for (const dir of tracked.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

type FakeSession = {
  session: AgentSession;
  emit: (event: { type: string }) => void;
  listenerCount: () => number;
};

function fakeSession(sessionId: string, sessionFile: string): FakeSession {
  const listeners = new Set<(event: { type: string }) => void>();
  const session = {
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    sessionId,
    sessionFile,
    sessionName: "委派会话",
    model: undefined,
    messages: [],
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
    getAvailableThinkingLevels: () => ["off"],
    systemPrompt: "system",
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as AgentSession;
  return {
    session,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function fakeSessionManager(sessionId: string, sessionFile: string, cwd: string) {
  return {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getCwd: () => cwd,
  } as unknown as SessionManager;
}

function fakeGraph(canonicalCwd: string): {
  graph: WorkspaceGraph;
  factory: WorkspaceGraphFactory;
  handleAgentEvent: ReturnType<typeof vi.fn>;
  announceRetainedRuntime: ReturnType<typeof vi.fn>;
  touchIdleSession: ReturnType<typeof vi.fn>;
} {
  const handleAgentEvent = vi.fn();
  const announceRetainedRuntime = vi.fn();
  const touchIdleSession = vi.fn();
  const graph = {
    workspaceId: "ws-1",
    cwd: canonicalCwd,
    canonicalCwd,
    revision: 1,
    servicesReady: true,
    settingsManager: {},
    packageManager: null,
    resourceLoader: null,
    sessionManager: null,
    agentSession: null,
    extensionsResult: null,
    packageSnapshot: null,
    sessionSnapshot: null,
    toolRevision: 3,
    resourceIdMap: new Map(),
    unsubscribeAgent: null,
    extensionUiActivate: null,
    extensionUiCleanup: null,
    extensionUiUpdateIdentity: null,
    extensionUiReplayState: null,
    resourceReloadRequired: false,
    backgroundSessions: new Map(),
    idleSessionCache: new Map(),
  } as unknown as WorkspaceGraph;
  const factory = {
    deps: { agentDir: tempDir("pixie-open-graph-agent-") },
    canonicalizeCwd: (cwd: string) => cwd,
    getGraph: () => null,
    handleAgentEvent,
    announceRetainedRuntime,
    touchIdleSession,
  } as unknown as WorkspaceGraphFactory;
  return { graph, factory, handleAgentEvent, announceRetainedRuntime, touchIdleSession };
}

describe("openSessionIntoGraph", () => {
  it("注册进 backgroundSessions（snapshot/runtime 齐备）并接通 handleAgentEvent，不占前台", async () => {
    const cwd = tempDir("pixie-open-graph-ws-");
    const sessionId = "01a1593a-3ce1-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const fake = fakeSession(sessionId, sessionPath);
    created.session = fake.session;
    const manager = fakeSessionManager(sessionId, sessionPath, cwd);
    vi.spyOn(SessionManager, "open").mockReturnValue(manager);
    const { graph, factory, handleAgentEvent, announceRetainedRuntime, touchIdleSession } =
      fakeGraph(cwd);

    const opened = await openSessionIntoGraph(factory, graph, sessionPath, {
      createResourceLoader: async () => ({}) as never,
    });

    expect("error" in opened).toBe(false);
    if ("error" in opened) return;
    // 文件里的 sessionId 被沿用（open 不新建段落）。
    expect(opened.sessionId).toBe(sessionId);
    expect(opened.sessionPath).toBe(sessionPath);
    expect(opened.session).toBe(fake.session);
    // 后台驻留：注册进 backgroundSessions，snapshot 是这条会话的。
    const runtime = graph.backgroundSessions.get(sessionId);
    expect(runtime).toBe(opened.runtime);
    expect(runtime?.sessionSnapshot.sessionId).toBe(sessionId);
    expect(runtime?.sessionSnapshot.sessionPath).toBe(sessionPath);
    expect(runtime?.sessionSnapshot.cwd).toBe(cwd);
    expect(runtime?.extensionUiActivate).toBeNull();
    // 事件接线：runtime 订阅转给 factory.handleAgentEvent。
    fake.emit({ type: "agent_settled" });
    expect(handleAgentEvent).toHaveBeenCalledTimes(1);
    expect(handleAgentEvent.mock.calls[0]?.[0]).toBe(graph);
    expect(handleAgentEvent.mock.calls[0]?.[1]).toBe(fake.session);
    // 不抢前台会话位（普通委派会话的关键约束）。
    expect(graph.agentSession).toBeNull();
    expect(graph.sessionSnapshot).toBeNull();
    // runtime 状态与 hot queue 都登记了，不是幽灵会话。
    expect(announceRetainedRuntime).toHaveBeenCalledWith(runtime);
    expect(touchIdleSession).toHaveBeenCalledWith(graph, sessionId);
    // 默认注入 read_attachment 之外不额外加工具（无 attachmentStore ⇒ 不传）。
    const options = created.calls[0] ?? {};
    expect(options.sessionManager).toBe(manager);
    expect(options.cwd).toBe(cwd);
  });

  it("adoptForegroundSlots（小精灵驻留）才补前台槽位，并共享同一条订阅", async () => {
    const cwd = tempDir("pixie-open-graph-ws-");
    const sessionId = "01a1593b-d9fc-770f-84b0-fd3f3b9efb86";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const fake = fakeSession(sessionId, sessionPath);
    created.session = fake.session;
    vi.spyOn(SessionManager, "open").mockReturnValue(
      fakeSessionManager(sessionId, sessionPath, cwd),
    );
    const { graph, factory } = fakeGraph(cwd);
    const previousUnsubscribe = vi.fn();
    graph.unsubscribeAgent = previousUnsubscribe;

    const opened = await openSessionIntoGraph(factory, graph, sessionPath, {
      createResourceLoader: async () => ({}) as never,
      adoptForegroundSlots: true,
      onOpened: (value) => {
        expect(value.sessionId).toBe(sessionId);
      },
    });
    if ("error" in opened) throw new Error(opened.error.message);

    expect(graph.agentSession).toBe(fake.session);
    expect(graph.sessionManager).toBe(opened.sessionManager);
    expect(graph.sessionSnapshot).toBe(opened.runtime.sessionSnapshot);
    expect(graph.unsubscribeAgent).toBe(opened.runtime.unsubscribeAgent);
    // 旧的前台订阅被摘掉，不是叠一条。
    expect(previousUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("会话文件不存在 → SESSION_NOT_FOUND（不建任何会话）", async () => {
    const cwd = tempDir("pixie-open-graph-ws-");
    const { graph, factory } = fakeGraph(cwd);

    const outcome = await openSessionIntoGraph(
      factory,
      graph,
      join(cwd, "missing.jsonl"),
      { createResourceLoader: async () => ({}) as never },
    );

    expect("error" in outcome).toBe(true);
    if (!("error" in outcome)) return;
    expect(outcome.error.code).toBe("SESSION_NOT_FOUND");
    expect(created.calls).toHaveLength(0);
  });

  it("会话加载失败 → 可重试的 SESSION_SWITCH_FAILED", async () => {
    const cwd = tempDir("pixie-open-graph-ws-");
    const sessionId = "01a1594c-1111-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const fake = fakeSession(sessionId, sessionPath);
    created.session = fake.session;
    created.error = new Error("model provider exploded");
    vi.spyOn(SessionManager, "open").mockReturnValue(
      fakeSessionManager(sessionId, sessionPath, cwd),
    );
    const { graph, factory } = fakeGraph(cwd);

    const outcome = await openSessionIntoGraph(factory, graph, sessionPath, {
      createResourceLoader: async () => ({}) as never,
    });

    expect("error" in outcome).toBe(true);
    if (!("error" in outcome)) return;
    expect(outcome.error.code).toBe("SESSION_SWITCH_FAILED");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.message).toContain("model provider exploded");
    // 没注册进图：不要留半个 runtime。
    expect(graph.backgroundSessions.size).toBe(0);
  });
});
