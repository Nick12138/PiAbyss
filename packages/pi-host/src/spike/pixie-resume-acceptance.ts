/**
 * 真实验收：委派 resume 在「会话运行时对象已被释放」时的原地续跑。
 *
 * 为什么需要这个脚本：单测把 WorkspaceGraphFactory 和 openSessionIntoGraph
 * 换成了假件，证明不了「真实 AgentSession + 真实 JSONL + 真实模型回合」这条链路。
 * 这里用真实模块跑完整流程，只把两样东西换成桩：
 *   1) 模型端点：本机 HTTP 桩（OpenAI chat-completions 兼容），不联网、不要真实
 *      凭据；桩会把每次请求体落盘，用来证明续跑回合带上了此前全部上下文；
 *   2) 工作区图工厂：脚本自己维护一张图（= 后台图 + backgroundSessions），
 *      因为完整的 Host 工厂需要桌面端/服务端上下文才能装配。
 *
 * 三个场景（对应工单 A/B/C）：
 *   A 图还在、runtime 也还在（用户只是切走了前台） → resume 直接复用图里的会话；
 *   B 图还在、runtime 已被释放（切工作区会 disposeIdleSessionRuntimes）
 *     → resume 走「按 sessionPath 从文件重开」；
 *   C 图也被驱逐（重启 / LRU 逐出）→ resume 先重建图，再从文件重开。
 *
 * 运行：cd packages/pi-host && npx tsx src/spike/pixie-resume-acceptance.ts
 *      （或 pnpm --filter @piabyss/pi-host accept:pixie-resume）
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { configurePixieRuntime } from "../pixie-agent-runner.js";
import { createPixieControlPlaneDeps } from "../pixie-controller.js";
import type { WorkspaceGraphFactory } from "../workspace-graph-factory.js";
import type { WorkspaceGraph } from "../workspace-graph-types.js";
import { sessionStorageDirs } from "../session-storage.js";

const ROOT = mkdtempSync(join(tmpdir(), "pixie-resume-accept-"));
const AGENT_DIR = join(ROOT, "agent");
const WS = join(ROOT, "workspace");
const MODEL = "stub-model";
const PROVIDER = "stub";

type CapturedRequest = {
  scenario: string;
  marker: string;
  stream: boolean;
  messages: Array<{ role: string; content: unknown }>;
  at: string;
};

const captured: CapturedRequest[] = [];

function log(...args: unknown[]): void {
  process.stdout.write(`[accept] ${args.map((value) => String(value)).join(" ")}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text"
          ? String((block as { text?: string }).text ?? "")
          : "",
      )
      .join("\n");
  }
  return "";
}

/** 本机 OpenAI chat-completions 桩：dispatched 轮次慢（便于手动停止），续跑轮次快。 */
function startStubModel(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const lastUserText = textOfContent(lastUser?.content);
      const marker = lastUserText.includes("<pixie-resume")
        ? "resume"
        : lastUserText.includes("<pixie-dispatch")
          ? "dispatch"
          : "other";
      const scenario = process.env.PIXIE_ACCEPT_SCENARIO ?? "?";
      captured.push({
        scenario,
        marker,
        stream: body.stream === true,
        messages,
        at: new Date().toISOString(),
      });
      const delayMs = marker === "dispatch" ? 8000 : 150;
      const reply =
        marker === "resume"
          ? "续跑确认：我已读到之前的进度，从第 4 个数字继续（4, 5, 6）。"
          : "收到任务：1, 2, 3（继续中）。";
      setTimeout(() => {
        if (body.stream === true) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const base = {
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: MODEL,
          };
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })}\n\n`,
          );
          for (const piece of reply.match(/.{1,12}/gu) ?? []) {
            res.write(
              `data: ${JSON.stringify({
                ...base,
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
              })}\n\n`,
            );
          }
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: reply },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
      }, delayMs);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

type Harness = {
  factory: WorkspaceGraphFactory;
  graphs: Map<string, WorkspaceGraph>;
  releaseRuntime: (graph: WorkspaceGraph, sessionId: string) => Promise<void>;
  dropGraph: (canonicalCwd: string) => void;
  rebuilds: number;
};

function createHarness(agentDir: string, modelRuntime: ModelRuntime): Harness {
  const graphs = new Map<string, WorkspaceGraph>();
  const rebuilds = { count: 0 } as unknown as Harness["rebuilds"] & { count: number };

  const buildGraph = (canonicalCwd: string): WorkspaceGraph => {
    const graph = {
      workspaceId: randomUUID(),
      cwd: canonicalCwd,
      canonicalCwd,
      revision: 1,
      servicesReady: true,
      settingsManager: SettingsManager.create(canonicalCwd, agentDir, { projectTrusted: false }),
      packageManager: null,
      resourceLoader: null,
      sessionManager: null,
      agentSession: null,
      extensionsResult: null,
      packageSnapshot: null,
      sessionSnapshot: null,
      toolRevision: 1,
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
    graphs.set(canonicalCwd, graph);
    return graph;
  };

  const factory = {
    deps: {
      agentDir,
      modelRuntime,
      packageUpdateCheck: false,
      maxBoundWorkspaces: 5,
      recordMigrationMilestone: async () => undefined,
    },
    canonicalizeCwd: (cwd: string) => resolve(cwd),
    sessionPathsEqual: (left: string | undefined, right: string) =>
      !!left && resolve(left) === resolve(right),
    findBoundGraph: (canonicalCwd: string) => graphs.get(canonicalCwd) ?? null,
    ensureBackgroundGraph: async (cwd: string) => {
      const canonical = resolve(cwd);
      const existing = graphs.get(canonical);
      if (existing) return { graph: existing };
      if (canonical === resolve(WS)) rebuilds.count += 1;
      return { graph: buildGraph(canonical) };
    },
    getGraph: () => null,
    handleAgentEvent: () => undefined,
    touchIdleSession: () => undefined,
    announceRetainedRuntime: () => undefined,
    isSessionBusy: (session: AgentSession) => !session.isIdle,
    disposeAgentSessionOnly: async (session: AgentSession) => {
      try {
        if (!session.isIdle) await session.abort();
      } catch {
        /* ignore */
      }
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    },
  } as unknown as WorkspaceGraphFactory;

  return {
    factory,
    graphs,
    rebuilds,
    releaseRuntime: async (graph, sessionId) => {
      const runtime = graph.backgroundSessions.get(sessionId);
      if (!runtime) return;
      graph.backgroundSessions.delete(sessionId);
      graph.idleSessionCache?.delete(sessionId);
      try {
        runtime.unsubscribeAgent?.();
      } catch {
        /* ignore */
      }
      try {
        if (!runtime.agentSession.isIdle) await runtime.agentSession.abort();
      } catch {
        /* ignore */
      }
      try {
        runtime.agentSession.dispose();
      } catch {
        /* ignore */
      }
    },
    dropGraph: (canonicalCwd) => {
      graphs.delete(canonicalCwd);
    },
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function tailEntries(path: string, count: number): Array<Record<string, unknown>> {
  return readJsonl(path).slice(-count).map((entry) => {
    const message = entry.message as
      | { role?: string; content?: unknown; stopReason?: string }
      | undefined;
    const text = textOfContent(message?.content).replace(/\s+/gu, " ").slice(0, 90);
    return {
      time: entry.timestamp ?? null,
      type: entry.type,
      role: message?.role ?? null,
      stopReason: message?.stopReason ?? null,
      text,
    };
  });
}

function dispatchRecord(agentDir: string, dispatchId: string): Record<string, unknown> | null {
  const path = join(agentDir, "piabyss", "pixie", "dispatches.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      records?: Array<Record<string, unknown>>;
    };
    return parsed.records?.find((record) => record.id === dispatchId) ?? null;
  } catch {
    return null;
  }
}

function pickRecord(record: Record<string, unknown> | null): Record<string, unknown> {
  if (!record) return {};
  return {
    id: record.id,
    status: record.status,
    failCount: record.failCount,
    sessionId: record.sessionId,
    lastActiveAt: record.lastActiveAt,
    report: typeof record.report === "string" ? record.report.slice(0, 80) : record.report,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`超时等待：${label}`);
}

async function runScenario(
  scenario: "A" | "B" | "C",
  harness: Harness,
  agentDir: string,
): Promise<void> {
  process.env.PIXIE_ACCEPT_SCENARIO = scenario;
  log(`\n===== 场景 ${scenario} =====`);
  const deps = createPixieControlPlaneDeps(harness.factory);
  const canonical = resolve(WS);
  if (scenario === "C") harness.dropGraph(canonical);
  const graphBefore = harness.factory.findBoundGraph(canonical);
  const built = graphBefore ?? (await harness.factory.ensureBackgroundGraph(canonical));
  const graph = "error" in built ? null : "graph" in built ? built.graph : built;
  if (!graph) throw new Error("场景准备失败：拿不到工作区图");

  const dispatch = await deps.dispatch({
    cwd: WS,
    task: `场景${scenario}：从 1 数到 6（每数一个就打印一次），数完汇报。`,
  });
  if (!dispatch.ok) throw new Error(`委派失败：${dispatch.error}`);
  log(`dispatchId=${dispatch.dispatchId} sessionId=${dispatch.sessionId}`);
  log(`sessionPath=${dispatch.sessionPath}`);
  log(`图内后台会话：${[...graph.backgroundSessions.keys()].join(",") || "（空）"}`);

  await waitFor(
    () => readJsonl(dispatch.sessionPath).some((entry) => {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      return message?.role === "user" && textOfContent(message.content).includes("<pixie-dispatch");
    }),
    15000,
    "派单信封落盘",
  );
  await sleep(600);

  const stopped = await deps.stop({ dispatchId: dispatch.dispatchId });
  log(`stop → ${JSON.stringify(stopped)}`);
  log(`dispatches.json（停止后）: ${JSON.stringify(pickRecord(dispatchRecord(agentDir, dispatch.dispatchId)))}`);

  const runtime = graph.backgroundSessions.get(dispatch.sessionId);
  await waitFor(() => (runtime ? runtime.agentSession.isIdle : true), 15000, "被叫停的回合结算");
  const jsonlBeforeResume = readJsonl(dispatch.sessionPath).length;

  if (scenario === "A") {
    log(`runtime 仍在图里：${graph.backgroundSessions.has(dispatch.sessionId)}`);
  } else {
    await harness.releaseRuntime(graph, dispatch.sessionId);
    log(`runtime 已释放：remaining=${graph.backgroundSessions.size}（图仍在：${!!harness.graphs.get(canonical)}）`);
    if (scenario === "C") {
      harness.dropGraph(canonical);
      log("图也已驱逐（findBoundGraph → null，resume 必须重建图）");
    }
  }

  const capturedBefore = captured.length;
  const resumed = await deps.retry({ dispatchId: dispatch.dispatchId, mode: "resume" });
  log(`retry(resume) → ${JSON.stringify(resumed)}`);

  const graphAfter = harness.graphs.get(canonical);
  log(
    `resume 后图内后台会话：${[...(graphAfter?.backgroundSessions.keys() ?? [])].join(",") || "（空）"}` +
      `（图重建次数=${(harness.rebuilds as unknown as { count: number }).count}）`,
  );
  if (resumed.ok) {
    await waitFor(
      () => readJsonl(dispatch.sessionPath).some((entry) => {
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        return message?.role === "user" && textOfContent(message.content).includes("<pixie-resume");
      }),
      20000,
      "续跑信封落盘",
    );
    await sleep(1200);
  }

  const jsonlAfter = readJsonl(dispatch.sessionPath);
  const resumeRequest = captured.slice(capturedBefore).find((entry) => entry.marker === "resume");
  log(`JSONL 条目：停止后 ${jsonlBeforeResume} → 续跑后 ${jsonlAfter.length}`);
  log(`JSONL 尾部：\n${JSON.stringify(tailEntries(dispatch.sessionPath, 6), null, 2)}`);
  log(
    `续跑回合的请求上下文：messages=${resumeRequest?.messages.length ?? 0} 条，` +
      `含原任务=${resumeRequest
        ? resumeRequest.messages.some(
            (message) =>
              message.role === "user" &&
              textOfContent(message.content).includes(`场景${scenario}：从 1 数到 6`),
          )
        : false}`,
  );
  log(
    `dispatches.json（续跑后）: ${JSON.stringify(pickRecord(dispatchRecord(agentDir, dispatch.dispatchId)))}`,
  );
  // 关闭场景：把这张图里的会话都收掉，避免后续场景串味。
  for (const sessionId of [...graph.backgroundSessions.keys()]) {
    await harness.releaseRuntime(graph, sessionId);
  }
}

async function main(): Promise<void> {
  // 让 SDK 的默认会话目录也落在脚本的 agentDir 下（生产里两者同为 ~/.pi/agent）。
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  mkdirSync(AGENT_DIR, { recursive: true });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(AGENT_DIR, "auth.json"), "{}\n");
  writeFileSync(join(AGENT_DIR, "settings.json"), "{}\n");
  const stub = await startStubModel();
  writeFileSync(
    join(AGENT_DIR, "models.json"),
    JSON.stringify(
      {
        providers: {
          [PROVIDER]: {
            name: "Local stub",
            baseUrl: stub.baseUrl,
            apiKey: "sk-local-stub",
            api: "openai-completions",
            models: [
              {
                id: MODEL,
                name: "Local stub model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
        piabyssEnabledProviders: [PROVIDER],
      },
      null,
      2,
    ),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(AGENT_DIR, "auth.json"),
    modelsPath: join(AGENT_DIR, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const available = await modelRuntime.getAvailable();
  log(`可用模型：${available.map((model) => `${model.provider}/${model.id}`).join(",") || "（无）"}`);
  if (available.length === 0) throw new Error("桩 Provider 没被 ModelRuntime 认出来");
  configurePixieRuntime(modelRuntime);

  const harness = createHarness(AGENT_DIR, modelRuntime);
  const sessionsDir = sessionStorageDirs(AGENT_DIR, WS).activeDir;
  log(`agentDir=${AGENT_DIR}`);
  log(`workspace=${WS}（sessions: ${sessionsDir}）`);

  try {
    await runScenario("A", harness, AGENT_DIR);
    await runScenario("B", harness, AGENT_DIR);
    await runScenario("C", harness, AGENT_DIR);
  } finally {
    writeFileSync(
      join(ROOT, "stub-requests.json"),
      `${JSON.stringify(captured, null, 2)}\n`,
    );
    log(`\n所有桩请求已保存：${join(ROOT, "stub-requests.json")}`);
    log(`临时根目录（含 agentDir / JSONL / dispatches.json）：${ROOT}`);
    await stub.close();
  }
}

main().catch((error) => {
  process.stderr.write(`验收脚本失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
