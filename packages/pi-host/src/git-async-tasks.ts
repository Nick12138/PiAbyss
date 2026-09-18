import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  createHostError,
  type GitStatusSnapshot,
  type GitTaskFinishedPayload,
  type HostError,
  type HostIdentity,
} from "@piabyss/protocol";
import { GitService, RepoMutex, type GitTaskKind, type GitTaskOutcome } from "./git-service.js";

type ServiceGraphLock = {
  tryAcquire(owner: { operationKind: string; requestId: string }): boolean;
  release(requestId: string): void;
};

type AsyncGitTaskHost = {
  getIdentity(): HostIdentity;
  /** Workspace currently bound to this Host, or null. */
  currentWorkspaceId(): string | null;
  /** True while the identity's workspace is active or a parked, bound graph. */
  isBoundWorkspaceIdentity(workspaceId: string | null, revision: number): boolean;
  emit(event: "git.changed", payload: unknown): void;
  emitForIdentity(identity: HostIdentity, event: "git.taskFinished", payload: unknown): void;
  serviceGraphLock: ServiceGraphLock;
};

type RunningTask = {
  taskId: string;
  workspaceCwd: string;
  controller: AbortController;
};

/**
 * Runs git pull/push as fire-and-forget background tasks.
 *
 * 1. The `git.pull` / `git.push` handlers call `start()` while holding the
 *    serviceGraphLock just long enough to validate identity and capture the
 *    workspace identity; the handler then returns `GitAsyncAccepted`
 *    immediately. A slow remote can no longer block workspace switches.
 * 2. The network phase runs WITHOUT the serviceGraphLock (serialized per
 *    repository by `RepoMutex`), so the user can switch workspaces and run
 *    pull/push in other workspaces concurrently.
 * 3. On completion the task re-acquires the graph lock briefly to refresh the
 *    status snapshot, then emits `git.taskFinished` — carrying the workspace
 *    name so multi-workspace notifications stay distinguishable. The result
 *    is delivered to the requesting workspace identity even after the user
 *    switched away (parked/bound workspace), and `git.changed` is only
 *    emitted while that workspace is still the active one.
 */
export class GitAsyncTaskRunner {
  private readonly repoMutex = new RepoMutex();
  private readonly running = new Map<string, RunningTask>();

  constructor(
    private readonly service: Pick<GitService, "getStatus">,
    private readonly executable: string,
    private readonly resolveHost: () => AsyncGitTaskHost | null,
  ) {}

  /** True when the given workspace already has a pull/push in flight. */
  isBusy(workspaceCwd: string): boolean {
    for (const task of this.running.values()) {
      if (task.workspaceCwd === workspaceCwd) return true;
    }
    return false;
  }

  /**
   * Capture the workspace identity inside the caller's graph-lock critical
   * section and start the background task. Returns an error when another
   * pull/push for the same workspace is already running.
   */
  start(args: {
    kind: GitTaskKind;
    workspaceCwd: string;
    identity: HostIdentity;
  }): { error: HostError } | { accepted: true; taskId: string } {
    if (this.isBusy(args.workspaceCwd)) {
      return {
        error: createHostError(
          "GIT_OPERATION_FAILED",
          "A pull or push is already running for this workspace",
          { retryable: false },
        ),
      };
    }
    const taskId = randomUUID();
    const controller = new AbortController();
    const task: RunningTask = {
      taskId,
      workspaceCwd: args.workspaceCwd,
      controller,
    };
    this.running.set(taskId, task);
    // Fire and forget: the handler returns before the network phase starts.
    void this.execute(args.kind, task, args.identity);
    return { accepted: true, taskId };
  }

  private async execute(
    kind: GitTaskKind,
    task: RunningTask,
    identity: HostIdentity,
  ): Promise<void> {
    try {
      const outcome = await GitService.runNetworkTask(
        this.service,
        this.repoMutex,
        kind,
        task.workspaceCwd,
        this.executable,
        task.controller.signal,
      );
      await this.finish(kind, task, identity, outcome);
    } finally {
      this.running.delete(task.taskId);
    }
  }

  private async finish(
    kind: GitTaskKind,
    task: RunningTask,
    identity: HostIdentity,
    outcome: GitTaskOutcome,
  ): Promise<void> {
    const host = this.resolveHost();
    if (!host) return;
    // Refresh the final status under a short graph-lock critical section so the
    // snapshot broadcast stays consistent with other graph mutations. A busy
    // lock is fine: we fall back to the snapshot captured inside the network
    // phase (if any) instead of waiting.
    let snapshot: GitStatusSnapshot | undefined = outcome.snapshot;
    if (outcome.ok) {
      const lockRequestId = `git-task:${task.taskId}`;
      if (
        host.serviceGraphLock.tryAcquire({
          operationKind: "git.mutation",
          requestId: lockRequestId,
        })
      ) {
        try {
          snapshot = await this.service.getStatus(task.workspaceCwd, task.controller.signal);
        } catch {
          // Keep the network-phase snapshot on refresh failure.
        } finally {
          host.serviceGraphLock.release(lockRequestId);
        }
      }
    }

    const payload: GitTaskFinishedPayload = {
      taskId: task.taskId,
      operation: kind,
      workspaceName: basename(task.workspaceCwd) || task.workspaceCwd,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error, errorKind: outcome.errorKind }),
      ...(snapshot ? { snapshot } : {}),
    };

    try {
      host.emitForIdentity(identity, "git.taskFinished", payload);
    } catch {
      // The workspace generation was superseded and is no longer bound — the
      // result has no live subscriber.
      return;
    }
    // git.changed is delivered only to the still-active workspace: a parked
    // workspace's snapshot would trip the renderer's cross-epoch identity
    // guard. Parked workspaces get their toast from git.taskFinished above and
    // a fresh status when they are activated again.
    if (
      snapshot &&
      host.currentWorkspaceId() === identity.workspaceId &&
      host.isBoundWorkspaceIdentity(identity.workspaceId, identity.workspaceRevision)
    ) {
      try {
        host.emit("git.changed", { snapshot });
      } catch {
        // Best-effort; the watcher will re-emit on the next change.
      }
    }
  }

  /** Abort all in-flight tasks (host shutdown). */
  abortAll(reason: string): void {
    for (const task of this.running.values()) {
      task.controller.abort(new Error(reason));
    }
  }
}
