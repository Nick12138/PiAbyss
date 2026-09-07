import { resolve as pathResolve } from "node:path";
import type { AgentSession, ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
  type SessionRuntimeState,
  type WorkspaceSnapshot,
} from "@piabyss/protocol";
import type { PiHostServer } from "./server.js";
import { activateOnce } from "./extension-ui-lifecycle.js";
import { createExtensionCommandContextActions } from "./extension-command-actions.js";
import { SessionRuntimeCache, type ActiveSessionState } from "./session-runtime-cache.js";
import type { AgentOperationLock } from "./locks.js";
import { WorkspaceLifecycle, workspaceIdentityKey } from "./workspace-lifecycle.js";
export * from "./workspace-graph-types.js";
import {
  type BackgroundSessionRuntime,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-types.js";
import {
  archiveSession,
  cleanupArchivedSessions,
  createSession,
  deleteSession,
  listSessions,
  openSession,
  refineActiveSessionName,
  reloadSession,
  renameSession,
  restoreSession,
  setActiveSessionName,
} from "./session-lifecycle.js";

export class WorkspaceGraphFactory {
  /** @internal — session-lifecycle module */
  graph: WorkspaceGraph | null = null;
  /** @internal — session-lifecycle module */
  server: PiHostServer | null = null;
  readonly deps: GraphFactoryDeps;
  onModelHealthChanged?: () => void;
  /** Active run id for agent events */
  currentRunId: string | null = null;
  private readonly sessionRuntimeCache: SessionRuntimeCache;
  private readonly workspaceLifecycle: WorkspaceLifecycle;

  constructor(deps: GraphFactoryDeps) {
    this.deps = deps;
    this.sessionRuntimeCache = new SessionRuntimeCache({
      getGraph: () => this.graph,
      getServer: () => this.server,
      getCurrentRunId: () => this.currentRunId,
      sessionPathsEqual: (left, right) => this.sessionPathsEqual(left, right),
    });
    this.workspaceLifecycle = new WorkspaceLifecycle(
      {
        deps: this.deps,
        getGraph: () => this.graph,
        setGraph: (graph) => {
          this.graph = graph;
        },
        getServer: () => this.server,
        onModelHealthChanged: () => this.onModelHealthChanged?.(),
        getCommandContextActions: (session) => this.extensionCommandContextActions(session),
      },
      this.sessionRuntimeCache,
    );
  }

  /** ctx.newSession()/fork()/navigateTree()/switchSession()/reload() for one bound session. */
  extensionCommandContextActions(session: AgentSession): ExtensionCommandContextActions {
    return createExtensionCommandContextActions({ factory: this, session });
  }

  bindServer(server: PiHostServer): void {
    this.server = server;
  }

  getGraph(): WorkspaceGraph | null {
    return this.graph;
  }

  getServer(): PiHostServer | null {
    return this.server;
  }

  getSessionOperationLock(session: AgentSession): AgentOperationLock {
    return this.sessionRuntimeCache.getSessionOperationLock(session);
  }

  isSessionBusy(session: AgentSession): boolean {
    return this.sessionRuntimeCache.isSessionBusy(session);
  }

  beginQueueTransaction(session: AgentSession) {
    return this.sessionRuntimeCache.beginQueueTransaction(session);
  }

  finishQueueTransaction(session: AgentSession) {
    return this.sessionRuntimeCache.finishQueueTransaction(session);
  }

  syncQueueState(session: AgentSession, force = false) {
    return this.sessionRuntimeCache.syncQueueState(session, force);
  }

  setSessionRunId(session: AgentSession, runId: string): void {
    this.sessionRuntimeCache.setSessionRunId(session, runId);
  }

  clearSessionRunId(session: AgentSession): void {
    this.sessionRuntimeCache.clearSessionRunId(session);
  }

  publishCurrentRuntimeState(session: AgentSession, identity: HostIdentity): void {
    this.sessionRuntimeCache.publishCurrentRuntimeState(session, identity);
  }

  hasBusySessions(): boolean {
    return this.sessionRuntimeCache.hasBusySessions();
  }

  getSessionRuntimeInfo(
    sessionId: string,
    sessionPath: string,
  ): { runtimeState: SessionRuntimeState; sessionRevision: number } | null {
    return this.sessionRuntimeCache.getSessionRuntimeInfo(sessionId, sessionPath);
  }

  resolveSessionIdentity(sessionId: unknown, sessionRevision: unknown): HostIdentity | null {
    return this.sessionRuntimeCache.resolveSessionIdentity(sessionId, sessionRevision);
  }

  canonicalizeCwd(cwd: string): string {
    return this.workspaceLifecycle.canonicalizeCwd(cwd);
  }

  buildWorkspaceSnapshot(g: WorkspaceGraph): WorkspaceSnapshot {
    return this.workspaceLifecycle.buildWorkspaceSnapshot(g);
  }

  /**
   * Dispose agent session and optionally entire graph services.
   */
  async disposeAgentSession(g: WorkspaceGraph): Promise<void> {
    return this.sessionRuntimeCache.disposeAgentSession(g);
  }

  /**
   * Dispose a session instance without mutating graph slots (candidate discard/commit).
   * @internal — session-lifecycle module
   */
  async disposeAgentSessionOnly(session: AgentSession): Promise<void> {
    return this.sessionRuntimeCache.disposeAgentSessionOnly(session);
  }

  /** @internal — session-lifecycle module */
  retainBusySession(
    graph: WorkspaceGraph,
    previous: ActiveSessionState,
  ): BackgroundSessionRuntime | null {
    return this.sessionRuntimeCache.retainBusySession(graph, previous);
  }

  /** @internal — session-lifecycle module */
  retainSessionRuntime(
    graph: WorkspaceGraph,
    previous: ActiveSessionState,
  ): BackgroundSessionRuntime | null {
    return this.sessionRuntimeCache.retainSessionRuntime(graph, previous);
  }

  /** @internal — session-lifecycle module */
  touchIdleSession(graph: WorkspaceGraph, sessionId: string): void {
    this.sessionRuntimeCache.touchIdleSession(graph, sessionId);
  }

  /** @internal — agent-controller module */
  cacheSettledBackgroundRuntime(graph: WorkspaceGraph, runtime: BackgroundSessionRuntime): void {
    this.sessionRuntimeCache.cacheSettledBackgroundRuntime(graph, runtime);
  }

  /** @internal - session lifecycle file mutations */
  async disposeBackgroundSessionRuntimeIfIdle(
    graph: WorkspaceGraph,
    sessionId: string,
    sessionPath: string,
  ): Promise<"none" | "busy" | "disposed"> {
    return this.sessionRuntimeCache.disposeBackgroundSessionRuntimeIfIdle(
      graph,
      sessionId,
      sessionPath,
    );
  }

  /** @internal — session-lifecycle module */
  announceRetainedRuntime(runtime: BackgroundSessionRuntime): void {
    this.sessionRuntimeCache.announceRetainedRuntime(runtime);
  }

  /** @internal — session-lifecycle module */
  async promoteBackgroundRuntime(
    graph: WorkspaceGraph,
    runtime: BackgroundSessionRuntime,
  ): Promise<SessionSnapshot | { error: HostError }> {
    return this.sessionRuntimeCache.promoteBackgroundRuntime(graph, runtime);
  }

  async disposeGraph(g: WorkspaceGraph): Promise<void> {
    return this.workspaceLifecycle.disposeGraph(g);
  }

  /** Dispose every idle Workspace graph retained by the lifecycle owner. */
  async disposeRetainedGraphs(): Promise<void> {
    return this.workspaceLifecycle.disposeRetainedGraphs();
  }

  /** Dispose the idle Workspace graph that shares a Session storage namespace. */
  async invalidateRetainedWorkspaceGraph(canonicalCwd: string): Promise<void> {
    return this.workspaceLifecycle.invalidateRetainedWorkspaceGraph(canonicalCwd);
  }

  /** Drop every idle runtime that may have captured old settings or resources. */
  async invalidateRetainedRuntimeCaches(): Promise<void> {
    return this.workspaceLifecycle.invalidateRetainedRuntimeCaches();
  }

  /** @internal — session-lifecycle module */
  async activateExtensionUi(g: WorkspaceGraph): Promise<() => void> {
    return activateOnce(g);
  }

  /** Atomic Workspace switch facade. */
  async setCurrent(
    cwd: string,
    requestId: string,
  ): Promise<
    | {
        workspace: WorkspaceSnapshot;
        session?: SessionSnapshot;
      }
    | { error: HostError }
  > {
    return this.workspaceLifecycle.setCurrent(cwd, requestId);
  }

  /**
   * C1: resolve the graph currently bound for a cwd — the active graph or a
   * retained one. Identity matches the switch path (canonicalized cwd, case/
   * separator-insensitive on Windows). Canonicalization failure (missing or
   * non-directory path) resolves to null instead of throwing.
   */
  getGraphForCwd(cwd: string): WorkspaceGraph | null {
    let canonical: string;
    try {
      canonical = this.workspaceLifecycle.canonicalizeCwd(cwd);
    } catch {
      return null;
    }
    return this.workspaceLifecycle.getRetainedGraphByKey(workspaceIdentityKey(canonical));
  }

  /**
   * C1: canonical cwds of every workspace bound in this host — the active
   * workspace first, then retained ones in LRU order. Never throws.
   */
  boundWorkspaceCwds(): string[] {
    const cwds: string[] = [];
    for (const key of this.workspaceLifecycle.listBoundWorkspaceKeys()) {
      const graph = this.workspaceLifecycle.getRetainedGraphByKey(key);
      if (graph) cwds.push(graph.canonicalCwd);
    }
    return cwds;
  }

  /** @internal — session-lifecycle module */
  handleAgentEvent(graph: WorkspaceGraph, sourceSession: AgentSession, event: unknown): void {
    this.sessionRuntimeCache.handleAgentEvent(graph, sourceSession, event);
  }

  async listSessions() {
    return listSessions(this);
  }

  async archiveSession(requestId: string, sessionId: string, sessionPath: string) {
    return archiveSession(this, requestId, sessionId, sessionPath);
  }

  async restoreSession(requestId: string, sessionId: string, sessionPath: string) {
    return restoreSession(this, requestId, sessionId, sessionPath);
  }

  async deleteSession(requestId: string, sessionId: string, sessionPath: string) {
    return deleteSession(this, requestId, sessionId, sessionPath);
  }

  async cleanupArchivedSessions(requestId: string) {
    return cleanupArchivedSessions(this, requestId);
  }

  async renameSession(requestId: string, sessionId: string, sessionPath: string, name: string) {
    return renameSession(this, requestId, sessionId, sessionPath, name);
  }

  setActiveSessionName(name: string) {
    return setActiveSessionName(this, name);
  }

  async refineActiveSessionName(args: {
    session: AgentSession;
    sessionId: string;
    provisionalTitle: string;
    userPrompt: string;
  }) {
    return refineActiveSessionName(this, args);
  }

  /** @internal — session-lifecycle module */
  sessionPathsEqual(left: string | undefined, right: string): boolean {
    if (!left) return false;
    const resolvedLeft = pathResolve(left);
    const resolvedRight = pathResolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  }

  async createSession(requestId: string, name?: string) {
    return createSession(this, requestId, name);
  }

  async openSession(
    requestId: string,
    sessionPath: string,
    options: { forceReload?: boolean } = {},
  ) {
    return openSession(this, requestId, sessionPath, options);
  }

  async reloadSession(requestId: string) {
    return reloadSession(this, requestId);
  }

  checkIdentity(
    context: Record<string, unknown>,
    opts: {
      requireWorkspace?: boolean;
      requireSession?: boolean;
      allowNullSession?: boolean;
      requirePackage?: boolean;
      requireTool?: boolean;
    } = {},
  ): HostError | null {
    const server = this.server;
    if (!server) return createHostError("HOST_NOT_READY", "Host not ready");

    if (
      typeof context.expectedHostInstanceId === "string" &&
      context.expectedHostInstanceId !== server.identity.hostInstanceId
    ) {
      return createHostError("STALE_REVISION", "Host instance mismatch");
    }

    if (opts.requireWorkspace) {
      if (context.expectedWorkspaceId !== server.identity.workspaceId) {
        return createHostError("STALE_REVISION", "Workspace id mismatch");
      }
      if (context.expectedWorkspaceRevision !== server.identity.workspaceRevision) {
        return createHostError("STALE_REVISION", "Workspace revision mismatch");
      }
    }

    if (opts.requireSession || opts.allowNullSession) {
      if (context.expectedSessionId !== server.identity.sessionId) {
        return createHostError("STALE_REVISION", "Session id mismatch");
      }
      if (context.expectedSessionRevision !== server.identity.sessionRevision) {
        return createHostError("STALE_REVISION", "Session revision mismatch");
      }
    }

    if (opts.requirePackage) {
      if (context.expectedPackageRevision !== server.identity.packageRevision) {
        return createHostError("STALE_REVISION", "Package revision mismatch");
      }
    }

    if (opts.requireTool) {
      const g = this.graph;
      if (!g || context.expectedToolRevision !== g.toolRevision) {
        return createHostError("STALE_REVISION", "Tool revision mismatch");
      }
    }

    return null;
  }
}
