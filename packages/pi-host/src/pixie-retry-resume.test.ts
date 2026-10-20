/**
 * pixie_retry(mode=resume) 的会话可达性 + 信封送达确认。
 *
 * 背景一（可达性）：委派会话因 "Request was aborted" 这类可重试错误失败时，
 * 会话对象本身还活着（回调里 sessionAlive: "alive"），但回合结束分支已经把
 * dispatchId → AgentSession 的内存条目删掉了。resume 只看内存 Map 就会误判
 * 「目标会话已不可达」，逼用户 redispatch 丢掉上下文。
 *
 * 背景二（送达确认，2026-10-19 现场）：上一版找回会话后走
 * `session.followUp(envelope)`，而 followUp 只是「入队」——刚 abort 的会话已经
 * 没有活跃回合来 flush 队列，于是 resume 返回 ok、dispatches.json 改成
 * dispatched，但目标会话 JSONL 在 aborted 之后零新增（静默假成功）；steer 那
 * 一支还用 `.catch(() => undefined)` 吞掉错误。
 *
 * 这里锁：
 * a) Map 未命中但绑定的工作区图里能找到 → 注入成功（空闲会话用 prompt 真的开
 *    回合，信封进入会话）、记录才 reactivate、续跑回合结束照常自动回调；
 * b) 图里也找不到 → 仍然报「不可达」，行为不回归；
 * c) abort 后 isStreaming 残留为 true 且 steer 实际无效 → 不返回 ok，记录停在
 *    failed（failCount 语义不变），并回调 error（sessionAlive: dead）；
 * d) 注入路径抛错（如无模型/无凭据）→ 同样 ok:false + 可观测失败原因；
 * e) Map 命中（正常 resume）不回归，且不会再回图里找；
 * f) 会话运行时对象已被释放（切工作区 / 图被驱逐 / idle TTL）但 JSONL 还在 →
 *    从文件重开进图后照样续跑；文件没了 / 重开失败 / sessionId 不匹配则分层报错，
 *    绝不静默换会话，并发 resume 只重开一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  configurePixieEventEmitter,
  failDispatch,
  findDispatchById,
  registerDispatch,
  resetPixieStateForTests,
} from "./pixie-agent-runner.js";
import {
  createPixieControlPlaneDeps,
  setDispatchSessionForTests,
  setResumeInjectionTimingsForTests,
} from "./pixie-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

/**
 * `openSessionIntoGraph`（session-lifecycle）真身会建真 AgentSession，单测里换成
 * 可编排的假件：既能断言「走没走重开」，也能造出重开成功 / 失败 / id 不匹配。
 */
const openerMock = vi.hoisted(() => ({
  calls: [] as Array<{ sessionPath: string }>,
  opener: null as null | ((sessionPath: string) => Promise<unknown>),
}));

vi.mock("./session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-lifecycle.js")>();
  return {
    ...actual,
    openSessionIntoGraph: async (
      _factory: unknown,
      _graph: unknown,
      sessionPath: string,
    ): Promise<unknown> => {
      openerMock.calls.push({ sessionPath });
      if (!openerMock.opener) throw new Error("测试：未配置 openSessionIntoGraph 假实现");
      return openerMock.opener(sessionPath);
    },
  };
});

const WS = "D:/ws-resume";
const tracked: string[] = [];

function freshAgentDir(): string {
  resetPixieStateForTests();
  const dir = mkdtempSync(join(tmpdir(), "pixie-resume-test-"));
  tracked.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  setResumeInjectionTimingsForTests(null);
  resetPixieStateForTests();
});

type Listenable = { type: string } & Record<string, unknown>;
type FakeMessage = { role: string; content: Array<{ type: string; text: string }> };

function userMessage(text: string): FakeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/**
 * 最小 AgentSession 假件：只实装 watcher / resume 送达确认用到的那几个口子。
 * - `isStreaming: true` 模拟「abort 后流状态没复位」；
 * - `deliver: false` 模拟「入队了但没有任何活跃回合来消费」的失效实例；
 * - `promptError` 模拟注入路径本身的明确失败（无模型 / 无凭据 / 压缩中）。
 */
function fakeSession(
  sessionId: string,
  options: { streaming?: boolean; deliver?: boolean; promptError?: string } = {},
) {
  const listeners = new Set<(event: Listenable) => void>();
  const prompts: string[] = [];
  const followUps: string[] = [];
  const steers: string[] = [];
  const messages: FakeMessage[] = [];
  const deliver = options.deliver ?? true;
  const session = {
    sessionId,
    sessionName: "委派会话",
    model: { provider: "test", id: "test-model" },
    isStreaming: options.streaming ?? false,
    get state() {
      return { messages };
    },
    getFollowUpMessages: () => [...followUps],
    getSteeringMessages: () => [...steers],
    // 流状态残留且没有活跃回合时，waitForIdle 永远不会 resolve（真实 SDK 里
    // 这代表「等 abort 结算」，结算不来就不能假装续跑成功）。
    waitForIdle: () => (options.streaming ? new Promise<void>(() => undefined) : Promise.resolve()),
    followUp: (text: string) => {
      followUps.push(text);
    },
    steer: (text: string) => {
      steers.push(text);
      return Promise.resolve("queued");
    },
    prompt: (text: string) => {
      prompts.push(text);
      if (options.promptError) return Promise.reject(new Error(options.promptError));
      if (deliver) {
        const message = userMessage(text);
        messages.push(message);
        for (const listener of [...listeners]) {
          listener({ type: "message_start", message });
          listener({ type: "message_end", message });
        }
      }
      return Promise.resolve();
    },
    abort: () => Promise.resolve(),
    subscribe: (listener: (event: Listenable) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    session: session as unknown as AgentSession,
    prompts,
    followUps,
    steers,
    messages,
    listenerCount: () => listeners.size,
    emit: (event: Listenable) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** 图里带 idleSessionCache 里的会话（= 工作区停驻但仍活着的委派会话）。 */
function graphWithIdleSession(sessionId: string, agentSession: AgentSession): WorkspaceGraph {
  return {
    agentSession: null,
    sessionSnapshot: null,
    backgroundSessions: new Map(),
    idleSessionCache: new Map([[sessionId, { sessionId, agentSession }]]),
  } as unknown as WorkspaceGraph;
}

function fakeFactory(agentDir: string, graph: WorkspaceGraph | null): WorkspaceGraphFactory {
  return {
    deps: { agentDir },
    canonicalizeCwd: (cwd: string) => cwd,
    findBoundGraph: (cwd: string) => (graph && cwd === WS ? graph : null),
    // 小精灵自己的图在测试里永不建（回调投递会优雅降级成 logger.warn）。
    ensureBackgroundGraph: () =>
      Promise.resolve({ error: { message: "测试：不建小精灵图" } } as never),
  } as unknown as WorkspaceGraphFactory;
}

/**
 * 可模拟「图未绑定 → 后台重建」的假工厂：bound 为初始能查到的图，rebuilt 为
 * ensureBackgroundGraph 的产物（null = 重建失败）。记录两个入口的调用次数，
 * 便于断言「找得到就不重建」「不可达时不建图」之类的行为。
 */
function rebuildableFactory(
  agentDir: string,
  config: {
    /** 目标工作区（只有它的图会被「重建」；小精灵自己的图仍然建不出来）。 */
    cwd: string;
    bound: WorkspaceGraph | null;
    rebuilt: WorkspaceGraph | null;
  },
) {
  const calls = { findBoundGraph: 0, ensureBackgroundGraph: 0 };
  const buildError = {
    error: { code: "WORKSPACE_SWITCH_FAILED", message: "工作区打开失败（测试）" },
  };
  const disposed: AgentSession[] = [];
  const factory = {
    deps: { agentDir },
    canonicalizeCwd: (cwd: string) => cwd,
    findBoundGraph: (cwd: string) => {
      if (cwd !== config.cwd) return null;
      calls.findBoundGraph += 1;
      return config.bound;
    },
    ensureBackgroundGraph: async (cwd: string) => {
      if (cwd !== config.cwd) return buildError;
      calls.ensureBackgroundGraph += 1;
      return config.rebuilt ? { graph: config.rebuilt } : buildError;
    },
    disposeAgentSessionOnly: async (session: AgentSession) => {
      disposed.push(session);
    },
  } as unknown as WorkspaceGraphFactory;
  return { factory, calls, disposed };
}

/** 空图：没有任何驻留会话（模拟运行时对象已被释放）。 */
function emptyGraph(): WorkspaceGraph {
  return {
    agentSession: null,
    sessionSnapshot: null,
    backgroundSessions: new Map(),
    idleSessionCache: new Map(),
  } as unknown as WorkspaceGraph;
}

/** 真在盘上的工作区目录（重建图的 existsSync 门槛）。 */
function freshWorkspaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pixie-ws-resume-"));
  tracked.push(dir);
  return dir;
}

function failedRecord(
  agentDir: string,
  sessionId: string | null,
  cwd = WS,
  sessionPath = join(cwd, "session.jsonl"),
): string {
  const record = registerDispatch({
    cwd,
    sessionId,
    sessionPath,
    task: "整理工作区目录",
    agentDir,
  });
  // "Request was aborted" = 模型请求被中止（可重试），会话对象仍活着。
  failDispatch(record.id, "委派执行出错：Request was aborted", agentDir);
  return record.id;
}

/** 假的重开结果（openSessionIntoGraph 的返回值形状）。 */
function fakeOpened(
  sessionId: string,
  fake: ReturnType<typeof fakeSession>,
  cwd: string,
  sessionPath: string,
) {
  const sessionManager = {
    getCwd: () => cwd,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionPath,
  } as unknown as SessionManager;
  const unsubscribe = fake.session.subscribe(() => undefined);
  return {
    sessionId,
    sessionPath,
    session: fake.session,
    sessionManager,
    resourceLoader: {} as never,
    runtime: {
      sessionId,
      agentSession: fake.session,
      sessionManager,
      unsubscribeAgent: unsubscribe,
    } as never,
  };
}

/** 捕获 Host 侧事件（断言注入失败时确实回调了 error）。 */
function captureEvents(): Array<{ event: string; payload: Record<string, unknown> }> {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  configurePixieEventEmitter((event, payload) => {
    events.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
  });
  return events;
}

/** 等 fire-and-forget 的回调投递（deliverDispatchCallback）落到事件上。 */
async function waitForEvent(
  events: Array<{ event: string; payload: Record<string, unknown> }>,
  predicate: (entry: { event: string; payload: Record<string, unknown> }) => boolean,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 模拟一个续跑回合：助手产出 → 回合结束。 */
function driveContinuationTurn(fake: ReturnType<typeof fakeSession>, summary: string): void {
  const assistant = { role: "assistant", content: [{ type: "text", text: summary }] };
  fake.emit({ type: "message_end", message: assistant });
  fake.emit({ type: "agent_end", messages: [assistant] });
}

describe("pixie_retry resume 的会话可达性", () => {
  it("Map 未命中但图里能找到 → resume 成功，续跑后照常自动回调", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, "sess-graph");
    const fake = fakeSession("sess-graph");
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-graph", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });
    expect(outcome.ok).toBe(true);
    // 空闲会话必须走 prompt（真的开回合）；followUp 只是入队，不会自己跑起来。
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain("<pixie-resume");
    expect(fake.prompts[0]).toContain("整理工作区目录");
    expect(fake.prompts[0]).toContain("第 2 次尝试");
    expect(fake.followUps).toHaveLength(0);
    expect(fake.steers).toHaveLength(0);
    // 信封真的进了会话（假件把它落进了 state.messages）。
    expect(fake.messages.some((message) => message.content[0]?.text.includes("<pixie-resume"))).toBe(
      true,
    );
    // watcher 重挂了一条订阅（送达确认的临时订阅已退掉）。
    expect(fake.listenerCount()).toBe(1);
    const resumed = findDispatchById(dispatchId);
    expect(resumed?.status).toBe("dispatched");
    // failDispatch(+1) 后 resume 再 +1，与原语义一致。
    expect(resumed?.failCount).toBe(2);

    driveContinuationTurn(fake, "目录已整理好，共 3 个文件");

    const settled = findDispatchById(dispatchId);
    // 自动回调落 reported/done（settleDispatch 的既有落定形状）。
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toContain("目录已整理好");
    // 回合结束 → watcher 自行摘订阅并清掉内存条目（原有语义）。
    expect(fake.listenerCount()).toBe(0);
  });

  it("图里也找不到 → 仍报「不可达」，记录保持 failed 不被改动", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, "sess-gone");
    const factory = fakeFactory(agentDir, null);

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("目标会话已不可达");
    expect(outcome.error).toContain("redispatch");
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
  });

  it("记录没有 sessionId（理论上不该发生）→ 保持原有报错路径", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, null);
    // 图里即便有会话也无从匹配（没有 sessionId），只能判不可达。
    const fake = fakeSession("sess-unknown");
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-unknown", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("缺少 sessionId");
    expect(outcome.error).toContain("redispatch");
    expect(fake.prompts).toHaveLength(0);
  });

  it("Map 命中（正常 resume）不回归：不再回图里找，续跑照常回调", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, "sess-map");
    const fake = fakeSession("sess-map");
    let graphLookups = 0;
    const factory = {
      deps: { agentDir },
      canonicalizeCwd: (cwd: string) => cwd,
      findBoundGraph: (_cwd: string) => {
        graphLookups += 1;
        return null;
      },
      ensureBackgroundGraph: () => Promise.resolve({ error: { message: "测试：不建图" } } as never),
    } as unknown as WorkspaceGraphFactory;
    setDispatchSessionForTests(dispatchId, fake.session);

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });
    expect(outcome.ok).toBe(true);
    expect(graphLookups).toBe(0);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain("<pixie-resume");
    expect(fake.listenerCount()).toBe(1);

    driveContinuationTurn(fake, "续跑完成");

    const settled = findDispatchById(dispatchId);
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toContain("续跑完成");
  });

  it("mode 省略（auto）对图里能找回的会话也走 resume", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, "sess-auto");
    const fake = fakeSession("sess-auto");
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-auto", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({ dispatchId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.dispatchId).toBe(dispatchId);
    expect(fake.prompts[0]).toContain("<pixie-resume");
  });
});

describe("pixie_retry resume 的信封送达确认（不许假成功）", () => {
  it("abort 后 isStreaming 残留为 true、steer 实际无效 → 不返回 ok，记录不落 dispatched", async () => {
    const agentDir = freshAgentDir();
    setResumeInjectionTimingsForTests({ idleWaitMs: 10, confirmMs: 40 });
    const dispatchId = failedRecord(agentDir, "sess-stale");
    // 失效实例：一直说自己还在流式、waitForIdle 不结算、steer 只入队不投递。
    const fake = fakeSession("sess-stale", { streaming: true, deliver: false });
    const events = captureEvents();
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-stale", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    // 关键断言：不再返回 ok 却什么都没发生。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("流式状态");
    expect(outcome.error).toContain("没有真正投递");
    // 注入确实尝试过（steer 拿到了信封，内容完整），只是送达未确认。
    expect(fake.steers).toHaveLength(1);
    expect(fake.steers[0]).toContain("<pixie-resume");
    expect(fake.prompts).toHaveLength(0);
    // 记录停在 failed（没有被 reactivate 成假「进行中」），failCount 语义不变。
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
    expect(record?.report).toContain("Request was aborted");
    // 注入前的 watcher 都没挂：失败时不应残留订阅。
    expect(fake.listenerCount()).toBe(0);
    // 失败是可观测的：回调 error + sessionAlive 指向 redispatch。
    const isError = (entry: { event: string; payload: Record<string, unknown> }) =>
      entry.event === "pixie.reportReceived" && entry.payload.kind === "error";
    await waitForEvent(events, isError);
    const errors = events.filter(isError);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.payload.summary)).toContain("续跑注入失败");
    expect(errors[0]?.payload.sessionAlive).toBe("dead");
  });

  it("空闲会话 prompt 注入本身失败（无模型/凭据）→ ok:false，原因可观测，记录仍 failed", async () => {
    const agentDir = freshAgentDir();
    setResumeInjectionTimingsForTests({ idleWaitMs: 10, confirmMs: 200 });
    const dispatchId = failedRecord(agentDir, "sess-nomodel");
    const fake = fakeSession("sess-nomodel", { promptError: "No model selected" });
    const events = captureEvents();
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-nomodel", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("续跑信封注入失败");
    expect(outcome.error).toContain("No model selected");
    expect(fake.prompts).toHaveLength(1);
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
    expect(fake.listenerCount()).toBe(0);
    const isError = (entry: { event: string; payload: Record<string, unknown> }) =>
      entry.event === "pixie.reportReceived" && entry.payload.kind === "error";
    await waitForEvent(events, isError);
    expect(events.some(isError)).toBe(true);
  });

  it("注入后确认超时（prompt 既不报错也不落消息）→ ok:false，不落 dispatched", async () => {
    const agentDir = freshAgentDir();
    setResumeInjectionTimingsForTests({ idleWaitMs: 10, confirmMs: 30 });
    const dispatchId = failedRecord(agentDir, "sess-silent");
    // deliver:false 且 isStreaming:false = prompt 被接受但消息从没进会话。
    const fake = fakeSession("sess-silent", { deliver: false });
    const factory = fakeFactory(agentDir, graphWithIdleSession("sess-silent", fake.session));

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("没有进入目标会话");
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
    expect(fake.listenerCount()).toBe(0);
  });
});

/**
 * 2026-10-20 20:12/20:14 现场：用户不在目标工作区前台（图被换出/未绑定）时，
 * resume 只查 findBoundGraph 就判「会话不可达」，而会话 JSONL / sessions-cache
 * 都还在。修法：图没绑但工作区目录还在盘上 → ensureBackgroundGraph 重建，再在
 * 图里按 sessionId 找回（与排队转正、派单同一条路径）。
 */
describe("pixie_retry resume 的工作区图重建（用户不在该工作区前台）", () => {
  it("图未绑定但工作区目录还在 → 后台重建图后找回会话，resume 成功且续跑回调照常", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, "sess-parked", cwd);
    const fake = fakeSession("sess-parked");
    const { factory, calls } = rebuildableFactory(agentDir, {
      cwd,
      bound: null,
      rebuilt: graphWithIdleSession("sess-parked", fake.session),
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(true);
    // 真的走了「查图 → 未绑定 → 重建」这条路。
    expect(calls.findBoundGraph).toBeGreaterThan(0);
    expect(calls.ensureBackgroundGraph).toBe(1);
    // 续跑信封进了原会话（上下文零丢失）。
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain("<pixie-resume");
    expect(fake.prompts[0]).toContain("整理工作区目录");
    const resumed = findDispatchById(dispatchId);
    expect(resumed?.status).toBe("dispatched");
    expect(resumed?.failCount).toBe(2);

    driveContinuationTurn(fake, "目录已整理好（重建图后续跑）");

    const settled = findDispatchById(dispatchId);
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toContain("重建图后续跑");
  });

  it("图已绑定 → 不重建（找得到就不白建一张图）", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, "sess-bound", cwd);
    const fake = fakeSession("sess-bound");
    const { factory, calls } = rebuildableFactory(agentDir, {
      cwd,
      bound: graphWithIdleSession("sess-bound", fake.session),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(true);
    expect(calls.ensureBackgroundGraph).toBe(0);
    expect(fake.prompts).toHaveLength(1);
  });

  it("重建失败 → 报具体原因（不是模棱两可的不可达），记录停留 failed", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, "sess-broken", cwd);
    const events = captureEvents();
    const { factory, calls } = rebuildableFactory(agentDir, { cwd, bound: null, rebuilt: null });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("目标会话已不可达");
    expect(outcome.error).toContain("工作区图重建失败");
    expect(outcome.error).toContain("redispatch");
    expect(calls.ensureBackgroundGraph).toBe(1);
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
    // 不可达是明确的失败，不是静默假成功：不挂 watcher、不落 dispatched。
    expect(
      events.some(
        (entry) => entry.event === "pixie.reportReceived" && entry.payload.kind === "error",
      ),
    ).toBe(false);
  });

  it("重建成功但图里没有该会话、会话文件也没了 → 报「文件已不存在」，不去重开", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, "sess-missing", cwd);
    const other = fakeSession("sess-other");
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: null,
      rebuilt: graphWithIdleSession("sess-other", other.session),
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("会话记录文件已不存在");
    expect(outcome.error).toContain("redispatch");
    expect(outcome.error).not.toContain("目标会话已不可达");
    expect(other.prompts).toHaveLength(0);
    expect(openerMock.calls).toHaveLength(0);
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
  });

  it("记录缺 sessionId → 不为它白建一张图，直接报无法定位", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, null, cwd);
    const { factory, calls } = rebuildableFactory(agentDir, {
      cwd,
      bound: null,
      rebuilt: graphWithIdleSession("sess-whatever", fakeSession("sess-whatever").session),
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("缺少 sessionId");
    expect(calls.ensureBackgroundGraph).toBe(0);
  });

  it("工作区目录已不在盘上 → 不尝试重建，直接报目录不存在", async () => {
    const agentDir = freshAgentDir();
    const dispatchId = failedRecord(agentDir, "sess-gone", "D:/ws-deleted");
    const { factory, calls } = rebuildableFactory(agentDir, {
      cwd: "D:/ws-deleted",
      bound: null,
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("目标工作区目录不存在");
    expect(calls.ensureBackgroundGraph).toBe(0);
  });
});

/**
 * 会话运行时对象会被释放：切工作区时 disposeIdleSessionRuntimes、图被驱逐时
 * disposeGraphSessionRuntimes、idle cache TTL 到期。但会话 JSONL 一直在盘上。
 * resume 必须能「按 record.sessionPath 从文件重开进图」，而不是把「对象没了」
 * 当成「会话没了」。
 */
describe("pixie_retry resume 的会话重开（运行时对象已被释放）", () => {
  beforeEach(() => {
    openerMock.calls.length = 0;
    openerMock.opener = null;
  });

  it("图里没有 + 会话文件可读 → 从文件重开进图，resume 成功且信封内容正确", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const sessionId = "01a1593a-3ce1-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const dispatchId = failedRecord(agentDir, sessionId, cwd, sessionPath);
    const fake = fakeSession(sessionId);
    openerMock.opener = async () => fakeOpened(sessionId, fake, cwd, sessionPath);
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: emptyGraph(),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(true);
    // 重开走的正是记录里的会话文件。
    expect(openerMock.calls).toHaveLength(1);
    expect(openerMock.calls[0]?.sessionPath).toBe(sessionPath);
    // 续跑信封真的注入了重开的会话（内容完整）。
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain(`<pixie-resume dispatchId="${dispatchId}">`);
    expect(fake.prompts[0]).toContain("整理工作区目录");
    expect(fake.prompts[0]).toContain("第 2 次尝试");
    const resumed = findDispatchById(dispatchId);
    expect(resumed?.status).toBe("dispatched");
    expect(resumed?.failCount).toBe(2);

    // 重开的会话被 adopt：续跑回合结束照常自动回调。
    driveContinuationTurn(fake, "从断点继续完成（重开）");
    const settled = findDispatchById(dispatchId);
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toContain("从断点继续完成");
  });

  it("图里没有 + 会话文件不存在 → 明确报「文件已不存在，请 redispatch」，状态保持 failed", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const sessionId = "01a1593b-d9fc-770f-84b0-fd3f3b9efb86";
    const dispatchId = failedRecord(agentDir, sessionId, cwd, join(cwd, `${sessionId}.jsonl`));
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: emptyGraph(),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("会话记录文件已不存在");
    expect(outcome.error).toContain("redispatch");
    // 分层：不是含混的「不可达」。
    expect(outcome.error).not.toContain("目标会话已不可达");
    expect(openerMock.calls).toHaveLength(0);
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
  });

  it("重开失败（会话加载抛错）→ 返回可重试的重开失败错误，记录不变", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const sessionId = "01a1594c-1111-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const dispatchId = failedRecord(agentDir, sessionId, cwd, sessionPath);
    openerMock.opener = async () => ({
      error: {
        code: "SESSION_SWITCH_FAILED",
        message: "会话加载失败：model provider exploded",
        retryable: true,
      },
    });
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: emptyGraph(),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("重开会话失败");
    expect(outcome.error).toContain("model provider exploded");
    expect(outcome.error).toContain("可重试");
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
  });

  it("重开后 sessionId 对不上 → 明确报错并丢掉重开的会话（不静默换会话）", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const sessionId = "01a1594d-2222-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const dispatchId = failedRecord(agentDir, sessionId, cwd, sessionPath);
    const wrong = fakeSession("01a1594d-ffff-770f-84b0-fd3673e7a805");
    openerMock.opener = async () => fakeOpened(wrong.session.sessionId, wrong, cwd, sessionPath);
    const { factory, disposed } = rebuildableFactory(agentDir, {
      cwd,
      bound: emptyGraph(),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("sessionId 不匹配");
    expect(outcome.error).toContain(sessionId);
    expect(outcome.error).toContain(wrong.session.sessionId);
    // 错的会话不能被留在图里：退订 + dispose。
    expect(wrong.listenerCount()).toBe(0);
    expect(disposed).toHaveLength(1);
    expect(wrong.prompts).toHaveLength(0);
    const record = findDispatchById(dispatchId);
    expect(record?.status).toBe("failed");
    expect(record?.failCount).toBe(1);
  });

  it("并发 resume 两次 → 只重开一次、只注入一次", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const sessionId = "01a1594e-3333-770f-84b0-fd3673e7a805";
    const sessionPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, "");
    const dispatchId = failedRecord(agentDir, sessionId, cwd, sessionPath);
    const fake = fakeSession(sessionId);
    const gate: { open?: () => void } = {};
    const blocked = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    openerMock.opener = async () => {
      await blocked;
      return fakeOpened(sessionId, fake, cwd, sessionPath);
    };
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: emptyGraph(),
      rebuilt: null,
    });
    const deps = createPixieControlPlaneDeps(factory);

    const first = deps.retry({ dispatchId, mode: "resume" });
    const second = deps.retry({ dispatchId, mode: "resume" });
    gate.open?.();
    const [left, right] = await Promise.all([first, second]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(openerMock.calls).toHaveLength(1);
    expect(fake.prompts).toHaveLength(1);
    // 两条订阅：重开 runtime 自己的 handleAgentEvent + 续跑 watcher（各一条，没有重复）。
    expect(fake.listenerCount()).toBe(2);
  });

  it("图里能找到 → 绝不重开（一个会话不能挂两份 runtime）", async () => {
    const agentDir = freshAgentDir();
    const cwd = freshWorkspaceDir();
    const dispatchId = failedRecord(agentDir, "sess-alive", cwd);
    const fake = fakeSession("sess-alive");
    const { factory } = rebuildableFactory(agentDir, {
      cwd,
      bound: graphWithIdleSession("sess-alive", fake.session),
      rebuilt: null,
    });

    const outcome = await createPixieControlPlaneDeps(factory).retry({
      dispatchId,
      mode: "resume",
    });

    expect(outcome.ok).toBe(true);
    expect(openerMock.calls).toHaveLength(0);
    expect(fake.prompts).toHaveLength(1);
  });
});
