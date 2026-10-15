/**
 * Pixie protocol handlers (`pixie.*` methods) + the delegation engine that
 * backs `pixie_dispatch`.
 *
 * The engine resolves a delegation target through EXISTING workspace graph
 * state (active session → busy background runtimes → idle cache), injecting
 * the task prompt with the SDK's own queue semantics: a busy session gets the
 * task as a follow-up (processed after the current turn settles — the user's
 * real-time turns are never interrupted), an idle/loaded session is prompted
 * directly. v4: when the target workspace is NOT open but is a known
 * workspace (frontend-pushed `pixie.setContext`, persisted in context.json),
 * the engine background-builds its graph via `ensureBackgroundGraph` and
 * delegates as usual — the conversation lands in a real formal session the
 * user can open and continue later.
 *
 * Callbacks come in three kinds: done (pixie_report or the turn-end
 * auto-fallback below), error (injection failure / error turn / user abort —
 * automatic), and ask (pixie_ask → awaiting_user → user reply routed back
 * with a `<pixie-reply>` followUp). Every dispatch turn is attributed by its
 * `<pixie-dispatch>` envelope marker, so later user turns never trigger the
 * auto-fallback, and an already-settled record is never settled twice.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHostError,
  type PixieDispatchRecord,
  type PixieStopAction,
  type PixieWorkspaceSessionSummary,
} from "@piabyss/protocol";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import {
  applyDispatchRecordsToSessionCache,
  isPixieOwnedSessionId,
  isPixieOwnedSessionPath,
  listPixieSessions,
  upsertPixieSession,
} from "./pixie-session-cache.js";
import type { MethodHandler } from "./server.js";
import {
  activateDispatch,
  askDispatch,
  cancelQueuedDispatch,
  classifyError,
  configurePixieTerminalSettleHook,
  currentPixieSessionId,
  deliverDispatchCallback,
  ensurePixieCurrent,
  failDispatch,
  findDispatchById,
  findDispatchBySession,
  findDuplicateDispatchRequest,
  getKnownWorkspaces,
  injectPixieMessage,
  liveDispatchFor,
  listDispatches,
  listDispatchesForPanel,
  progressDispatch,
  queuedDispatchesFor,
  reactivateDispatchAfterReply,
  reactivateDispatchForResume,
  recordDispatchModelChange,
  registerDispatch,
  requestPixieRest,
  requestPixieSegment,
  resumePausedDispatch,
  settleDispatch,
  setPixieContext,
  stopSettleDispatch,
  summarizeDelegatedProgress,
} from "./pixie-agent-runner.js";
import { getEnabledProviderIds, getProviderModelAllowLists } from "./provider-models-config.js";
import type { PixieControlPlaneDeps } from "./pixie-control-plane.js";
import { recordPixieDispatch, readPixieUsage } from "./pixie-usage.js";
import { createHostAgentSession } from "./agent-session-factory.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { isRepoPluginEnabled, PIXIE_PLUGIN_ENTRY_FILE } from "./plugin-gate.js";

/** Error returned for every pixie.* call while the pi-pixie plugin is off. */
function pixiePluginDisabledError() {
  return createHostError(
    "RESOURCE_NOT_FOUND",
    "The pixie plugin (pi-pixie) is disabled. Enable it in the plugin library to use the pixie page.",
  );
}

/** The delegation prompt template (V1: a first-class built-in artifact). */
export function buildDispatchTaskPrompt(input: { task: string; from: string }): string {
  return [
    "<pixie-dispatch>",
    `这条任务来自「小精灵」（${input.from}）。请按以下要求执行：`,
    "",
    input.task,
    "",
    "完成（或确认无法完成）后，必须调用 pixie_report 工具回调：",
    "- result 字段填「已完成/未完成 + 结果摘要 + 关键数据」，不要粘贴全文；",
    "- 产出了文件或修改了文件时，把文件路径列表填入 files 字段（绝对路径）；",
    "- 失败或部分完成时把 success 设为 false 并说明原因。",
    "用户随时可能插入进度检查点（<pixie-interject> 信封）：append 模式是补充约束，读完继续；checkpoint 模式要求你立即调用 pixie_report（kind=progress）汇报当前进度，然后按信封指示继续或暂停。",
    "需要用户决策时（方案选择、信息补充、确认操作等），调用 pixie_ask 工具把问题转给小精灵转述给用户（question 填问题，options 可附选项）；不要干等，也不要替用户下结论——用户答复会以 <pixie-reply> 信封回到本会话。",
    "如果本任务源自某条备忘录，先调用 piabyss_memo complete 回填该备忘录（提交结果总结），再调用 pixie_report。",
    "用户在会话中手动发送的指令优先级最高，与上述要求冲突时以用户指令为准。",
    "只有任务已产出最终结果、不再等待用户输入时才回填备忘录 complete；若需要用户决策（如让用户选择方案）或任务未完成，先回调 pixie_report 或 pixie_ask 如实报告进度，等有结论再回填。",
    "不要代用户下结论；做不完就如实报告进度。",
    "</pixie-dispatch>",
  ].join("\n");
}

type TargetResolution =
  | {
      ok: true;
      graph: WorkspaceGraph;
      session: AgentSession;
      sessionId: string;
      sessionPath: string;
      busy: boolean;
      reused: boolean;
    }
  | { ok: false; error: string };

/**
 * Find the delegation target inside an already-open workspace: the active
 * session, then busy background runtimes, then the idle cache.
 *
 * v4.3 会话归属：**只有小精灵自己创建的会话**（sessions-cache.json 里
 * owner="pixie"，由委派引擎建过或小精灵工作区自己的段会话）才是候选。用户自己
 * 在 UI 里创建的会话一律跳过——否则委派会塞进用户正在操作的会话里，跟用户抢同一
 * 个上下文。用户想让小精灵处理自己的某个会话时，必须在对话里给出会话 id（见
 * resolveExplicitTargetSession）。
 */
function findTargetSession(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  agentDir: string,
): TargetResolution {
  const isOwned = (sessionId: string | null, sessionPath: string | null): boolean =>
    isPixieOwnedSessionPath(agentDir, sessionPath ?? "") ||
    isPixieOwnedSessionId(agentDir, sessionId ?? "");
  const active = graph.agentSession;
  const activeSnapshot = graph.sessionSnapshot;
  if (
    active &&
    activeSnapshot &&
    isOwned(activeSnapshot.sessionId, activeSnapshot.sessionPath ?? "")
  ) {
    return {
      ok: true,
      graph,
      session: active,
      sessionId: activeSnapshot.sessionId,
      sessionPath: activeSnapshot.sessionPath ?? "",
      busy: factory.isSessionBusy(active),
      reused: true,
    };
  }
  for (const runtime of graph.backgroundSessions.values()) {
    if (!isOwned(runtime.sessionId, runtime.sessionSnapshot.sessionPath ?? "")) continue;
    return {
      ok: true,
      graph,
      session: runtime.agentSession,
      sessionId: runtime.sessionId,
      sessionPath: runtime.sessionSnapshot.sessionPath ?? "",
      busy: factory.isSessionBusy(runtime.agentSession),
      reused: true,
    };
  }
  for (const runtime of graph.idleSessionCache?.values() ?? []) {
    if (!isOwned(runtime.sessionId, runtime.sessionSnapshot.sessionPath ?? "")) continue;
    return {
      ok: true,
      graph,
      session: runtime.agentSession,
      sessionId: runtime.sessionId,
      sessionPath: runtime.sessionSnapshot.sessionPath ?? "",
      busy: false,
      reused: true,
    };
  }
  return { ok: false, error: "no candidate session" };
}

/**
 * 显式指定会话（用户在对话中给出了会话 id）：此时允许复用用户自己的会话。
 * 找不到 → null（调用方给出可读错误，绝不静默落到别的会话上）。
 */
function resolveExplicitTargetSession(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  sessionId: string,
): TargetResolution | null {
  const activeSnapshot = graph.sessionSnapshot;
  if (graph.agentSession && activeSnapshot?.sessionId === sessionId) {
    return {
      ok: true,
      graph,
      session: graph.agentSession,
      sessionId,
      sessionPath: activeSnapshot.sessionPath ?? "",
      busy: factory.isSessionBusy(graph.agentSession),
      reused: true,
    };
  }
  for (const runtime of graph.backgroundSessions.values()) {
    if (runtime.sessionId !== sessionId) continue;
    return {
      ok: true,
      graph,
      session: runtime.agentSession,
      sessionId,
      sessionPath: runtime.sessionSnapshot.sessionPath ?? "",
      busy: factory.isSessionBusy(runtime.agentSession),
      reused: true,
    };
  }
  for (const runtime of graph.idleSessionCache?.values() ?? []) {
    if (runtime.sessionId !== sessionId) continue;
    return {
      ok: true,
      graph,
      session: runtime.agentSession,
      sessionId,
      sessionPath: runtime.sessionSnapshot.sessionPath ?? "",
      busy: false,
      reused: true,
    };
  }
  return null;
}

/** Spin up a brand-new formal session inside the target workspace. */
async function createTargetSession(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
): Promise<{ ok: true; sessionId: string; sessionPath: string } | { ok: false; error: string }> {
  if (!graph.servicesReady || !graph.settingsManager) {
    return { ok: false, error: "目标工作区未就绪" };
  }
  const sessionManager = SessionManager.create(graph.canonicalCwd);
  const settings = graph.settingsManager;
  const resourceLoader = new DefaultResourceLoader({
    cwd: graph.canonicalCwd,
    agentDir: factory.deps.agentDir,
    settingsManager: settings,
    extensionFactories: [], // formal workspace session: extensions load via packages, not here
  });
  await resourceLoader.reload();
  try {
    const created = await createHostAgentSession({
      cwd: graph.canonicalCwd,
      agentDir: factory.deps.agentDir,
      modelRuntime: factory.deps.modelRuntime,
      settingsManager: settings,
      resourceLoader,
      sessionManager,
    });
    const session = created.session;
    const snapshot = buildSessionSnapshot({
      session,
      sessionManager,
      cwd: graph.canonicalCwd,
      sessionId: session.sessionId,
      revision: 0,
      workspaceId: graph.workspaceId,
      toolRevision: graph.toolRevision,
    });
    // Park it as a background runtime of the graph so it is visible, resumable,
    // and receives agent events (the workspace's session list reads the disk
    // file; the runtime keeps it drivable without stealing the active slot).
    graph.backgroundSessions.set(session.sessionId, {
      sessionId: session.sessionId,
      sessionRevision: 0,
      sessionManager,
      agentSession: session,
      resourceLoader,
      extensionsResult: created.extensionsResult,
      toolRevision: graph.toolRevision,
      sessionSnapshot: snapshot,
      unsubscribeAgent: session.subscribe(() => undefined),
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      extensionUiReplayState: null,
    });
    return {
      ok: true,
      sessionId: session.sessionId,
      sessionPath: session.sessionFile ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ── 委派回合跟踪（自动回调 + 回合归属判定）────────────────────────── */

/** Live delegated sessions by dispatch id (reply routing + restart = miss). */
const dispatchedSessions = new Map<string, AgentSession>();

/**
 * Model/thinking-level override for delegated sessions (v4.2). Mirrors the
 * manual `model.setCurrent` semantics: a switch is safe while a run is in
 * flight — the SDK re-reads the session model at every turn boundary, so the
 * current LLM call finishes on the previous model and the next turn (the
 * interjection's follow-up) continues on the new one. Only applied when the
 * user explicitly authorized it (the pixie never changes models on its own).
 */
async function applyDispatchModelOverride(
  factory: WorkspaceGraphFactory,
  session: AgentSession,
  override: { model?: string | null; thinkingLevel?: string | null },
): Promise<
  { ok: true; model: string | null; thinkingLevel: string | null } | { ok: false; error: string }
> {
  const agentDir = factory.deps.agentDir;
  let appliedModel: string | null = null;
  if (override.model !== undefined && override.model !== null && override.model.trim()) {
    const spec = override.model.trim();
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) {
      return { ok: false, error: `模型格式应为 provider/id：${spec}` };
    }
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    const enabledProviders = await getEnabledProviderIds(
      agentDir,
      session.model?.provider,
      factory.deps.modelRuntime.getProviders().map((entry) => entry.id),
    );
    if (enabledProviders && !enabledProviders.includes(provider)) {
      return { ok: false, error: `Provider ${provider} 未启用；请先在 Provider 设置中启用` };
    }
    const allow = (await getProviderModelAllowLists(agentDir))?.[provider];
    if (allow && !allow.includes(modelId)) {
      return {
        ok: false,
        error: `模型 ${modelId} 在 Provider ${provider} 下被隐藏；请先在 Provider 设置中启用`,
      };
    }
    const registry = factory.deps.modelRegistry;
    const model = (registry.getAvailable?.() ?? []).find(
      (entry: { provider: string; id: string }) =>
        entry.provider === provider && entry.id === modelId,
    );
    if (!model) {
      return { ok: false, error: `找不到模型：${spec}` };
    }
    try {
      await session.setModel(model);
    } catch (error) {
      return {
        ok: false,
        error: `切换模型失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    appliedModel = spec;
  }
  if (override.thinkingLevel !== undefined && override.thinkingLevel !== null) {
    try {
      session.setThinkingLevel(override.thinkingLevel as never);
      appliedModel =
        appliedModel ?? (session.model ? `${session.model.provider}/${session.model.id}` : null);
    } catch {
      /* level not supported by the model — keep the session default */
    }
  }
  return { ok: true, model: appliedModel, thinkingLevel: override.thinkingLevel ?? null };
}

function messageTextOf(message: { content?: unknown } | undefined): string {
  const content = message?.content;
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lastAssistantSummary(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const text = messageTextOf(message).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Watch delegated turns: attribute them by the `<pixie-dispatch>` envelope in
 * the first user message, then settle the record automatically when the turn
 * ends — done (last assistant message, truncated) unless the agent already
 * reported/asked, error on runtime error or user abort. A paused record
 * (checkpoint wait) keeps the watcher alive across the pause; the record is
 * never settled twice.
 */
function watchDispatchTurn(
  factory: WorkspaceGraphFactory,
  session: AgentSession,
  dispatchId: string,
): void {
  const agentDir = factory.deps.agentDir;
  let envelopeSeen = false;
  let errorMessage: string | null = null;
  let finished = false;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (finished) return;
    if (event.type === "message_end") {
      if (
        event.message.role === "user" &&
        messageTextOf(event.message).includes("<pixie-dispatch")
      ) {
        envelopeSeen = true;
        return;
      }
      // Runtime errors surface as assistant messages with stopReason "error".
      if (event.message.role === "assistant") {
        const assistant = event.message as { stopReason?: unknown; errorMessage?: unknown };
        if (
          assistant.stopReason === "error" ||
          (typeof assistant.errorMessage === "string" && assistant.errorMessage)
        ) {
          errorMessage =
            typeof assistant.errorMessage === "string" && assistant.errorMessage
              ? assistant.errorMessage
              : "委派执行出错";
        }
      }
      return;
    }
    if (event.type === "agent_end") {
      if (event.willRetry === true) return;
      const live = findDispatchById(dispatchId);
      if (!live) {
        finished = true;
        unsubscribe();
        dispatchedSessions.delete(dispatchId);
        return;
      }
      // Checkpoint pause: the turn ended on purpose (汇报后暂停) — keep the
      // watcher armed for the resumed turn and settle nothing.
      if (live.status === "paused") return;
      if (live.status !== "dispatched" || !envelopeSeen) {
        finished = true;
        unsubscribe();
        dispatchedSessions.delete(dispatchId);
        return;
      }
      finished = true;
      unsubscribe();
      dispatchedSessions.delete(dispatchId);
      const summary = lastAssistantSummary(event.messages).trim();
      if (errorMessage) {
        const settled = failDispatch(dispatchId, `委派执行出错：${errorMessage}`, agentDir);
        if (settled) {
          void deliverDispatchCallback(factory, {
            agentDir,
            record: settled,
            kind: "error",
            summary: `委派执行出错：${errorMessage}`,
            // The session object is right here and still drivable → alive.
            sessionAlive: "alive",
            errorType: classifyError(errorMessage),
            progress: summarizeDelegatedProgress(session),
          });
        }
        return;
      }
      if (!summary) {
        const settled = failDispatch(dispatchId, "回合结束但没有产出可转述的结果", agentDir);
        if (settled) {
          void deliverDispatchCallback(factory, {
            agentDir,
            record: settled,
            kind: "error",
            summary: "回合结束但没有产出可转述的结果",
            sessionAlive: "alive",
            progress: summarizeDelegatedProgress(session),
          });
        }
        return;
      }
      const settled = settleDispatch(dispatchId, summary, "done", agentDir);
      if (settled) {
        void deliverDispatchCallback(factory, {
          agentDir,
          record: settled,
          kind: "done",
          summary: `（回合结束自动回调）${truncate(summary, 500)}`,
        });
      }
      return;
    }
    if (event.type === "agent_settled") {
      if (event.aborted !== true) return;
      finished = true;
      unsubscribe();
      dispatchedSessions.delete(dispatchId);
      const record = findDispatchById(dispatchId);
      // A user stop settles the record BEFORE aborting, so an already-stopped
      // record reaching here means the stop flow owns the callback.
      if (!record || record.status !== "dispatched" || !envelopeSeen) return;
      const settled = failDispatch(dispatchId, "被用户中断", agentDir);
      if (settled) {
        void deliverDispatchCallback(factory, {
          agentDir,
          record: settled,
          kind: "error",
          summary: "委派任务被用户中断。",
          sessionAlive: "stopped",
          errorType: "aborted",
        });
      }
    }
  });
}

/** Find a live AgentSession by id inside a bound graph (active → bg → idle). */
function findSessionByIdInGraph(graph: WorkspaceGraph, sessionId: string): AgentSession | null {
  if (graph.agentSession && graph.sessionSnapshot?.sessionId === sessionId) {
    return graph.agentSession;
  }
  const bg = graph.backgroundSessions.get(sessionId);
  if (bg) return bg.agentSession;
  for (const runtime of graph.idleSessionCache?.values() ?? []) {
    if (runtime.sessionId === sessionId) return runtime.agentSession;
  }
  return null;
}

/**
 * Dequeue the head queued dispatch for a session and inject it (A 到终态后
 * 自动出队)。The queue is engine-held: a queued record never touched the
 * session, so activation re-resolves the session from its graph (rebuilding
 * a parked graph if needed); an unreachable session fails the record.
 */
async function activateQueuedDispatch(
  factory: WorkspaceGraphFactory,
  dispatchId: string,
): Promise<void> {
  const agentDir = factory.deps.agentDir;
  const record = activateDispatch(dispatchId, agentDir);
  if (!record) return;
  const canonical = factory.canonicalizeCwd(record.cwd);
  let graph = factory.findBoundGraph(canonical);
  if (!graph && existsSync(canonical)) {
    const built = await factory.ensureBackgroundGraph(canonical);
    if (!("error" in built)) graph = built.graph;
  }
  const session = graph ? findSessionByIdInGraph(graph, record.sessionId ?? "") : null;
  if (!session || !record.sessionId) {
    const settled = failDispatch(
      dispatchId,
      "排队等待期间目标会话已不可达（工作区被关闭或会话已结束）",
      agentDir,
    );
    if (settled) {
      void deliverDispatchCallback(factory, {
        agentDir,
        record: settled,
        kind: "error",
        summary: "排队任务未能启动：目标会话已不可达",
        sessionAlive: "dead",
        errorType: "session_gone",
      });
    }
    return;
  }
  const prompt = buildDispatchTaskPrompt({ task: record.task, from: "小精灵委派（排队转正）" });
  dispatchedSessions.set(dispatchId, session);
  watchDispatchTurn(factory, session, dispatchId);
  // Deferred model/thinking override (queued dispatches apply at activation).
  if (record.model != null || record.thinkingLevel != null) {
    const applied = await applyDispatchModelOverride(factory, session, {
      model: record.model,
      thinkingLevel: record.thinkingLevel,
    });
    if (!applied.ok) {
      dispatchedSessions.delete(dispatchId);
      const settled = failDispatch(dispatchId, applied.error, agentDir);
      if (settled) {
        void deliverDispatchCallback(factory, {
          agentDir,
          record: settled,
          kind: "error",
          summary: applied.error,
          sessionAlive: "alive",
          errorType: "model_override",
        });
      }
      return;
    }
  }
  try {
    if (session.isStreaming) {
      session.followUp(prompt);
    } else {
      void session.prompt(prompt).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        dispatchedSessions.delete(dispatchId);
        const settled = failDispatch(dispatchId, `委派执行失败：${message}`, agentDir);
        if (settled) {
          void deliverDispatchCallback(factory, {
            agentDir,
            record: settled,
            kind: "error",
            summary: `委派执行失败：${message}`,
            sessionAlive: "alive",
            errorType: classifyError(message),
          });
        }
      });
    }
  } catch (error) {
    dispatchedSessions.delete(dispatchId);
    failDispatch(dispatchId, error instanceof Error ? error.message : String(error), agentDir);
  }
}

/** After a terminal settle, wake the next queued dispatch for that session. */
function drainQueueAfterSettle(factory: WorkspaceGraphFactory, sessionId: string | null): void {
  if (!sessionId) return;
  const head = queuedDispatchesFor(sessionId)[0];
  if (!head) return;
  void activateQueuedDispatch(factory, head.id);
}

/** 同请求重复提交的判定窗口（环回超时后模型原样重试的时间尺度）。 */
const PIXIE_DISPATCH_DEDUPE_MS = 30_000;
/** 在途受理的兜底上限：超过它认为上一次请求已经卡死，不再拦住同样的请求。 */
const PIXIE_DISPATCH_INFLIGHT_MAX_MS = 60_000;

/** 受理中（记录尚未落地）的同请求并发保护。 */
const inFlightDispatchRequests = new Map<string, number>();

/**
 * pixie_dispatch 的入口：先挡掉重复提交，再交给引擎受理。
 *
 * 插件侧环回超时不等于 Host 没受理——委派请求要先打开目标工作区的后台图，
 * 慢起来能到数秒。小精灵看到「委派失败」会原样重试，两次请求于是各开一个会话
 * 跑同一件事。受理已落记录的按记录去重（回原 dispatchId），还在受理中的按在途
 * 键挡住（明确告知不要重复派发）。`retryOf`（pixie_retry 的重派）是有意重跑，
 * 不受这两条约束。
 */
async function dispatchPixieTask(
  factory: WorkspaceGraphFactory,
  request: PixieDispatchRequest,
): Promise<PixieDispatchOutcome> {
  if (request.retryOf) return dispatchPixieTaskInner(factory, request);
  // 在途键用请求原文，不规范化 cwd：重试必然逐字相同，而规范化差异已由记录级去重覆盖。
  const key = `${request.cwd.trim()}\n${request.task}`;
  const pendingSince = inFlightDispatchRequests.get(key);
  if (pendingSince !== undefined && Date.now() - pendingSince <= PIXIE_DISPATCH_INFLIGHT_MAX_MS) {
    logger.warn("pixie dispatch rejected: same task still accepting", {
      cwd: request.cwd,
      pendingMs: Date.now() - pendingSince,
    });
    return {
      ok: false,
      error:
        "同一个任务正在受理中（上一条请求还没返回，可能正在后台打开目标工作区）。不要重复派发，稍后用 pixie_dispatch_status 查岗确认它是否已经在跑。",
    };
  }
  inFlightDispatchRequests.set(key, Date.now());
  try {
    return await dispatchPixieTaskInner(factory, request);
  } finally {
    inFlightDispatchRequests.delete(key);
  }
}

/**
 * 委派引擎的请求形状。比环回契约（parseDispatchBody 白名单）多出
 * retryOf/failCount：只有 Host 自身的重派路径能填，插件侧传不进来。
 */
export type PixieDispatchRequest = {
  cwd: string;
  task: string;
  newSession?: boolean;
  /**
   * 用户在对话中明确给出的会话 id：此时允许复用用户自己的会话。
   * 不传 = 自动落点（只挑小精灵自己创建的会话，挑不到就新建）。
   */
  sessionId?: string | null;
  batchId?: string | null;
  retryOf?: string | null;
  failCount?: number;
  /** 用户明确授权的模型/推理深度覆盖（未授权不传，跟随会话当前设置）。 */
  model?: string | null;
  thinkingLevel?: string | null;
};

type PixieDispatchOutcome =
  | {
      ok: true;
      dispatchId: string;
      sessionId: string;
      sessionPath: string;
      queued: boolean;
      /** true = 复用了既有会话；false = 新开了一个会话（回执必须能看出落点）。 */
      reused: boolean;
      /** queued=true 时的排队说明（告知小精灵可等待/取消/改并行）。 */
      queuedNote?: string;
    }
  | { ok: false; error: string };

/**
 * The delegation engine behind pixie_dispatch. The plugin-side tool shell
 * (my-pi-plugins pi-pixie) reaches it through the loopback control plane
 * (startPixieControlPlane); the engine itself stays Host-owned.
 */
async function dispatchPixieTaskInner(
  factory: WorkspaceGraphFactory,
  request: PixieDispatchRequest,
): Promise<PixieDispatchOutcome> {
  const agentDir = factory.deps.agentDir;
  const startedAt = Date.now();
  const canonicalCwd = factory.canonicalizeCwd(request.cwd);
  let graphMs = 0;
  let targetMs = 0;

  const accepted = (
    args: Omit<Extract<PixieDispatchOutcome, { ok: true }>, "ok">,
  ): PixieDispatchOutcome => {
    logger.info("pixie dispatch accepted", {
      dispatchId: args.dispatchId,
      cwd: canonicalCwd,
      sessionId: args.sessionId,
      queued: args.queued,
      reused: args.reused,
      graphMs,
      targetMs,
      totalMs: Date.now() - startedAt,
    });
    return { ok: true, ...args };
  };
  const rejected = (error: string): PixieDispatchOutcome => {
    logger.warn("pixie dispatch rejected", {
      cwd: canonicalCwd,
      error,
      totalMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  };

  // 重复提交：同工作区 + 逐字相同的任务文本已有活跃记录 → 认成同一次派发，
  // 回原 dispatchId，绝不再开一个会话把同一件事跑第二遍。
  if (!request.retryOf) {
    const duplicate = findDuplicateDispatchRequest({
      agentDir,
      cwd: canonicalCwd,
      task: request.task,
      withinMs: PIXIE_DISPATCH_DEDUPE_MS,
      now: startedAt,
    });
    if (duplicate) {
      logger.info("pixie dispatch deduplicated", {
        dispatchId: duplicate.id,
        cwd: canonicalCwd,
        status: duplicate.status,
        ageMs: startedAt - duplicate.createdAt,
      });
      return {
        ok: true,
        dispatchId: duplicate.id,
        sessionId: duplicate.sessionId ?? "",
        sessionPath: duplicate.sessionPath ?? "",
        queued: true,
        reused: true,
        queuedNote: `同一个任务在 ${Math.round((startedAt - duplicate.createdAt) / 1000)} 秒前已经受理（dispatchId: ${duplicate.id}，当前状态 ${duplicate.status}），本次没有重复派发。若认为上一条失败了，请对它用 pixie_retry；确实要再跑一遍请调整任务描述后重新派发。`,
      };
    }
  }

  let graph = factory.findBoundGraph(canonicalCwd);
  if (!graph) {
    // v4: a known workspace that exists on disk gets a BACKGROUND graph
    // (parked, never foregrounded) and delegation proceeds as usual.
    const buildStartedAt = Date.now();
    const known = getKnownWorkspaces(agentDir).some(
      (path) => factory.canonicalizeCwd(path) === canonicalCwd,
    );
    if (!known || !existsSync(canonicalCwd)) {
      return rejected(
        `目标工作区未打开且不在已知工作区列表中（${request.cwd}）。请用户先在 PiAbyss 中打开该工作区，或把它加入 PiAbyss 工作区列表后再委派。`,
      );
    }
    const built = await factory.ensureBackgroundGraph(canonicalCwd);
    if ("error" in built) {
      return rejected(
        `无法在后台打开目标工作区（${built.error.message}）。请用户先在 PiAbyss 中打开该工作区后再委派。`,
      );
    }
    graph = built.graph;
    graphMs = Date.now() - buildStartedAt;
  }

  // v4.3 会话归属：自动落点只允许复用「小精灵自己创建的会话」；用户自己在 UI 里
  // 创建的会话必须由用户在对话中明确给出 id（request.sessionId）才会被委托使用。
  const targetStartedAt = Date.now();
  const explicitSessionId = request.sessionId?.trim() || null;
  const resolution: TargetResolution | null = explicitSessionId
    ? resolveExplicitTargetSession(factory, graph, explicitSessionId)
    : request.newSession === true
      ? null
      : findTargetSession(factory, graph, agentDir);
  let session: AgentSession;
  let sessionId: string;
  let sessionPath: string;
  let busy: boolean;
  let reusedExisting = false;

  if (resolution?.ok) {
    session = resolution.session;
    sessionId = resolution.sessionId;
    sessionPath = resolution.sessionPath;
    busy = resolution.busy;
    reusedExisting = true;
    // 复用既有会话：刷新缓存（归属不翻转——显式指定用户的会话时登记为 user）。
    upsertPixieSession(agentDir, {
      sessionId,
      sessionPath,
      cwd: graph.canonicalCwd,
      owner: explicitSessionId ? "user" : "pixie",
      role: "delegated",
      summary: request.task,
      reused: true,
    });
  } else {
    if (explicitSessionId) {
      targetMs = Date.now() - targetStartedAt;
      return rejected(
        `指定的会话在目标工作区里找不到（sessionId: ${explicitSessionId}）。请确认会话 id 是否正确，或改用 newSession 新开一个会话。`,
      );
    }
    const created = await createTargetSession(factory, graph);
    targetMs = Date.now() - targetStartedAt;
    if (!created.ok) {
      return rejected(`无法在目标工作区创建会话：${created.error}`);
    }
    session = graph.backgroundSessions.get(created.sessionId)!.agentSession;
    sessionId = created.sessionId;
    sessionPath = created.sessionPath;
    busy = false;
    // 归属登记：新建的会话记在小精灵名下，此后可被自动复用。
    upsertPixieSession(agentDir, {
      sessionId,
      sessionPath,
      cwd: graph.canonicalCwd,
      owner: "pixie",
      role: "delegated",
      summary: request.task,
    });
  }
  targetMs = Date.now() - targetStartedAt;

  // v4.1 queue gate: an existing LIVE dispatch on this session holds it —
  // the new task is registered as queued (envelope NOT sent; the engine
  // injects it when the prior dispatch reaches a terminal state). Manual
  // user turns never hold the gate, so user-driven sessions stay open.
  const gate = liveDispatchFor(sessionId);
  if (gate) {
    const queuedAhead = queuedDispatchesFor(sessionId).length;
    const dispatch = registerDispatch({
      cwd: graph.canonicalCwd,
      sessionId,
      sessionPath,
      task: request.task,
      agentDir,
      batchId: request.batchId ?? null,
      retryOf: request.retryOf ?? null,
      failCount: request.failCount ?? 0,
      queued: true,
      model: request.model ?? null,
      thinkingLevel: request.thinkingLevel ?? null,
      originSessionId: currentPixieSessionId(agentDir),
    });
    recordPixieDispatch(agentDir);
    return accepted({
      dispatchId: dispatch.id,
      sessionId,
      sessionPath,
      queued: true,
      reused: reusedExisting,
      queuedNote:
        queuedAhead > 0
          ? `目标会话正有委派任务在执行（${gate.task.slice(0, 60)}…），本任务已排队（前面还有 ${queuedAhead} 个）。当前面的任务回调结束后自动开始；你也可以取消本任务改用 newSession 新开会话并行，或继续等待。`
          : `目标会话正有委派任务在执行（${gate.task.slice(0, 60)}…），本任务已排队，等它回调结束后自动开始。可继续等待、取消本任务、或改用 newSession 新开会话并行执行。`,
    });
  }

  const prompt = buildDispatchTaskPrompt({ task: request.task, from: "小精灵委派" });
  // Single registration (v3 double-registered via armPixieDispatch — the
  // ghost record stayed "dispatched" forever).
  const dispatch = registerDispatch({
    cwd: graph.canonicalCwd,
    sessionId,
    sessionPath,
    task: request.task,
    agentDir,
    batchId: request.batchId ?? null,
    retryOf: request.retryOf ?? null,
    failCount: request.failCount ?? 0,
    model: request.model ?? null,
    thinkingLevel: request.thinkingLevel ?? null,
    originSessionId: currentPixieSessionId(agentDir),
  });
  recordPixieDispatch(agentDir);
  dispatchedSessions.set(dispatch.id, session);
  watchDispatchTurn(factory, session, dispatch.id);

  // v4.2 authorized model/thinking override — applied BEFORE the envelope so
  // the dispatch turn itself already runs on the requested model (turn-boundary
  // semantics are irrelevant here: the session is idle in this branch).
  if (request.model != null || request.thinkingLevel != null) {
    const applied = await applyDispatchModelOverride(factory, session, {
      model: request.model ?? null,
      thinkingLevel: request.thinkingLevel ?? null,
    });
    if (!applied.ok) {
      dispatchedSessions.delete(dispatch.id);
      const settled = failDispatch(dispatch.id, applied.error, agentDir);
      if (settled) {
        void deliverDispatchCallback(factory, {
          agentDir,
          record: settled,
          kind: "error",
          summary: applied.error,
          sessionAlive: "alive",
          errorType: "model_override",
        });
      }
      return rejected(applied.error);
    }
  }

  // Drive the target session. Busy → followUp queue (SDK delivers after the
  // running turn); idle → direct prompt.
  if (busy) {
    try {
      session.followUp(prompt);
    } catch (error) {
      dispatchedSessions.delete(dispatch.id);
      failDispatch(dispatch.id, error instanceof Error ? error.message : String(error), agentDir);
      return rejected(`目标会话忙且队列不可用：${String(error)}`);
    }
    return accepted({
      dispatchId: dispatch.id,
      sessionId,
      sessionPath,
      queued: false,
      reused: reusedExisting,
    });
  }
  void session.prompt(prompt).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dispatchedSessions.delete(dispatch.id);
    const settled = failDispatch(dispatch.id, `委派执行失败：${message}`, agentDir);
    if (settled) {
      void deliverDispatchCallback(factory, {
        agentDir,
        record: settled,
        kind: "error",
        summary: `委派执行失败：${message}`,
        sessionAlive: "alive",
        errorType: classifyError(message),
      });
    }
  });
  return accepted({
    dispatchId: dispatch.id,
    sessionId,
    sessionPath,
    queued: false,
    reused: reusedExisting,
  });
}

/**
 * Route the user's answer to an awaiting ask back into the delegated session:
 * reactivate the record, followUp a `<pixie-reply>` envelope, and re-arm the
 * turn watcher so the continuation turn still auto-callbacks if the agent
 * forgets pixie_report.
 */
async function replyToDispatch(
  factory: WorkspaceGraphFactory,
  args: { dispatchId: string; text: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agentDir = factory.deps.agentDir;
  const outcome = reactivateDispatchAfterReply(args.dispatchId, args.text, agentDir);
  if ("error" in outcome) return { ok: false, error: outcome.error };
  const session = dispatchedSessions.get(args.dispatchId) ?? null;
  if (!session) {
    failDispatch(
      args.dispatchId,
      "目标会话已不可达（未打开或 Host 已重启），答复未能送达",
      agentDir,
    );
    return {
      ok: false,
      error: "目标会话当前不可达（请让小精灵重新委派，或在 PiAbyss 中打开该工作区）",
    };
  }
  const envelope = [
    `<pixie-reply dispatchId="${args.dispatchId}">`,
    "用户对上述问题的答复：",
    args.text,
    "请基于该答复继续执行；完成后再按原要求回调。",
    "</pixie-reply>",
  ].join("\n");
  watchDispatchTurn(factory, session, args.dispatchId);
  try {
    if (session.isStreaming) {
      void session.steer(envelope).catch(() => undefined);
    } else {
      session.followUp(envelope);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failDispatch(args.dispatchId, `答复送达失败：${message}`, agentDir);
    return { ok: false, error: `答复送达失败：${message}` };
  }
  return { ok: true };
}

/**
 * Interject into a LIVE delegation (插话 ≠ 新任务): append (补充/修正约束)
 * or checkpoint (要求进度汇报后继续/暂停). Only dispatched/awaiting_user
 * records accept interjections; queued/final ones reject with a clear hint.
 * Never creates a record — it rides the existing dispatch id.
 */
async function interjectDispatch(
  factory: WorkspaceGraphFactory,
  args: {
    dispatchId: string;
    text: string;
    mode: "append" | "checkpoint";
    after?: "continue" | "wait";
    /** 用户明确授权的模型/推理深度替换（下一轮起生效，同手动切换语义）。 */
    model?: string | null;
    thinkingLevel?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agentDir = factory.deps.agentDir;
  const record = findDispatchById(args.dispatchId);
  if (!record) return { ok: false, error: "委派记录不存在" };
  if (record.status === "queued") {
    return {
      ok: false,
      error: "该任务还在排队中（尚未开始执行），无法插话；可等待启动或取消后重派。",
    };
  }
  if (record.status === "paused") {
    // Checkpoint pause: any user interjection doubles as the resume signal.
    if (args.mode === "checkpoint") {
      return {
        ok: false,
        error: "该任务已在暂停等指令中，直接发送新指令即可（无需再要一次进度检查点）。",
      };
    }
    const session = dispatchedSessions.get(args.dispatchId) ?? null;
    if (!session) {
      return { ok: false, error: "目标会话当前不可达（Host 重启或工作区已关闭），无法恢复" };
    }
    const reactivated = resumePausedDispatch(args.dispatchId, agentDir);
    if (!reactivated) return { ok: false, error: "恢复失败：记录状态已变化" };
    const envelope = [
      "<pixie-interject>",
      "用户对暂停任务的下一步指令（恢复执行）：",
      args.text,
      "请基于该指令继续执行；完成后再按原要求回调。",
      "</pixie-interject>",
    ].join("\n");
    watchDispatchTurn(factory, session, args.dispatchId);
    try {
      if (session.isStreaming) {
        void session.steer(envelope).catch(() => undefined);
      } else {
        session.followUp(envelope);
      }
    } catch (error) {
      return {
        ok: false,
        error: `恢复指令送达失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true };
  }
  if (record.status !== "dispatched" && record.status !== "awaiting_user") {
    return {
      ok: false,
      error: `该任务已结束（${record.status}），无法插话。要继续做请重派新任务，要续跑失败任务可用 retryDispatch(mode=resume)。`,
    };
  }
  const session = dispatchedSessions.get(args.dispatchId) ?? null;
  if (!session) {
    return { ok: false, error: "目标会话当前不可达（Host 重启或工作区已关闭），插话未能送达" };
  }
  // Authorized model/thinking replacement: apply BEFORE injecting so the next
  // turn (triggered by this interjection) runs on the new model — the same
  // turn-boundary semantics as a manual switch in the workspace UI.
  if (args.model != null || args.thinkingLevel != null) {
    const applied = await applyDispatchModelOverride(factory, session, {
      model: args.model ?? null,
      thinkingLevel: args.thinkingLevel ?? null,
    });
    if (!applied.ok) return { ok: false, error: applied.error };
    recordDispatchModelChange(
      args.dispatchId,
      applied.model ?? findDispatchById(args.dispatchId)?.model ?? null,
      args.thinkingLevel ?? null,
      agentDir,
    );
  }
  const lines: string[] = ["<pixie-interject>"];
  if (args.mode === "checkpoint") {
    const after = args.after === "wait" ? "wait" : "continue";
    lines.push(
      "用户请求一次进度检查点：",
      args.text,
      "请立即调用 pixie_report（kind=progress）汇报当前进度（做了什么、到哪一步、还差什么），然后：",
      after === "continue"
        ? "汇报完成后继续执行原任务，不要停下。"
        : "汇报完成后暂停本轮（不要再继续执行），等待用户的下一步指令（会以 <pixie-interject> 或 <pixie-reply> 信封到达）。",
    );
  } else {
    lines.push("用户对当前任务的插入消息（补充/修正，不是新任务，原任务继续）：", args.text);
  }
  if (args.model != null) {
    lines.push(`（用户已授权模型替换：从下一轮起改用 ${args.model} 执行。）`);
  }
  if (args.thinkingLevel != null) {
    lines.push(`（用户已授权推理深度替换：下一轮起思考深度为 ${args.thinkingLevel}。）`);
  }
  lines.push("</pixie-interject>");
  const envelope = lines.join("\n");
  // Reply-style re-arm is unnecessary (the watcher stays armed across
  // checkpoints); just deliver.
  try {
    if (session.isStreaming) {
      void session.steer(envelope).catch(() => undefined);
    } else {
      session.followUp(envelope);
    }
  } catch (error) {
    return {
      ok: false,
      error: `插话送达失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true };
}

/**
 * Stop a delegation with an explicit receipt (叫停必须回执):
 * queued → cancelled (queue-only, session untouched); dispatched/paused/
 * awaiting_user with a live session → abort + stopped settle; otherwise
 * (Host restart / unreachable) → already-stopped settle. Idempotent with
 * the turn watcher's auto-settle: whoever settles first wins.
 */
async function stopDispatchById(
  factory: WorkspaceGraphFactory,
  dispatchId: string,
): Promise<{ ok: true; action: PixieStopAction } | { ok: false; error: string }> {
  const agentDir = factory.deps.agentDir;
  const record = findDispatchById(dispatchId);
  if (!record) return { ok: false, error: "委派记录不存在" };
  if (record.status === "queued") {
    const cancelled = cancelQueuedDispatch(dispatchId, agentDir);
    if (!cancelled) return { ok: true, action: "already-stopped" };
    void deliverDispatchCallback(factory, {
      agentDir,
      record: cancelled,
      kind: "stopped",
      summary: "排队中的任务已被用户取消（尚未开始执行）。",
    });
    return { ok: true, action: "cancelled" };
  }
  if (
    record.status !== "dispatched" &&
    record.status !== "paused" &&
    record.status !== "awaiting_user"
  ) {
    return { ok: true, action: "already-stopped" };
  }
  const session = dispatchedSessions.get(dispatchId) ?? null;
  // Settle FIRST: the turn watcher's aborted branch sees status "stopped"
  // and stays silent, so the stop receipt is the only callback.
  const stopped =
    stopSettleDispatch(dispatchId, agentDir) ?? findDispatchById(dispatchId) ?? record;
  if (!session) {
    void deliverDispatchCallback(factory, {
      agentDir,
      record: stopped,
      kind: "stopped",
      summary: "任务已标记停止（目标会话不在宿主内存中，无需中断执行）。",
    });
    return { ok: true, action: "already-stopped" };
  }
  void deliverDispatchCallback(factory, {
    agentDir,
    record: stopped,
    kind: "stopped",
    summary: "任务已被用户叫停，执行已中断。",
  });
  try {
    void session.abort().catch(() => undefined);
  } catch {
    /* the settle already happened; abort is best-effort */
  }
  return { ok: true, action: "aborted" };
}

/**
 * Retry a failed/stopped delegation (标准决策流的执行入口):
 * - resume: the delegated session is still in memory → reactivate the SAME
 *   record (context intact) and followUp a continue envelope;
 * - redispatch: session gone → a fresh record chained via retryOf;
 * - mode omitted → auto: resume when the session is reachable.
 */
async function retryDispatchById(
  factory: WorkspaceGraphFactory,
  args: { dispatchId: string; mode?: "resume" | "redispatch" },
): Promise<{ ok: true; dispatchId: string } | { ok: false; error: string }> {
  const agentDir = factory.deps.agentDir;
  const record = findDispatchById(args.dispatchId);
  if (!record) return { ok: false, error: "委派记录不存在" };
  if (record.status !== "failed" && record.status !== "stopped") {
    return { ok: false, error: `该任务当前状态为 ${record.status}，只有失败/被叫停的任务可以重试` };
  }
  const session = dispatchedSessions.get(args.dispatchId) ?? null;
  const mode = args.mode ?? (session ? "resume" : "redispatch");
  if (mode === "resume") {
    if (!session)
      return { ok: false, error: "目标会话已不可达，无法原地续跑；请改用 redispatch 重派" };
    const reactivated = reactivateDispatchForResume(args.dispatchId, agentDir);
    if (!reactivated) return { ok: false, error: "原地续跑失败：记录状态已变化" };
    const envelope = [
      `<pixie-resume dispatchId="${args.dispatchId}">`,
      "用户要求原地续跑之前的任务（第 " + reactivated.failCount + " 次尝试）：",
      record.task,
      "请从当前进度继续执行（不要重头开始）；完成后再按原要求回调。",
      "</pixie-resume>",
    ].join("\n");
    watchDispatchTurn(factory, session, args.dispatchId);
    try {
      if (session.isStreaming) {
        void session.steer(envelope).catch(() => undefined);
      } else {
        session.followUp(envelope);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failDispatch(args.dispatchId, `续跑注入失败：${message}`, agentDir);
      return { ok: false, error: `续跑注入失败：${message}` };
    }
    return { ok: true, dispatchId: args.dispatchId };
  }
  // redispatch: same cwd + task, fresh record chained to the failed one.
  const outcome = await dispatchPixieTask(factory, {
    cwd: record.cwd,
    task: record.task,
    retryOf: record.id,
    failCount: record.failCount,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return { ok: true, dispatchId: outcome.dispatchId };
}

/** SDK session-dir encoding for a cwd (mirrors SessionManager internals). */
function sessionDirFor(factory: WorkspaceGraphFactory, cwd: string): string {
  const resolved = factory
    .canonicalizeCwd(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  return join(factory.deps.agentDir, "sessions", `--${resolved}--`);
}

/** Read a session JSONL's head/tail lines for the history summary. */
function summarizeSessionFile(path: string): {
  createdAt: number;
  lastActiveAt: number;
  turns: number;
  summary: string;
} {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { createdAt: 0, lastActiveAt: 0, turns: 0, summary: "" };
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  let createdAt = 0;
  let lastActiveAt = 0;
  let turns = 0;
  let summary = "";
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    if (Number.isFinite(timestamp)) {
      if (createdAt === 0 || timestamp < createdAt) createdAt = timestamp;
      if (timestamp > lastActiveAt) lastActiveAt = timestamp;
    }
    if (parsed.type !== "message") continue;
    const message = parsed.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    turns += 1;
    if (message.role === "assistant") {
      const text = messageTextOf(message).trim();
      if (text) summary = truncate(text.replaceAll(/\s+/g, " "), 120);
    }
  }
  const stat = existsSync(path) ? undefined : undefined;
  void stat;
  return { createdAt, lastActiveAt, turns, summary };
}

/**
 * List historical sessions of a workspace (标准存储目录，找回旧会话继续派活).
 */
function listWorkspaceSessions(
  factory: WorkspaceGraphFactory,
  cwd: string,
): PixieWorkspaceSessionSummary[] {
  const dir = sessionDirFor(factory, cwd);
  if (!existsSync(dir)) return [];
  const out: PixieWorkspaceSessionSummary[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    const info = summarizeSessionFile(path);
    // Session id = file stem (SDK naming: <timestamp>-<uuid>.jsonl → stem).
    const id = entry.replace(/\.jsonl$/, "");
    if (!info.lastActiveAt) continue; // empty/hidden file
    out.push({
      id,
      path,
      createdAt: info.createdAt,
      lastActiveAt: info.lastActiveAt,
      turns: info.turns,
      summary: info.summary,
    });
  }
  out.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  return out.slice(0, 50);
}

/**
 * Control-plane callbacks wired to the delegation engine (the loopback server
 * in pixie-control-plane.ts exposes them to the pi-pixie plugin shell).
 */
export function createPixieControlPlaneDeps(factory: WorkspaceGraphFactory): PixieControlPlaneDeps {
  const agentDir = factory.deps.agentDir;
  // Queue drain: every terminal settle wakes the next queued dispatch.
  configurePixieTerminalSettleHook((sessionId) => drainQueueAfterSettle(factory, sessionId));
  return {
    dispatch: async (request) => dispatchPixieTask(factory, request),
    report: async (args) => {
      const kind = args.kind ?? (args.success === false ? "error" : "done");
      if (kind === "progress") {
        // 非终态进度汇报：记录进度，委派继续（或转 paused）。
        const updated = progressDispatch(
          args.dispatchId,
          args.summary,
          args.files ?? null,
          agentDir,
          args.pause === true,
        );
        if (!updated) return { ok: false, error: "委派记录不存在或已结束，进度汇报被忽略" };
        return deliverDispatchCallback(factory, {
          agentDir,
          record: updated,
          kind: "progress",
          summary: args.summary,
          files: args.files ?? null,
        });
      }
      const success = kind !== "error" && args.success !== false;
      const settled = success
        ? settleDispatch(args.dispatchId, args.summary, "done", agentDir)
        : failDispatch(args.dispatchId, args.summary, agentDir);
      if (!settled) return { ok: false, error: "委派记录不存在或已结束" };
      return deliverDispatchCallback(factory, {
        agentDir,
        record: settled,
        kind: success ? "done" : "error",
        summary: args.summary,
        files: args.files ?? null,
      });
    },
    ask: async (args) => {
      const record = askDispatch(args.dispatchId, args.question, args.options ?? [], agentDir);
      if (!record) return { ok: false, error: "委派记录不存在或已结束" };
      return deliverDispatchCallback(factory, {
        agentDir,
        record,
        kind: "ask",
        summary: args.question,
      });
    },
    interject: async (args) => {
      const out = await interjectDispatch(factory, {
        dispatchId: args.dispatchId,
        text: args.text,
        mode: args.mode,
        after: args.after,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
      });
      return out.ok ? { ok: true } : { ok: false, error: out.error };
    },
    stop: async (args) => stopDispatchById(factory, args.dispatchId),
    retry: async (args) => retryDispatchById(factory, args),
    dispatchList: (limit: number) => listDispatches(limit, agentDir),
    // v4.3 会话缓存：返回前先用委派记录刷新结果/进度（缓存文件始终是最新的交代）。
    sessionList: (cwd?: string) => {
      applyDispatchRecordsToSessionCache(agentDir, listDispatches(50, agentDir));
      return listPixieSessions(agentDir, cwd);
    },
    rest: async (args) =>
      requestPixieRest(factory, {
        agentDir,
        phrase: args.phrase,
        handoff: args.handoff,
        title: args.title,
      }),
    inject: async (args) =>
      injectPixieMessage(factory, {
        agentDir,
        text: args.text,
        source: args.source === "tg" ? "tg" : "system",
      }),
    dispatchState: (sessionId) => {
      const found = findDispatchBySession(sessionId);
      return found
        ? {
            armed: true,
            dispatchId: found.id,
            kind: found.status === "dispatched" ? null : found.kind,
          }
        : { armed: false, dispatchId: null, kind: null };
    },
  };
}

export function createPixieHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  const agentDir = factory.deps.agentDir;
  // The pixie page's delegation engine lives in the Host, but the feature is
  // owned by the pi-pixie plugin: gate every method on the plugin's user-level
  // enablement so the plugin-library switch controls both the agent-side
  // dispatch tools and this page. Checked per call — toggling in the plugin
  // library takes effect without a Host restart.
  const gate = (): boolean => isRepoPluginEnabled(agentDir, PIXIE_PLUGIN_ENTRY_FILE);
  return {
    "pixie.ensureCurrent": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      // 页面入口：确保小精灵工作区图与当前会话存在（含每日打盹懒判定），
      // 返回前端应当 workspace.setCurrent + session.open 的会话。
      const out = await ensurePixieCurrent(factory, agentDir);
      return out.ok
        ? { result: { cwd: out.cwd, sessionId: out.sessionId, sessionPath: out.sessionPath } }
        : { error: createHostError("RESOURCE_NOT_FOUND", out.error) };
    },

    "pixie.dispatches": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      // 面板语义：与「用户当前打开的会话」关联的全量委派（该会话发起的终态
      // 历史 + 跨会话仍在跑的活跃任务），不限条数。
      // 会话来源：前端把当前打开的会话 id 显式传上来（用户在会话弹窗里切换时
      // 立即跟随）；没传（如工具/脚本调用）才退回小精灵当前段的指针。
      const params = (ctx.params ?? {}) as { sessionId?: string | null };
      const scopedSessionId = params.sessionId?.trim() || currentPixieSessionId(agentDir);
      const dispatches: PixieDispatchRecord[] = listDispatchesForPanel(agentDir, scopedSessionId);
      return { result: { dispatches } };
    },

    "pixie.usage": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      return { result: readPixieUsage(agentDir) };
    },

    "pixie.reply": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { dispatchId: string; text: string };
      const out = await replyToDispatch(factory, params);
      if (!out.ok) return { error: createHostError("INVALID_REQUEST", out.error) };
      return { result: { ok: true } };
    },

    "pixie.setContext": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { workspaces: string[] };
      setPixieContext(agentDir, params.workspaces);
      return { result: { ok: true as const } };
    },

    "pixie.newSegment": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      await requestPixieSegment(factory, { agentDir });
      return { result: { ok: true as const } };
    },

    "pixie.interject": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as {
        dispatchId: string;
        text: string;
        mode: "append" | "checkpoint";
        after?: "continue" | "wait";
      };
      const out = await interjectDispatch(factory, params);
      return out.ok
        ? { result: { ok: true, error: null } }
        : { result: { ok: false, error: out.error } };
    },

    "pixie.stopDispatch": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { dispatchId: string };
      const out = await stopDispatchById(factory, params.dispatchId);
      if (!out.ok) return { error: createHostError("INVALID_REQUEST", out.error) };
      return { result: { ok: out.ok, action: out.action } };
    },

    "pixie.retryDispatch": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { dispatchId: string; mode?: "resume" | "redispatch" };
      const out = await retryDispatchById(factory, params);
      if (!out.ok) return { result: { ok: false, dispatchId: null, error: out.error } };
      return { result: { ok: true, dispatchId: out.dispatchId, error: null } };
    },

    "pixie.listSessions": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { cwd: string };
      return { result: { sessions: listWorkspaceSessions(factory, params.cwd) } };
    },
  };
}
