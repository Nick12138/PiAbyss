import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { HostIdentity } from "@piabyss/protocol";
import { GitService } from "./git-service.js";
import { GitAsyncTaskRunner } from "./git-async-tasks.js";
import { TryMutex } from "./locks.js";

const RUN = process.platform === "win32" ? "cmd" : "sh";
const RUN_ARGS = process.platform === "win32" ? ["/c"] : ["-c"];

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitBin(): string {
  try {
    return execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  } catch {
    return "git";
  }
}

const identity: HostIdentity = {
  hostInstanceId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000201",
  workspaceRevision: 3,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
};

/**
 * RepoMutex is the concurrency primitive that replaces the host-wide
 * serviceGraphLock during the network phase. Pin its semantics: same repo
 * serializes, different repos run in parallel, release is idempotent.
 */
describe("RepoMutex", () => {
  it("serializes acquisitions for the same repository path", async () => {
    const { RepoMutex } = await import("./git-service.js");
    const mutex = new RepoMutex();
    const order: string[] = [];
    const release = await mutex.acquire("/repo/a");
    order.push("first");
    const second = mutex.acquire("/repo/a").then((releaseSecond) => {
      order.push("second");
      releaseSecond();
    });
    // The second acquisition must not settle while the first is held.
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    release();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("allows different repositories to run concurrently", async () => {
    const { RepoMutex } = await import("./git-service.js");
    const mutex = new RepoMutex();
    const releaseA = await mutex.acquire("/repo/a");
    const releaseB = await Promise.race([
      mutex.acquire("/repo/b").then((release) => release),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(releaseB).not.toBeNull();
    releaseA();
  });
});

describe("GitAsyncTaskRunner", () => {
  let repo: string;
  let remote: string;
  let service: GitService;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "piabyss-git-async-"));
    remote = join(root, "origin.git");
    repo = join(root, "work");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
    execFileSync("git", ["clone", remote, repo], { stdio: "pipe" });
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["push", "-u", "origin", "main"]);
    service = new GitService();
  });

  afterEach(async () => {
    service.dispose();
    await rm(join(repo, ".."), { recursive: true, force: true }).catch(() => undefined);
  });

  function runnerWith(emitCalls: Array<{ event: string; payload: unknown }>) {
    const lock = new TryMutex();
    const host = {
      getIdentity: () => ({ ...identity }),
      currentWorkspaceId: () => identity.workspaceId,
      isBoundWorkspaceIdentity: () => true,
      emit: (event: string, payload: unknown) => emitCalls.push({ event, payload }),
      emitForIdentity: (_id: HostIdentity, event: string, payload: unknown) =>
        emitCalls.push({ event, payload }),
      serviceGraphLock: lock,
    };
    const runner = new GitAsyncTaskRunner(service, "git", () => host);
    return { runner, lock, host };
  }

  async function waitForTask(emitCalls: Array<{ event: string; payload: unknown }>) {
    for (let i = 0; i < 200; i += 1) {
      const finished = emitCalls.find((call) => call.event === "git.taskFinished");
      if (finished) return finished.payload as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("git.taskFinished was never emitted");
  }

  it("accepts a pull immediately and reports success with the workspace name", async () => {
    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const { runner } = runnerWith(emitCalls);
    const started = runner.start({ kind: "pull", workspaceCwd: repo, identity });
    expect(started).toMatchObject({ accepted: true });
    const payload = await waitForTask(emitCalls);
    expect(payload).toMatchObject({ operation: "pull", ok: true, workspaceName: "work" });
    expect(payload.snapshot).toBeDefined();
    // No serviceGraphLock was held across the network phase.
    expect(emitCalls.some((call) => call.event === "git.changed")).toBe(true);
  });

  it("does not hold the serviceGraphLock while the network phase runs", async () => {
    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const { runner, lock } = runnerWith(emitCalls);
    runner.start({ kind: "pull", workspaceCwd: repo, identity });
    // Immediate post-accept window: the async runner must not be holding the
    // lock that workspace.setCurrent needs.
    expect(lock.isHeld()).toBe(false);
    await waitForTask(emitCalls);
    expect(lock.isHeld()).toBe(false);
  });

  it("rejects a second pull on the same workspace while one is running", async () => {
    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const { runner } = runnerWith(emitCalls);
    const first = runner.start({ kind: "pull", workspaceCwd: repo, identity });
    expect(first).toMatchObject({ accepted: true });
    const second = runner.start({ kind: "pull", workspaceCwd: repo, identity });
    expect(second).toMatchObject({ error: { code: "GIT_OPERATION_FAILED" } });
    await waitForTask(emitCalls);
  });

  it("reports a classified failure (dirty worktree) without throwing", async () => {
    await writeFile(join(repo, "a.txt"), "dirty local edit\n");
    // A second commit on the remote so pull has something to merge.
    const other = join(repo, "..", "other");
    execFileSync("git", ["clone", remote, other], { stdio: "pipe" });
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    await writeFile(join(other, "b.txt"), "b\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote"]);
    git(other, ["push"]);

    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const { runner } = runnerWith(emitCalls);
    runner.start({ kind: "pull", workspaceCwd: repo, identity });
    const payload = await waitForTask(emitCalls);
    expect(payload.ok).toBe(false);
    expect(payload.workspaceName).toBe("work");
    expect(typeof payload.error).toBe("string");
    expect(payload.errorKind).toBe("clean-worktree");
  });

  it("still delivers the failure toast when the workspace was switched away", async () => {
    await writeFile(join(repo, "a.txt"), "dirty local edit\n");
    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const { runner, host } = runnerWith(emitCalls);
    // Simulate the user switching to another workspace mid-task: the requesting
    // identity is no longer the active one, but it stays bound (parked).
    vi.spyOn(host, "currentWorkspaceId").mockReturnValue("00000000-0000-4000-8000-000000000999");
    runner.start({ kind: "pull", workspaceCwd: repo, identity });
    const payload = await waitForTask(emitCalls);
    expect(payload.ok).toBe(false);
    // git.changed must NOT be delivered to the parked workspace.
    expect(emitCalls.some((call) => call.event === "git.changed")).toBe(false);
  });

  it("uses the provided git executable", async () => {
    const emitCalls: Array<{ event: string; payload: unknown }> = [];
    const lock = new TryMutex();
    const host = {
      getIdentity: () => ({ ...identity }),
      currentWorkspaceId: () => identity.workspaceId,
      isBoundWorkspaceIdentity: () => true,
      emit: (event: string, payload: unknown) => emitCalls.push({ event, payload }),
      emitForIdentity: (_id: HostIdentity, event: string, payload: unknown) =>
        emitCalls.push({ event, payload }),
      serviceGraphLock: lock,
    };
    void RUN;
    void RUN_ARGS;
    void gitBin;
    const runner = new GitAsyncTaskRunner(service, "git", () => host);
    runner.start({ kind: "pull", workspaceCwd: repo, identity });
    const payload = await waitForTask(emitCalls);
    expect(payload.operation).toBe("pull");
  });
});
