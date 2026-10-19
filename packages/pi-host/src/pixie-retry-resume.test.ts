/**
 * pixie_retry(mode=resume) 的会话可达性判定。
 *
 * 背景：委派会话因 "Request was aborted" 这类可重试错误失败时，会话对象本身
 * 还活着（回调里 sessionAlive: "alive"），但回合结束分支已经把
 * dispatchId → AgentSession 的内存条目删掉了。resume 只看内存 Map 就会误判
 * 「目标会话已不可达」，逼用户 redispatch 丢掉上下文。
 *
 * 这里锁三件事：
 * a) Map 未命中但绑定的工作区图里能找到会话 → resume 成功，watcher 重挂，
 *    续跑回合结束照常自动回调（记录落 done）；
 * b) 图里也找不到 → 仍然报「不可达」，行为不回归；
 * c) Map 命中（正常 resume）不回归，且不会再回图里找。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  failDispatch,
  findDispatchById,
  registerDispatch,
  resetPixieStateForTests,
} from "./pixie-agent-runner.js";
import { createPixieControlPlaneDeps, setDispatchSessionForTests } from "./pixie-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

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
  resetPixieStateForTests();
});

type Listenable = { type: string } & Record<string, unknown>;

/** 最小 AgentSession 假件：只实装 watcher / resume 用到的那几个口子。 */
function fakeSession(sessionId: string) {
  const listeners = new Set<(event: Listenable) => void>();
  const followUps: string[] = [];
  const steers: string[] = [];
  const session = {
    sessionId,
    sessionName: "委派会话",
    model: { provider: "test", id: "test-model" },
    isStreaming: false,
    followUp: (text: string) => {
      followUps.push(text);
    },
    steer: (text: string) => {
      steers.push(text);
      return Promise.resolve();
    },
    prompt: () => Promise.resolve(),
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
    followUps,
    steers,
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

function failedRecord(agentDir: string, sessionId: string | null): string {
  const record = registerDispatch({
    cwd: WS,
    sessionId,
    sessionPath: "D:/ws-resume/session.jsonl",
    task: "整理工作区目录",
    agentDir,
  });
  // "Request was aborted" = 模型请求被中止（可重试），会话对象仍活着。
  failDispatch(record.id, "委派执行出错：Request was aborted", agentDir);
  return record.id;
}

/** 模拟一个续跑回合：用户信封 → 助手产出 → 回合结束。 */
function driveContinuationTurn(fake: ReturnType<typeof fakeSession>, summary: string): void {
  const envelope = fake.followUps.at(-1) ?? fake.steers.at(-1) ?? "";
  fake.emit({ type: "message_end", message: { role: "user", content: envelope } });
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
    // 续跑信封注入了原会话（上下文零丢失），watcher 重挂了一条订阅。
    expect(fake.followUps).toHaveLength(1);
    expect(fake.followUps[0]).toContain("<pixie-resume");
    expect(fake.followUps[0]).toContain("整理工作区目录");
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
    expect(outcome.error).toContain("目标会话已不可达");
    expect(fake.followUps).toHaveLength(0);
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
    expect(fake.followUps).toHaveLength(1);
    expect(fake.followUps[0]).toContain("<pixie-resume");
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
    expect(fake.followUps[0]).toContain("<pixie-resume");
  });
});
