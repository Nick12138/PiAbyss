import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve as pathResolve, win32 } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";
import {
  createHostError,
  type HostError,
  type HostIdentity,
  type SessionSnapshot,
  type WorkspaceSnapshot,
  toJsonValue,
} from "@piabyss/protocol";
import { activateOnce, bindForCandidate, clearSlots } from "./extension-ui-lifecycle.js";
import type { ProviderOwnerToken } from "./extension-provider-ownership.js";
import { captureFilesystemFingerprint } from "./filesystem-fingerprint.js";
import { acquireWithAbort } from "./locks.js";
import { logger } from "./logger.js";
import type { GraphOperationHandle } from "./operation-lifecycle.js";
import { buildPackageSnapshot, type ResourceIdMap } from "./package-snapshot.js";
import { withoutImplicitPackageInstall } from "./offline-package-resolution.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { createReadAttachmentTool } from "./attachment-tool.js";
import type { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { PiHostServer } from "./server.js";
import type { GraphFactoryDeps, WorkspaceGraph } from "./workspace-graph-types.js";
import { createHostAgentSession } from "./agent-session-factory.js";
import { sessionStorageDirs } from "./session-storage.js";

export type WorkspaceLifecycleContext = {
  deps: GraphFactoryDeps;
  getGraph: () => WorkspaceGraph | null;
  setGraph: (graph: WorkspaceGraph | null) => void;
  getServer: () => PiHostServer | null;
  onModelHealthChanged: () => void;
  getCommandContextActions?: (session: AgentSession) => ExtensionCommandContextActions;
  platform?: NodeJS.Platform;
  /** Fired whenever the set/state of bound (active + parked) workspaces changed. */
  onBoundWorkspacesChanged?: () => void;
};

export function workspaceIdentityKey(
  canonicalCwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? win32.normalize(canonicalCwd).toLowerCase() : canonicalCwd;
}

/**
 * How long `workspace.setCurrent` queues behind an in-flight lock owner before
 * failing with SERVICE_GRAPH_BUSY. In shared-host mode the same lock also
 * serves every `sdk.read` (250ms/2s bounded waits), so a switch landing
 * mid-read used to fail instantly; reads finish fast, so wait them out.
 * Lock holders that are themselves long mutations (another setCurrent,
 * package.mutation, …) still exceed the window and fail fast as before.
 */
const WORKSPACE_SWITCH_LOCK_WAIT_MS = 2_000;

function workspaceCanonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return workspaceIdentityKey(left, platform) === workspaceIdentityKey(right, platform);
}

export class WorkspaceLifecycle {
  private static readonly MAX_RETAINED_GRAPHS = 5;
  private readonly retainedGraphs = new Map<string, WorkspaceGraph>();
  /** Graph currently being re-activated by a switch (bound, but in neither set). */
  private reactivatingGraph: WorkspaceGraph | null = null;
  /** Outgoing graph mid-switch (bound for event flow, not yet parked). */
  private parkingGraph: WorkspaceGraph | null = null;
  /**
   * Deferred fingerprint jobs (park-time capture / post-reactivation drift
   * verify), one per graph. The full-tree stat walk must never sit on the
   * switch critical path: it delays the response and can fail an
   * already-committed switch.
   */
  private fingerprintJobs = new Map<WorkspaceGraph, Promise<void>>();
  /** In-flight optimistic builds keyed by the switch requestId. */
  private optimisticBuilds = new Map<string, Promise<void>>();

  constructor(
    private readonly context: WorkspaceLifecycleContext,
    private readonly sessionRuntimeCache: SessionRuntimeCache,
  ) {}

  canonicalizeCwd(cwd: string): string {
    const resolved = pathResolve(cwd);
    if (!existsSync(resolved)) {
      throw createHostError("WORKSPACE_SWITCH_FAILED", `Directory does not exist: ${resolved}`, {
        retryable: false,
        details: { cwd: resolved },
      });
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolved);
    } catch (err) {
      throw createHostError(
        "WORKSPACE_SWITCH_FAILED",
        `Unable to resolve Workspace directory: ${resolved}`,
        {
          retryable: false,
          details: {
            cwd: resolved,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
    let isDirectory: boolean;
    try {
      isDirectory = lstatSync(canonical).isDirectory();
    } catch (err) {
      throw createHostError(
        "WORKSPACE_SWITCH_FAILED",
        `Unable to inspect Workspace directory: ${canonical}`,
        {
          retryable: false,
          details: {
            cwd: canonical,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }
    if (!isDirectory) {
      throw createHostError(
        "WORKSPACE_NOT_DIRECTORY",
        `Workspace path is not a directory: ${canonical}`,
        { retryable: false, details: { cwd: canonical } },
      );
    }
    return canonical;
  }

  buildWorkspaceSnapshot(graph: WorkspaceGraph): WorkspaceSnapshot {
    return {
      id: graph.workspaceId,
      cwd: graph.cwd,
      canonicalCwd: graph.canonicalCwd,
      revision: graph.revision,
      servicesReady: graph.servicesReady,
    };
  }

  private suspendGraphProviders(graph: WorkspaceGraph): void {
    if (!graph.providerOwner || graph.suspendedProviders !== undefined) return;
    graph.suspendedProviders = this.context.deps.providerOwnership.suspendOwner(
      graph.providerOwner,
    );
  }

  private resumeGraphProviders(graph: WorkspaceGraph): void {
    if (!graph.providerOwner || graph.suspendedProviders === undefined) return;
    this.context.deps.providerOwnership.resumeOwner(graph.providerOwner, graph.suspendedProviders);
    graph.suspendedProviders = undefined;
  }

  async disposeGraph(graph: WorkspaceGraph): Promise<void> {
    graph.backgroundRunning = false;
    graph.parkedIdentity = undefined;
    await this.sessionRuntimeCache.disposeGraphSessionRuntimes(graph);
    if (graph.providerOwner) {
      this.context.deps.providerOwnership.releaseOwner(graph.providerOwner);
      graph.providerOwner = null;
    }
    graph.suspendedProviders = undefined;
    graph.settingsManager = null;
    graph.packageManager = null;
    graph.resourceLoader = null;
    graph.extensionsResult = null;
    graph.packageSnapshot = null;
    graph.resourceIdMap.clear();
    graph.servicesReady = false;
  }

  async disposeRetainedGraphs(options?: { skipBusy?: boolean }): Promise<void> {
    const graphs = [...this.retainedGraphs.entries()];
    this.retainedGraphs.clear();
    for (const [key, graph] of graphs) {
      if (options?.skipBusy && graph.backgroundRunning) {
        // Parked graphs with live sessions must stay bound: they keep running
        // and emitting for their workspace.
        this.retainedGraphs.set(key, graph);
        continue;
      }
      await this.disposeGraph(graph);
    }
    if (graphs.length > 0) this.context.onBoundWorkspacesChanged?.();
  }

  async invalidateRetainedWorkspaceGraph(canonicalCwd: string): Promise<void> {
    const key = this.retainedGraphKey(canonicalCwd);
    const graph = this.retainedGraphs.get(key);
    if (!graph) return;
    this.retainedGraphs.delete(key);
    await this.disposeGraph(graph);
    this.context.onBoundWorkspacesChanged?.();
  }

  async invalidateRetainedRuntimeCaches(): Promise<void> {
    const activeGraph = this.context.getGraph();
    if (activeGraph) await this.sessionRuntimeCache.disposeIdleSessionRuntimes(activeGraph);
    // Parked graphs with live sessions stay bound — disposing them would
    // abort runs the user still expects to complete.
    await this.disposeRetainedGraphs({ skipBusy: true });
  }

  async setCurrent(
    cwd: string,
    requestId: string,
    options: { optimistic?: boolean } = {},
  ): Promise<{ workspace: WorkspaceSnapshot; session?: SessionSnapshot } | { error: HostError }> {
    const server = this.context.getServer();
    if (!server) {
      return { error: createHostError("HOST_NOT_READY", "Server not bound") };
    }
    let operation = server.graphOperations.begin({
      operationKind: "workspace.setCurrent",
      requestId,
      operationId: randomUUID(),
    });
    if (!operation) {
      // An in-flight optimistic switch holds the slot: supersede it so a
      // rapid second switch lands right after its unwind instead of failing
      // busy. The stale build is discarded; the newer target rebuilds.
      const active = server.graphOperations.getActive();
      if (active && active.operationKind === "workspace.setCurrent") {
        active.cancel("Superseded by a newer workspace switch");
        await active.completion;
        operation = server.graphOperations.begin({
          operationKind: "workspace.setCurrent",
          requestId,
          operationId: randomUUID(),
        });
      }
    }
    if (!operation) {
      return {
        error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
          retryable: true,
          details: {
            operationKind: server.graphOperations.getActive()?.operationKind ?? null,
          },
        }),
      };
    }

    let previousGraph: WorkspaceGraph | null = null;
    // The optimistic path hands the lock and the operation slot to the
    // background build; every other path releases them in the finally.
    let ownsLock = true;
    try {
      const lockState = await acquireWithAbort(
        server.serviceGraphLock,
        { operationKind: "workspace.setCurrent", requestId },
        WORKSPACE_SWITCH_LOCK_WAIT_MS,
        operation.signal,
      );
      if (lockState !== true) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph is busy", {
            retryable: true,
            details: {
              operationKind: server.serviceGraphLock.getOwner()?.operationKind ?? null,
              ...(lockState === false ? { waitedMs: WORKSPACE_SWITCH_LOCK_WAIT_MS } : {}),
            },
          }),
        };
      }
      operation.signal.throwIfAborted();

      let canonical: string;
      try {
        canonical = this.canonicalizeCwd(cwd);
      } catch (err) {
        const hostError = err as HostError;
        if (hostError && typeof hostError === "object" && "code" in hostError) {
          return { error: hostError };
        }
        return {
          error: createHostError("WORKSPACE_SWITCH_FAILED", String(err)),
        };
      }

      previousGraph = this.context.getGraph();
      // The outgoing graph is not in the retained set yet (retention happens
      // after the identity commit). Keep it recognizable as bound while the
      // switch is in flight so a busy graph's live sessions keep emitting —
      // otherwise an "idle" runtimeChanged landing inside this window would
      // be dropped and the pool's busy marker would leak forever.
      this.parkingGraph = previousGraph;
      const workspaceId = randomUUID();
      const revision = server.identity.workspaceRevision + 1;
      const invalidatedSessionRevision =
        server.identity.sessionRevision + (previousGraph?.agentSession ? 1 : 0);
      const candidateSessionRevision = invalidatedSessionRevision + 1;
      const candidatePackageRevision = server.identity.packageRevision + 1;

      const reactivated = await this.tryReactivateRetainedGraph({
        canonical,
        previousGraph,
        revision,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
        signal: operation.signal,
      });
      if (reactivated) return reactivated;

      // ---- Optimistic path: commit the pending shell now, build in the
      // background. Only user-initiated switches take it (the startup preload
      // stays blocking so host.ready never lands mid-build).
      if (options.optimistic) {
        // Retain (park) the outgoing graph first — fast now that the
        // fingerprint capture is deferred — so a rapid switch back is an
        // instant reactivation, then take the foreground with the shell.
        if (previousGraph) await this.retainGraph(previousGraph);
        const previousIdentity = server.getIdentity();
        if (previousIdentity.sessionId) {
          await this.context.deps.attachmentStore?.discardSessionDrafts(previousIdentity.sessionId);
        }

        const pendingGraph: WorkspaceGraph = {
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          servicesReady: false,
          settingsManager: null,
          packageManager: null,
          resourceLoader: null,
          sessionManager: null,
          agentSession: null,
          extensionsResult: null,
          packageSnapshot: null,
          sessionSnapshot: null,
          toolRevision: 0,
          resourceIdMap: new Map(),
          unsubscribeAgent: null,
          extensionUiActivate: null,
          extensionUiCleanup: null,
          extensionUiUpdateIdentity: null,
          extensionUiReplayState: null,
          resourceReloadRequired: false,
          idleSessionCache: new Map(),
          backgroundSessions: new Map(),
          providerOwner: null,
        };
        this.context.setGraph(pendingGraph);
        server.identity.workspaceId = workspaceId;
        server.identity.workspaceRevision = revision;
        server.identity.sessionId = null;
        server.identity.sessionRevision = candidateSessionRevision;
        server.identity.packageRevision = candidatePackageRevision;
        this.refreshAgentPhase();
        server.setLastError(undefined);
        const workspace = this.buildWorkspaceSnapshot(pendingGraph);
        server.emit("workspace.changed", workspace);
        this.context.onBoundWorkspacesChanged?.();
        this.parkingGraph = null;

        // Hand the lock and the operation slot to the background build.
        ownsLock = false;
        this.scheduleOptimisticBuild({
          requestId,
          pendingGraph,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          sessionRevision: candidateSessionRevision,
          packageRevision: candidatePackageRevision,
          operation,
        });
        return { workspace };
      }

      // Suspending a busy graph's providers would break its in-flight model
      // calls during the build window. Skip the pre-merge suspension there:
      // the retention park branch keeps those providers registered anyway.
      if (previousGraph && !this.graphIsBusy(previousGraph)) {
        this.suspendGraphProviders(previousGraph);
      }
      const built = await this.buildServices({
        workspaceId,
        cwd,
        canonicalCwd: canonical,
        revision,
        sessionRevision: candidateSessionRevision,
        packageRevision: candidatePackageRevision,
      });
      if (operation.signal.aborted) {
        if ("graph" in built) await this.disposeGraph(built.graph);
        operation.signal.throwIfAborted();
      }
      if ("error" in built) {
        await this.commitWorkspaceFailure({
          previousGraph,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error: built.error,
          signal: operation.signal,
        });
        return { error: built.error };
      }

      const previousIdentity = server.getIdentity();
      this.context.setGraph(built.graph);
      server.identity.workspaceId = workspaceId;
      server.identity.workspaceRevision = revision;
      server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
      server.identity.sessionRevision = candidateSessionRevision;
      server.identity.packageRevision = candidatePackageRevision;

      let publishExtensionUi = () => {};
      try {
        publishExtensionUi = await activateOnce(built.graph);
      } catch (err) {
        const error = createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Extension bind failed",
        );
        await this.disposeGraph(built.graph);
        if (previousGraph) {
          this.context.setGraph(previousGraph);
          this.restoreIdentity(server, previousIdentity);
          this.resumeGraphProviders(previousGraph);
          this.refreshAgentPhase();
          server.setLastError(undefined);
          return { error };
        }
        await this.commitWorkspaceFailure({
          previousGraph: null,
          workspaceId,
          cwd,
          canonicalCwd: canonical,
          revision,
          sessionRevision: invalidatedSessionRevision,
          packageRevision: candidatePackageRevision,
          error,
        });
        return { error };
      }

      if (previousGraph) await this.retainGraph(previousGraph);
      if (previousIdentity.sessionId && previousIdentity.sessionId !== server.identity.sessionId) {
        await this.context.deps.attachmentStore?.discardSessionDrafts(previousIdentity.sessionId);
      }
      this.refreshAgentPhase();
      server.setLastError(undefined);
      const workspace = this.buildWorkspaceSnapshot(built.graph);
      this.publishWorkspaceSnapshots(server, built.graph, workspace);
      built.graph.subagentStatusBridge?.setIdentity(server.getIdentity());
      built.graph.subagentStatusBridge?.markReady();
      publishExtensionUi();
      this.context.onBoundWorkspacesChanged?.();
      return {
        workspace,
        ...(built.graph.sessionSnapshot ? { session: built.graph.sessionSnapshot } : {}),
      };
    } catch (err) {
      if (previousGraph && this.context.getGraph() === previousGraph) {
        this.resumeGraphProviders(previousGraph);
      }
      return {
        error: createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Workspace switch cancelled",
          { retryable: operation.signal.aborted },
        ),
      };
    } finally {
      this.parkingGraph = null;
      if (ownsLock) {
        server.serviceGraphLock.release(requestId);
        operation.finish();
      }
    }
  }

  /** Test seam: await every in-flight optimistic workspace build. */
  async flushOptimisticBuilds(): Promise<void> {
    while (this.optimisticBuilds.size > 0) {
      await Promise.all([...this.optimisticBuilds.values()]);
    }
  }

  /**
   * Background continuation of an optimistic switch: builds the full service
   * graph for the committed pending shell. Owns the serviceGraphLock and the
   * operation slot until it settles; a superseding switch cancels this
   * operation and awaits this promise before taking over. The outgoing graph
   * was already retained at shell-commit time, so an abort just discards the
   * candidate — the pending shell stays until the newer switch replaces it.
   */
  private scheduleOptimisticBuild(args: {
    requestId: string;
    pendingGraph: WorkspaceGraph;
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
    operation: GraphOperationHandle;
  }): void {
    const server = this.context.getServer();
    if (!server) return;
    if (this.optimisticBuilds.has(args.requestId)) return;
    const build = (async () => {
      const { operation } = args;
      const startedAt = Date.now();
      try {
        const built = await this.buildServices({
          workspaceId: args.workspaceId,
          cwd: args.cwd,
          canonicalCwd: args.canonicalCwd,
          revision: args.revision,
          sessionRevision: args.sessionRevision,
          packageRevision: args.packageRevision,
        });
        if (operation.signal.aborted) {
          if ("graph" in built) await this.disposeGraph(built.graph);
          operation.signal.throwIfAborted();
        }
        if ("error" in built) {
          await this.commitWorkspaceFailure({
            previousGraph: null,
            workspaceId: args.workspaceId,
            cwd: args.cwd,
            canonicalCwd: args.canonicalCwd,
            revision: args.revision,
            sessionRevision: args.sessionRevision,
            packageRevision: args.packageRevision,
            error: built.error,
          });
          return;
        }
        this.context.setGraph(built.graph);
        server.identity.sessionId = built.graph.sessionSnapshot?.sessionId ?? null;
        server.identity.sessionRevision = args.sessionRevision;
        let publishExtensionUi = () => {};
        try {
          publishExtensionUi = await activateOnce(built.graph);
        } catch (err) {
          const error = createHostError(
            "WORKSPACE_SWITCH_FAILED",
            err instanceof Error ? err.message : "Extension bind failed",
          );
          await this.disposeGraph(built.graph);
          await this.commitWorkspaceFailure({
            previousGraph: null,
            workspaceId: args.workspaceId,
            cwd: args.cwd,
            canonicalCwd: args.canonicalCwd,
            revision: args.revision,
            sessionRevision: args.sessionRevision,
            packageRevision: args.packageRevision,
            error,
          });
          return;
        }
        this.refreshAgentPhase();
        server.setLastError(undefined);
        const workspace = this.buildWorkspaceSnapshot(built.graph);
        this.publishWorkspaceSnapshots(server, built.graph, workspace);
        built.graph.subagentStatusBridge?.setIdentity(server.getIdentity());
        built.graph.subagentStatusBridge?.markReady();
        publishExtensionUi();
        this.context.onBoundWorkspacesChanged?.();
        logger.info("workspace graph built (optimistic)", {
          cwd: args.canonicalCwd,
          totalMs: Date.now() - startedAt,
        });
      } catch (err) {
        if (operation.signal.aborted) {
          // Superseded: the newer switch owns the graph state now. Nothing to
          // restore — the shell stays until the newer switch replaces it.
          logger.info("optimistic workspace build superseded", {
            cwd: args.canonicalCwd,
          });
          return;
        }
        logger.error("optimistic workspace build crashed", {
          cwd: args.canonicalCwd,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.commitWorkspaceFailure({
          previousGraph: null,
          workspaceId: args.workspaceId,
          cwd: args.cwd,
          canonicalCwd: args.canonicalCwd,
          revision: args.revision,
          sessionRevision: args.sessionRevision,
          packageRevision: args.packageRevision,
          error: createHostError(
            "WORKSPACE_SWITCH_FAILED",
            err instanceof Error ? err.message : "Optimistic workspace build failed",
          ),
        });
      } finally {
        server.serviceGraphLock.release(args.requestId);
        operation.finish();
        this.optimisticBuilds.delete(args.requestId);
      }
    })();
    this.optimisticBuilds.set(args.requestId, build);
  }

  private retainedGraphKey(canonicalCwd: string): string {
    return workspaceIdentityKey(canonicalCwd, this.context.platform);
  }

  private async retainedGraphFingerprint(
    graph: WorkspaceGraph,
    signal?: AbortSignal,
  ): Promise<string> {
    const roots = new Set<string>([
      join(graph.canonicalCwd, ".pi"),
      join(this.context.deps.agentDir, "settings.json"),
      join(this.context.deps.agentDir, "models.json"),
      join(this.context.deps.agentDir, "models-store.json"),
      join(this.context.deps.agentDir, "auth.json"),
    ]);
    for (const directory of ["packages", "npm", "git"]) {
      roots.add(join(this.context.deps.agentDir, directory));
    }
    const markers: string[] = [];
    if (graph.packageManager) {
      try {
        for (const item of graph.packageManager.listConfiguredPackages()) {
          const installedPath =
            item.installedPath ?? graph.packageManager.getInstalledPath(item.source, item.scope);
          if (installedPath) roots.add(installedPath);
        }
      } catch {
        markers.push("configured:error");
      }
    } else {
      markers.push("packageManager:null");
    }
    return captureFilesystemFingerprint({ roots, markers, signal });
  }

  /** Test seam: await every in-flight deferred fingerprint job. */
  async flushFingerprintJobs(): Promise<void> {
    while (this.fingerprintJobs.size > 0) {
      await Promise.all([...this.fingerprintJobs.values()]);
    }
  }

  /**
   * Schedule deferred fingerprint work off the switch critical path: baseline
   * capture at park time, or drift verification right after a reactivation
   * (compareAgainst set). One job per graph at a time; a capture still in
   * flight makes reactivation assume unchanged instead of waiting on it.
   */
  private scheduleFingerprintCapture(graph: WorkspaceGraph, compareAgainst?: string): void {
    if (this.fingerprintJobs.has(graph)) return;
    const job = (async () => {
      const startedAt = Date.now();
      try {
        const current = await this.retainedGraphFingerprint(graph);
        if (compareAgainst !== undefined && current !== compareAgainst) {
          logger.info("workspace graph changed on disk while away", {
            cwd: graph.canonicalCwd,
            fingerprintMs: Date.now() - startedAt,
          });
          await this.handleDeferredFingerprintDrift(graph);
          return;
        }
        graph.retainedFingerprint = current;
        logger.info("workspace graph retention fingerprint captured", {
          cwd: graph.canonicalCwd,
          fingerprintMs: Date.now() - startedAt,
          deferred: true,
        });
      } catch (error) {
        // A capture failure must never fail a (possibly committed) switch:
        // leave the graph fingerprint-less so reactivation falls back to the
        // rebuild (idle) or reuse (parked) branch.
        graph.retainedFingerprint = undefined;
        logger.warn("workspace graph retention fingerprint capture failed", {
          cwd: graph.canonicalCwd,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // The has(graph) guard keeps one job per graph, so this is always
        // the job that was registered for it.
        this.fingerprintJobs.delete(graph);
      }
    })();
    this.fingerprintJobs.set(graph, job);
  }

  /**
   * Drift found by deferred verification. The old switch-time compare would
   * have rebuilt instead of reactivating; in the background the graph is
   * already bound, so the closest safe action is: dispose a parked idle graph
   * now (next switch-in rebuilds fresh), keep busy parked graphs (their live
   * sessions must never be aborted) and the active graph (in-memory resources
   * stay in use; the stale marker forces a rebuild on its next park).
   */
  private async handleDeferredFingerprintDrift(graph: WorkspaceGraph): Promise<void> {
    if (this.context.getGraph() === graph) {
      graph.staleOnDisk = true;
      logger.warn("Active workspace changed on disk; rebuilding on next park", {
        cwd: graph.canonicalCwd,
      });
      return;
    }
    if (!this.isBoundGraph(graph)) return;
    if (this.graphIsBusy(graph)) {
      logger.warn("Parked busy workspace changed on disk; reusing graph", {
        cwd: graph.canonicalCwd,
      });
      return;
    }
    logger.info("Parked idle workspace changed on disk; disposing for fresh rebuild", {
      cwd: graph.canonicalCwd,
    });
    this.retainedGraphs.delete(this.retainedGraphKey(graph.canonicalCwd));
    await this.disposeGraph(graph);
    this.context.onBoundWorkspacesChanged?.();
  }

  private graphIsBusy(graph: WorkspaceGraph): boolean {
    return (
      (graph.agentSession !== null && this.sessionRuntimeCache.isSessionBusy(graph.agentSession)) ||
      graph.backgroundSessions.size > 0
    );
  }

  /**
   * The Host-level phase is a whole-Host property: `agentBusy` while ANY bound
   * graph (active or parked) still has live sessions, `ready` otherwise. The
   * check deliberately runs against the post-switch bound set (retention has
   * already parked the outgoing graph), and non-agent phases (packageBusy,
   * workspaceError, …) are never touched here — they carry their own meaning.
   */
  private refreshAgentPhase(): void {
    const server = this.context.getServer();
    if (!server) return;
    server.setPhase(this.hasAnyBoundBusySessions() ? "agentBusy" : "ready");
  }

  /** True when the active graph or any parked retained graph has live sessions. */
  private hasAnyBoundBusySessions(): boolean {
    return (
      this.sessionRuntimeCache.hasBusySessions() ||
      this.hasBusyRetainedGraphs() ||
      (this.parkingGraph ? this.graphIsBusy(this.parkingGraph) : false) ||
      (this.reactivatingGraph ? this.graphIsBusy(this.reactivatingGraph) : false)
    );
  }

  /**
   * Identity captured at park time, entirely from the graph's own fields —
   * never from server.getIdentity(), which by now points at the incoming
   * workspace.
   */
  private captureParkedIdentity(graph: WorkspaceGraph): HostIdentity {
    const sessionId = graph.sessionSnapshot?.sessionId ?? graph.agentSession?.sessionId ?? null;
    return {
      hostInstanceId: this.context.getServer()?.identity.hostInstanceId ?? "",
      workspaceId: graph.workspaceId,
      workspaceRevision: graph.revision,
      sessionId,
      sessionRevision: graph.sessionSnapshot?.revision ?? 0,
      packageRevision: graph.packageSnapshot?.revision ?? 0,
    };
  }

  private async retainGraph(graph: WorkspaceGraph): Promise<void> {
    if (graph.staleOnDisk && !this.graphIsBusy(graph)) {
      // Deferred verification found on-disk drift while this graph was bound:
      // an idle graph is rebuilt on next switch-in instead of being parked.
      graph.staleOnDisk = undefined;
      logger.info("Retained workspace changed on disk; rebuilding", {
        cwd: graph.canonicalCwd,
      });
      await this.disposeGraph(graph);
      return;
    }
    // Same-workspace Session cache is deliberately in-memory only. Releasing
    // it here lets the workspace graph retain its established fingerprint and
    // provider lifecycle without carrying arbitrary conversation runtimes.
    await this.sessionRuntimeCache.disposeIdleSessionRuntimes(graph);
    if (!graph.servicesReady || !graph.agentSession) {
      await this.disposeGraph(graph);
      return;
    }
    if (this.graphIsBusy(graph)) {
      // Park: keep the busy graph fully alive in the background. Its sessions
      // keep running and emitting under the graph's own identity, so the
      // agent subscription, provider registration and Extension UI binding
      // must all survive retention untouched.
      graph.backgroundRunning = true;
      graph.parkedIdentity = this.captureParkedIdentity(graph);
      // The switch path suspended this owner before building the incoming
      // graph (to avoid same-id provider merges). A parked graph keeps its
      // providers registered, so undo that pre-merge suspension.
      this.resumeGraphProviders(graph);
    } else {
      graph.backgroundRunning = false;
      graph.parkedIdentity = undefined;
      graph.unsubscribeAgent?.();
      graph.unsubscribeAgent = null;
      graph.extensionUiActivate = null;
      try {
        graph.extensionUiCleanup?.();
      } catch {
        /* ignore */
      }
      graph.extensionUiCleanup = null;
      graph.extensionUiUpdateIdentity = null;
      graph.extensionUiReplayState = null;
      // The switch path may already have parked this owner before building the
      // incoming graph. Preserve that pre-merge snapshot when retention finishes.
      this.suspendGraphProviders(graph);
    }
    // The full-tree stat walk runs off the switch critical path (it must not
    // delay the response or fail an already-committed switch). Until it lands
    // the graph counts as fingerprint-pending: reactivation assumes unchanged.
    this.scheduleFingerprintCapture(graph);

    const key = this.retainedGraphKey(graph.canonicalCwd);
    const existing = this.retainedGraphs.get(key);
    this.retainedGraphs.delete(key);
    if (existing && existing !== graph) await this.disposeGraph(existing);
    this.retainedGraphs.set(key, graph);
    this.context.onBoundWorkspacesChanged?.();
    const maxRetained =
      this.context.deps.maxBoundWorkspaces ?? WorkspaceLifecycle.MAX_RETAINED_GRAPHS;
    while (this.retainedGraphs.size > maxRetained) {
      // Busy parked graphs are never evicted, and neither is the graph this
      // very switch just retained. When only such graphs remain, temporarily
      // exceed the bound rather than abort runs or drop the freshest return
      // target.
      let evictableKey: string | undefined;
      for (const candidateKey of this.retainedGraphs.keys()) {
        if (candidateKey === key && maxRetained > 0) continue;
        if (!this.retainedGraphs.get(candidateKey)?.backgroundRunning) {
          evictableKey = candidateKey;
          break;
        }
      }
      if (evictableKey === undefined) break;
      const evicted = this.retainedGraphs.get(evictableKey);
      this.retainedGraphs.delete(evictableKey);
      if (evicted) await this.disposeGraph(evicted);
      this.context.onBoundWorkspacesChanged?.();
    }
  }

  /** True when the graph is bound to this Host: active, parked, or mid-switch. */
  isBoundGraph(graph: WorkspaceGraph): boolean {
    return (
      this.context.getGraph() === graph ||
      this.reactivatingGraph === graph ||
      this.parkingGraph === graph ||
      [...this.retainedGraphs.values()].includes(graph)
    );
  }

  /** True when (workspaceId, revision) identifies a bound, service-ready graph. */
  isBoundWorkspaceIdentity(workspaceId: string, revision: number): boolean {
    const active = this.context.getGraph();
    const candidates = [
      ...(active ? [active] : []),
      ...this.retainedGraphs.values(),
      ...(this.reactivatingGraph ? [this.reactivatingGraph] : []),
      ...(this.parkingGraph ? [this.parkingGraph] : []),
    ];
    return candidates.some(
      (graph) =>
        graph.servicesReady && graph.workspaceId === workspaceId && graph.revision === revision,
    );
  }

  /** True when any parked retained graph still has live sessions. */
  hasBusyRetainedGraphs(): boolean {
    for (const graph of this.retainedGraphs.values()) {
      if (this.graphIsBusy(graph)) return true;
    }
    return false;
  }

  /** All bound graphs: active first, then retained in insertion (LRU) order. */
  boundGraphs(): WorkspaceGraph[] {
    const active = this.context.getGraph();
    const retained = [...this.retainedGraphs.values()];
    return active ? [active, ...retained] : retained;
  }

  // NOTE: `parkingGraph` is deliberately excluded from boundGraphs() — status
  // projection lists settled bindings only; the transient mid-switch graph is
  // covered by isBoundWorkspaceIdentity for the event emit check.

  private takeRetainedGraph(canonicalCwd: string): WorkspaceGraph | null {
    const key = this.retainedGraphKey(canonicalCwd);
    const graph = this.retainedGraphs.get(key) ?? null;
    if (
      graph &&
      !workspaceCanonicalPathsEqual(graph.canonicalCwd, canonicalCwd, this.context.platform)
    ) {
      logger.warn("Retained Workspace identity mismatch", {
        requestedCwd: canonicalCwd,
        retainedCwd: graph.canonicalCwd,
      });
      return null;
    }
    this.retainedGraphs.delete(key);
    return graph;
  }

  private async tryReactivateRetainedGraph(args: {
    canonical: string;
    previousGraph: WorkspaceGraph | null;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
    signal?: AbortSignal;
  }): Promise<{ workspace: WorkspaceSnapshot; session?: SessionSnapshot } | null> {
    const server = this.context.getServer();
    if (!server) return null;
    const graph = this.takeRetainedGraph(args.canonical);
    if (!graph) return null;
    // The graph has left the retained set and is not active yet. Keep it
    // recognizable as bound while the switch is in flight so events from its
    // parked sessions keep flowing (and passing the bound-identity emit
    // check) instead of being dropped or rejected mid-reactivation.
    this.reactivatingGraph = graph;
    try {
      return await this.commitReactivateRetainedGraph(graph, args);
    } finally {
      if (this.reactivatingGraph === graph) this.reactivatingGraph = null;
    }
  }

  private async commitReactivateRetainedGraph(
    graph: WorkspaceGraph,
    args: {
      canonical: string;
      previousGraph: WorkspaceGraph | null;
      revision: number;
      sessionRevision: number;
      packageRevision: number;
      signal?: AbortSignal;
    },
  ): Promise<{ workspace: WorkspaceSnapshot; session?: SessionSnapshot } | null> {
    const server = this.context.getServer()!;

    const startedAt = Date.now();
    const stepTimings: Record<string, number> = {};
    let lastStepAt = startedAt;
    const markStep = (name: string) => {
      const now = Date.now();
      stepTimings[name] = now - lastStepAt;
      lastStepAt = now;
    };

    const retainedFingerprint = graph.retainedFingerprint;
    graph.retainedFingerprint = undefined;
    // The on-disk compare moved off the critical path (deferred verification
    // after commit). A capture still in flight from park time counts as
    // "assume unchanged": only a switch landing inside that tiny window could
    // miss drift, and the deferred verification still reports it.
    const capturePending = this.fingerprintJobs.has(graph);
    if (!retainedFingerprint && !capturePending) {
      if (graph.backgroundRunning) {
        // A parked graph may have lost its fingerprint (e.g. an invalidation
        // pass). Rebuilding would abort its live background sessions, so
        // reuse the graph as-is and let the next retention capture a fresh
        // fingerprint.
        logger.warn("Parked workspace has no retained fingerprint; reusing graph", {
          cwd: args.canonical,
        });
      } else {
        logger.info("Retained workspace changed on disk; rebuilding", {
          cwd: args.canonical,
        });
        await this.disposeGraph(graph);
        return null;
      }
    }
    markStep("fingerprint");
    if (!graph.servicesReady || !graph.agentSession || !graph.sessionManager) {
      await this.disposeGraph(graph);
      return null;
    }

    const session = graph.agentSession;
    const sessionManager = graph.sessionManager;
    const sessionId =
      graph.sessionSnapshot?.sessionId || sessionManager.getSessionId() || session.sessionId;
    if (!sessionId) {
      await this.disposeGraph(graph);
      return null;
    }

    // The incoming owner must never re-register while the outgoing owner is
    // still present: ModelRuntime merges same-id extension Provider configs.
    // A busy outgoing graph keeps its providers registered instead — its
    // in-flight model calls must survive the reactivation window.
    if (args.previousGraph && !this.graphIsBusy(args.previousGraph)) {
      this.suspendGraphProviders(args.previousGraph);
    }
    this.resumeGraphProviders(graph);
    // A parked graph kept its previous Extension UI binding (park retention
    // preserves it); drop it before binding the candidate identity so no
    // stale emit closure survives the switch.
    if (graph.extensionUiCleanup) clearSlots(graph);
    const candidateIdentity: HostIdentity = {
      hostInstanceId: server.identity.hostInstanceId,
      workspaceId: graph.workspaceId,
      workspaceRevision: args.revision,
      sessionId,
      sessionRevision: args.sessionRevision,
      packageRevision: args.packageRevision,
    };

    try {
      // The graph is not active yet, so a session_start handler registering a
      // provider would otherwise be attributed to the outgoing workspace.
      const binding = graph.providerOwner
        ? await this.context.deps.providerOwnership.runAsOwner(graph.providerOwner, () =>
            bindForCandidate(
              session,
              graph.extensionsResult,
              server,
              candidateIdentity,
              this.context.getCommandContextActions?.(session),
            ),
          )
        : await bindForCandidate(
            session,
            graph.extensionsResult,
            server,
            candidateIdentity,
            this.context.getCommandContextActions?.(session),
          );
      graph.extensionUiActivate = binding.activate;
      graph.extensionUiCleanup = binding.cleanup;
      graph.extensionUiUpdateIdentity = binding.updateIdentity;
      graph.extensionUiReplayState = binding.replayState;
      binding.updateIdentity(candidateIdentity);
      // Parked background runtimes kept their Extension UI bindings through
      // the park; re-point them at the candidate identity (mirrors
      // promoteBackgroundRuntime) so their extensions emit under the
      // promoted session identity.
      for (const runtime of graph.backgroundSessions.values()) {
        runtime.extensionUiUpdateIdentity?.({
          ...candidateIdentity,
          sessionId: runtime.sessionId,
          sessionRevision: runtime.sessionRevision,
        });
      }
      markStep("bind");
      // Disk state was known unchanged at park time (fingerprint match) or the
      // capture is still in flight: the previous package snapshot is still
      // accurate apart from its revision, so reuse it instead of re-deriving
      // it from the package manager on every switch. The deferred drift
      // verification corrects a stale reuse after the fact.
      const packageSnapshotUnchanged = retainedFingerprint !== undefined || capturePending;
      graph.packageSnapshot =
        packageSnapshotUnchanged && graph.packageSnapshot
          ? { ...graph.packageSnapshot, revision: args.packageRevision }
          : await buildPackageSnapshot({
              revision: args.packageRevision,
              workspaceId: graph.workspaceId,
              scope: "all",
              packageManager: graph.packageManager!,
              settingsManager: graph.settingsManager!,
              resourceLoader: graph.resourceLoader,
              cwd: graph.canonicalCwd,
              agentDir: this.context.deps.agentDir,
              packageUpdateCheck: this.context.deps.packageUpdateCheck,
              resourceIdMap: graph.resourceIdMap,
              resourceReloadRequired: graph.resourceReloadRequired,
            });
      markStep("packageSnapshot");
      // Reactivating a parked graph whose session kept streaming in the
      // background: project the in-flight assistant message just like
      // promoteBackgroundRuntime does, or everything streamed while parked
      // would vanish from the conversation when the workspace returns.
      graph.sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: args.canonical,
        sessionId,
        revision: args.sessionRevision,
        workspaceId: graph.workspaceId,
        toolRevision: graph.toolRevision,
        includeStreamingMessage: true,
      });
      // A parked graph still carries its agent subscription from before the
      // park; drop it before re-subscribing so events are never delivered
      // twice.
      try {
        graph.unsubscribeAgent?.();
      } catch {
        /* ignore */
      }
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
      });
    } catch (err) {
      logger.warn("retained graph preparation failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.disposeGraph(graph);
      args.signal?.throwIfAborted();
      return null;
    }
    markStep("subscribe");

    if (args.signal?.aborted) {
      await this.disposeGraph(graph);
      args.signal.throwIfAborted();
    }

    const previousIdentity = server.getIdentity();
    graph.revision = args.revision;
    this.context.setGraph(graph);
    server.identity.workspaceId = graph.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = sessionId;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;
    // The graph is the foreground owner again; drop park state. This runs in
    // the same synchronous block as the commit, so no event can interleave
    // with a half-cleared park state.
    graph.backgroundRunning = false;
    graph.parkedIdentity = undefined;

    let publishExtensionUi = () => {};
    try {
      publishExtensionUi = await activateOnce(graph);
    } catch (err) {
      logger.warn("retained graph Extension activate failed; rebuilding workspace", {
        cwd: args.canonical,
        error: err instanceof Error ? err.message : String(err),
      });
      this.context.setGraph(args.previousGraph);
      this.restoreIdentity(server, previousIdentity);
      await this.disposeGraph(graph);
      return null;
    }
    markStep("activate");

    if (args.previousGraph) await this.retainGraph(args.previousGraph);
    markStep("retainPrevious");
    if (previousIdentity.sessionId && previousIdentity.sessionId !== server.identity.sessionId) {
      await this.context.deps.attachmentStore?.discardSessionDrafts(previousIdentity.sessionId);
    }
    this.refreshAgentPhase();
    server.setLastError(undefined);
    const workspace = this.buildWorkspaceSnapshot(graph);
    this.publishWorkspaceSnapshots(server, graph, workspace);
    graph.subagentStatusBridge?.setIdentity(server.getIdentity());
    graph.subagentStatusBridge?.markReady();
    publishExtensionUi();
    this.context.onBoundWorkspacesChanged?.();
    // Deferred drift verification: compares on-disk state at reactivate time
    // against the park-time baseline, off the switch critical path. A no-op
    // while a park-time capture is still in flight (it becomes the baseline).
    this.scheduleFingerprintCapture(graph, retainedFingerprint);
    logger.info("workspace graph reactivated", {
      cwd: graph.canonicalCwd,
      totalMs: Date.now() - startedAt,
      stepsMs: stepTimings,
    });
    return {
      workspace,
      ...(graph.sessionSnapshot ? { session: graph.sessionSnapshot } : {}),
    };
  }

  private async commitWorkspaceFailure(args: {
    previousGraph: WorkspaceGraph | null;
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
    error: HostError;
    signal?: AbortSignal;
  }): Promise<WorkspaceSnapshot> {
    const server = this.context.getServer()!;
    if (args.previousGraph) await this.retainGraph(args.previousGraph);
    const failedGraph: WorkspaceGraph = {
      workspaceId: args.workspaceId,
      cwd: args.cwd,
      canonicalCwd: args.canonicalCwd,
      revision: args.revision,
      servicesReady: false,
      settingsManager: null,
      packageManager: null,
      resourceLoader: null,
      sessionManager: null,
      agentSession: null,
      extensionsResult: null,
      packageSnapshot: null,
      sessionSnapshot: null,
      toolRevision: 0,
      resourceIdMap: new Map(),
      unsubscribeAgent: null,
      extensionUiActivate: null,
      extensionUiCleanup: null,
      extensionUiUpdateIdentity: null,
      extensionUiReplayState: null,
      resourceReloadRequired: false,
      idleSessionCache: new Map(),
      backgroundSessions: new Map(),
      providerOwner: null,
    };
    this.context.setGraph(failedGraph);
    server.identity.workspaceId = args.workspaceId;
    server.identity.workspaceRevision = args.revision;
    server.identity.sessionId = null;
    server.identity.sessionRevision = args.sessionRevision;
    server.identity.packageRevision = args.packageRevision;
    server.setLastError(args.error);
    server.setPhase("workspaceError");
    const workspace = this.buildWorkspaceSnapshot(failedGraph);
    server.emit("workspace.changed", workspace);
    return workspace;
  }

  private async buildServices(args: {
    workspaceId: string;
    cwd: string;
    canonicalCwd: string;
    revision: number;
    sessionRevision: number;
    packageRevision: number;
  }): Promise<{ graph: WorkspaceGraph } | { error: HostError }> {
    const server = this.context.getServer()!;
    const { agentDir, modelRuntime } = this.context.deps;
    let candidateSession: AgentSession | null = null;
    let candidateExtensionUiCleanup: (() => void) | null = null;
    let candidateUnsubscribeAgent: (() => void) | null = null;
    let candidateProviderOwner: ProviderOwnerToken | null = null;
    const buildStartedAt = Date.now();
    const stepTimings: Record<string, number> = {};
    let lastStepAt = buildStartedAt;
    const markStep = (name: string) => {
      const now = Date.now();
      stepTimings[name] = now - lastStepAt;
      lastStepAt = now;
    };

    try {
      // PiAbyss has no separate project-trust prompt. Treat "ask" as the
      // compatibility default (load project resources) and reserve "never"
      // for explicitly disabling project-local settings/resources.
      const globalSettings = SettingsManager.create(args.canonicalCwd, agentDir, {
        projectTrusted: false,
      });
      const settingsManager = SettingsManager.create(args.canonicalCwd, agentDir, {
        projectTrusted: globalSettings.getDefaultProjectTrust() !== "never",
      });
      const packageManager = new DefaultPackageManager({
        cwd: args.canonicalCwd,
        agentDir,
        settingsManager,
      });
      const statusBridge = this.context.deps.subagentStatusBridgeFactory?.(
        (identity, snapshot) => {
          const current = this.context.getServer()?.getIdentity();
          if (
            !current ||
            identity.hostInstanceId !== current.hostInstanceId ||
            identity.workspaceId !== current.workspaceId ||
            identity.workspaceRevision !== current.workspaceRevision ||
            identity.sessionId !== current.sessionId ||
            identity.sessionRevision !== current.sessionRevision ||
            identity.packageRevision !== current.packageRevision
          ) {
            return;
          }
          try {
            this.context
              .getServer()
              ?.emitForIdentity(identity, "subagents.statusChanged", snapshot);
          } catch {
            // Ignore status polls racing workspace/session replacement.
          }
        },
        { sessionsDir: sessionStorageDirs(agentDir, args.canonicalCwd).activeDir },
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd: args.canonicalCwd,
        agentDir,
        settingsManager,
        ...(statusBridge ? { extensionFactories: [statusBridge.extension] } : {}),
      });
      // Workspace selection (including the startup preload) must not reach the
      // network; see withoutImplicitPackageInstall. Resource discovery and the
      // chain-serialized model-health refresh are independent — overlap them
      // on the fresh-build critical path.
      await Promise.all([
        withoutImplicitPackageInstall(() => resourceLoader.reload()),
        Promise.resolve(this.context.deps.refreshModelHealth()),
      ]);
      markStep("resourceLoader.reload");
      const sessionManager = SessionManager.create(args.canonicalCwd);
      this.context.onModelHealthChanged();
      markStep("refreshModelHealth");

      // createAgentSession flushes the extension loader's queued
      // pi.registerProvider calls into the shared runtime; the owner scope
      // attributes them to this workspace even if another graph's agent turn
      // interleaves on the event loop.
      const providerOwner = this.context.deps.providerOwnership.createOwner(
        `workspace:${args.canonicalCwd}`,
      );
      candidateProviderOwner = providerOwner;
      // Package snapshotting only reads the loader/package manager settled
      // above and is independent of session construction — run it concurrently
      // with the session flow and join before the graph is committed. A
      // failure on either side fails the whole build (the catch below disposes
      // the candidate session); the flow itself never rejects, so a late
      // failure after an earlier session-flow error cannot become an unhandled
      // rejection.
      const resourceIdMap: ResourceIdMap = new Map();
      let packageSnapshotError: unknown = null;
      const packageSnapshotFlow = buildPackageSnapshot({
        revision: args.packageRevision,
        workspaceId: args.workspaceId,
        scope: "all",
        packageManager,
        settingsManager,
        resourceLoader,
        cwd: args.canonicalCwd,
        agentDir: this.context.deps.agentDir,
        packageUpdateCheck: this.context.deps.packageUpdateCheck,
        resourceIdMap,
        resourceReloadRequired: false,
      }).catch((err: unknown) => {
        packageSnapshotError = err;
        return null;
      });
      const { session, extensionsResult } = await this.context.deps.providerOwnership.runAsOwner(
        providerOwner,
        () =>
          createHostAgentSession({
            cwd: args.canonicalCwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader,
            sessionManager,
            ...(this.context.deps.attachmentStore
              ? { customTools: [createReadAttachmentTool(this.context.deps.attachmentStore)] }
              : {}),
          }),
      );
      candidateSession = session;
      markStep("createAgentSession");
      const sessionId = sessionManager.getSessionId() || session.sessionId || randomUUID();
      const graph: WorkspaceGraph = {
        workspaceId: args.workspaceId,
        cwd: args.cwd,
        canonicalCwd: args.canonicalCwd,
        revision: args.revision,
        servicesReady: true,
        settingsManager,
        packageManager,
        resourceLoader,
        sessionManager,
        agentSession: session,
        extensionsResult,
        packageSnapshot: null,
        sessionSnapshot: null,
        toolRevision: 1,
        resourceIdMap,
        unsubscribeAgent: null,
        extensionUiActivate: null,
        extensionUiCleanup: null,
        extensionUiUpdateIdentity: null,
        extensionUiReplayState: null,
        resourceReloadRequired: false,
        idleSessionCache: new Map(),
        backgroundSessions: new Map(),
        providerOwner,
        ...(statusBridge ? { subagentStatusBridge: statusBridge } : {}),
      };
      const candidateIdentity: HostIdentity = {
        hostInstanceId: server.identity.hostInstanceId,
        workspaceId: args.workspaceId,
        workspaceRevision: args.revision,
        sessionId,
        sessionRevision: args.sessionRevision,
        packageRevision: args.packageRevision,
      };
      // Still pre-activation: a session_start handler registering a provider
      // must land on this candidate workspace, not the outgoing one.
      const extensionUiBinding = await this.context.deps.providerOwnership.runAsOwner(
        providerOwner,
        () =>
          bindForCandidate(
            session,
            extensionsResult,
            server,
            candidateIdentity,
            this.context.getCommandContextActions?.(session),
          ),
      );
      graph.extensionUiActivate = extensionUiBinding.activate;
      graph.extensionUiCleanup = extensionUiBinding.cleanup;
      graph.extensionUiUpdateIdentity = extensionUiBinding.updateIdentity;
      graph.extensionUiReplayState = extensionUiBinding.replayState;
      candidateExtensionUiCleanup = extensionUiBinding.cleanup;
      graph.unsubscribeAgent = session.subscribe((event) => {
        this.sessionRuntimeCache.handleAgentEvent(graph, session, event);
      });
      candidateUnsubscribeAgent = graph.unsubscribeAgent;
      markStep("bindExtensionUi");

      // Join the concurrently-built package snapshot; a failure surfaces as a
      // regular buildServices failure so the catch disposes the candidate.
      if (packageSnapshotError !== null) throw packageSnapshotError;
      graph.packageSnapshot = await packageSnapshotFlow;
      markStep("buildPackageSnapshot");
      graph.sessionSnapshot = buildSessionSnapshot({
        session,
        sessionManager,
        cwd: args.canonicalCwd,
        sessionId,
        revision: args.sessionRevision,
        workspaceId: args.workspaceId,
        toolRevision: 1,
      });
      graph.toolRevision = 1;
      logger.info("workspace graph built", {
        cwd: args.canonicalCwd,
        totalMs: Date.now() - buildStartedAt,
        stepsMs: stepTimings,
      });
      return { graph };
    } catch (err) {
      try {
        candidateUnsubscribeAgent?.();
      } catch {
        /* ignore candidate subscription cleanup failure */
      }
      try {
        candidateExtensionUiCleanup?.();
      } catch {
        /* ignore candidate UI cleanup failure */
      }
      if (candidateSession) {
        await this.sessionRuntimeCache.disposeAgentSessionOnly(candidateSession);
      }
      if (candidateProviderOwner) {
        this.context.deps.providerOwnership.releaseOwner(candidateProviderOwner);
      }
      logger.error("buildServices failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        error: createHostError(
          "WORKSPACE_SWITCH_FAILED",
          err instanceof Error ? err.message : "Failed to build workspace services",
          { details: toJsonValue({ stack: err instanceof Error ? err.stack : undefined }) },
        ),
      };
    }
  }

  private restoreIdentity(server: PiHostServer, identity: HostIdentity): void {
    server.identity.workspaceId = identity.workspaceId;
    server.identity.workspaceRevision = identity.workspaceRevision;
    server.identity.sessionId = identity.sessionId;
    server.identity.sessionRevision = identity.sessionRevision;
    server.identity.packageRevision = identity.packageRevision;
  }

  private publishWorkspaceSnapshots(
    server: PiHostServer,
    graph: WorkspaceGraph,
    workspace: WorkspaceSnapshot,
  ): void {
    server.emit("workspace.changed", workspace);
    if (graph.packageSnapshot) server.emit("package.snapshot", graph.packageSnapshot);
    if (graph.sessionSnapshot) {
      server.emit("session.snapshot", graph.sessionSnapshot);
      server.emit("agent.toolsChanged", graph.sessionSnapshot.tools);
    }
  }
}
