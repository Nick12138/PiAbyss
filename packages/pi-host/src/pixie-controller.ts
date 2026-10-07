/**
 * Pixie protocol handlers (`pixie.*` methods) + the delegation engine that
 * backs `pixie_dispatch`.
 *
 * The engine resolves a delegation target strictly through EXISTING workspace
 * graph state (active session → busy background runtimes → idle cache →
 * session list on disk), injecting the task prompt with the SDK's own queue
 * semantics: a busy session gets the task as a follow-up (processed after the
 * current turn settles — the user's real-time turns are never interrupted),
 * an idle/loaded session is prompted directly. Workspace graphs that are not
 * open are refused in V1 (the pixie answers with a hint instead of spinning
 * up workspaces behind the user's back).
 */
import { createHostError, type PixieDispatchRecord } from "@piabyss/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import type { MethodHandler } from "./server.js";
import {
  abortPixie,
  continuePixieSession,
  deliverReportToPixie,
  findDispatchBySession,
  listDispatches,
  pixieState,
  pixieTranscriptFrom,
  registerDispatch,
  sendPixieMessage,
} from "./pixie-agent-runner.js";
import { armPixieDispatch, failDispatch } from "./pixie-tool.js";
import type { PixieControlPlaneDeps } from "./pixie-control-plane.js";
import { recordPixieDispatch, recordPixieInteraction, readPixieUsage } from "./pixie-usage.js";
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
    "- 失败或部分完成时把 success 设为 false 并说明原因。",
    "如果本任务源自某条备忘录，先调用 piabyss_memo complete 回填该备忘录（提交结果总结），再调用 pixie_report。",
    "用户在会话中手动发送的指令优先级最高，与上述要求冲突时以用户指令为准。",
    "只有任务已产出最终结果、不再等待用户输入时才回填备忘录 complete；若需要用户决策（如让用户选择方案）或任务未完成，先回调 pixie_report 如实报告进度，等有结论再回填。",
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
 * Find the delegation target inside an already-open workspace:
 * the active session, then busy background runtimes, then the idle cache.
 * `skipSessionPath` forces a fresh session (pixie_dispatch's newSession).
 */
function findTargetSession(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  skipSessionPath?: string,
): TargetResolution {
  const active = graph.agentSession;
  const activeSnapshot = graph.sessionSnapshot;
  if (
    active &&
    activeSnapshot &&
    !factory.sessionPathsEqual(activeSnapshot.sessionPath, skipSessionPath ?? "")
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
    if (
      skipSessionPath &&
      factory.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, skipSessionPath)
    ) {
      continue;
    }
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
    if (
      skipSessionPath &&
      factory.sessionPathsEqual(runtime.sessionSnapshot.sessionPath, skipSessionPath)
    ) {
      continue;
    }
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

/**
 * The delegation engine behind pixie_dispatch. The plugin-side tool shell
 * (my-pi-plugins pi-pixie) reaches it through the loopback control plane
 * (startPixieControlPlane); the engine itself stays Host-owned.
 */
async function dispatchPixieTask(
  factory: WorkspaceGraphFactory,
  request: { cwd: string; task: string; newSession?: boolean },
): Promise<
  | { ok: true; dispatchId: string; sessionId: string; sessionPath: string; queued: boolean }
  | { ok: false; error: string }
> {
  const agentDir = factory.deps.agentDir;
  const graph = factory.findBoundGraph(factory.canonicalizeCwd(request.cwd));
  if (!graph) {
    return {
      ok: false,
      error: `目标工作区未打开（${request.cwd}）。请用户先在 PiAbyss 中打开该工作区后再委派。`,
    };
  }

  const resolution: TargetResolution | null =
    request.newSession === true ? null : findTargetSession(factory, graph);
  let session: AgentSession;
  let sessionId: string;
  let sessionPath: string;
  let busy: boolean;

  if (resolution?.ok) {
    session = resolution.session;
    sessionId = resolution.sessionId;
    sessionPath = resolution.sessionPath;
    busy = resolution.busy;
  } else {
    const created = await createTargetSession(factory, graph);
    if (!created.ok) {
      return { ok: false, error: `无法在目标工作区创建会话：${created.error}` };
    }
    session = graph.backgroundSessions.get(created.sessionId)!.agentSession;
    sessionId = created.sessionId;
    sessionPath = created.sessionPath;
    busy = false;
  }

  const prompt = buildDispatchTaskPrompt({ task: request.task, from: "小精灵委派" });
  const dispatch = registerDispatch({
    cwd: graph.canonicalCwd,
    sessionId,
    sessionPath,
    task: request.task,
  });
  recordPixieDispatch(agentDir);

  // Drive the target session. Busy → followUp queue (SDK delivers after the
  // running turn); idle → direct prompt. The dispatch record is armed for the
  // duration of the injected turn.
  if (busy) {
    try {
      session.followUp(prompt);
    } catch (error) {
      failDispatch(dispatch.id, error instanceof Error ? error.message : String(error));
      return { ok: false, error: `目标会话忙且队列不可用：${String(error)}` };
    }
    return { ok: true, dispatchId: dispatch.id, sessionId, sessionPath, queued: true };
  }
  void session.prompt(prompt).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    failDispatch(dispatch.id, `委派执行失败：${message}`);
  });
  return { ok: true, dispatchId: dispatch.id, sessionId, sessionPath, queued: false };
}

/**
 * Control-plane callbacks wired to the delegation engine (the loopback server
 * in pixie-control-plane.ts exposes them to the pi-pixie plugin shell). The
 * dispatch path mirrors the former createPixieDispatchToolFor exactly: engine
 * first, then the arm that flips the delegated session's report gating.
 */
export function createPixieControlPlaneDeps(factory: WorkspaceGraphFactory): PixieControlPlaneDeps {
  return {
    dispatch: async (request) => {
      const out = await dispatchPixieTask(factory, request);
      if (!out.ok) return { ok: false as const, error: out.error };
      const dispatchId = armPixieDispatch({
        cwd: request.cwd,
        sessionId: out.sessionId,
        sessionPath: out.sessionPath,
        task: request.task,
      });
      return {
        ok: true as const,
        dispatchId,
        sessionId: out.sessionId,
        sessionPath: out.sessionPath,
        queued: out.queued,
      };
    },
    report: (args) =>
      deliverReportToPixie({
        agentDir: factory.deps.agentDir,
        dispatchId: args.dispatchId,
        summary: args.summary,
      }),
    dispatchState: (sessionId) => {
      const found = findDispatchBySession(sessionId);
      return found ? { armed: true, dispatchId: found.id } : { armed: false, dispatchId: null };
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
    "pixie.state": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      return { result: pixieState() };
    },

    "pixie.send": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { text: string };
      // The resident session loads the pi-pixie extension from the installed
      // my-pi-plugins checkout (buildPixieSession); no customTools injection.
      const out = await sendPixieMessage({ agentDir, text: params.text });
      if (!out.ok) return { error: createHostError("AGENT_BUSY", out.error, { retryable: true }) };
      recordPixieInteraction(agentDir);
      return { result: { sessionId: out.sessionId } };
    },

    "pixie.continue": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { sessionPath: string; text: string };
      const out = await continuePixieSession({
        agentDir,
        sessionPath: params.sessionPath,
        text: params.text,
      });
      if (!out.ok) return { error: createHostError("RESOURCE_NOT_FOUND", out.error) };
      recordPixieInteraction(agentDir);
      return { result: { sessionId: out.sessionId, sessionPath: out.sessionPath } };
    },

    "pixie.abort": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      return { result: { ok: abortPixie() } };
    },

    "pixie.transcript": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = ctx.params as { sessionPath: string };
      const messages = pixieTranscriptFrom(params.sessionPath);
      return { result: { found: messages.length > 0, messages } };
    },

    "pixie.dispatches": async (ctx) => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      const params = (ctx.params ?? {}) as { limit?: number };
      const dispatches: PixieDispatchRecord[] = listDispatches(params.limit ?? 20);
      return { result: { dispatches } };
    },

    "pixie.usage": async () => {
      if (!gate()) return { error: pixiePluginDisabledError() };
      return { result: readPixieUsage(agentDir) };
    },
  };
}
