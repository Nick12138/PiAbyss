import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLifecycle, workspaceIdentityKey } from "./workspace-lifecycle.js";
import type { SessionRuntimeCache } from "./session-runtime-cache.js";
import type { GraphFactoryDeps, WorkspaceGraph } from "./workspace-graph-types.js";

function lifecycle(platform?: NodeJS.Platform) {
  return new WorkspaceLifecycle(
    {
      deps: { agentDir: "C:/agent" } as GraphFactoryDeps,
      getGraph: () => null,
      setGraph: vi.fn(),
      getServer: () => null,
      onModelHealthChanged: vi.fn(),
      platform,
    },
    {} as unknown as SessionRuntimeCache,
  );
}

describe("Workspace lifecycle", () => {
  it("preserves case-sensitive workspace identities on Unix-like platforms", () => {
    expect(workspaceIdentityKey("/repo/Foo", "linux")).not.toBe(
      workspaceIdentityKey("/repo/foo", "linux"),
    );
    expect(workspaceIdentityKey("/repo/Foo", "darwin")).not.toBe(
      workspaceIdentityKey("/repo/foo", "darwin"),
    );
  });

  it("normalizes separators and casing for Windows workspace identities", () => {
    expect(workspaceIdentityKey("C:\\Repos\\Alpha", "win32")).toBe(
      workspaceIdentityKey("c:/repos/ALPHA", "win32"),
    );
  });

  it("does not reactivate a retained graph with a different canonical identity", () => {
    const subject = lifecycle("linux");
    const retained = { canonicalCwd: "/repo/Foo" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
      takeRetainedGraph: (canonicalCwd: string) => WorkspaceGraph | null;
    };
    internal.retainedGraphs.set(workspaceIdentityKey("/repo/foo", "linux"), retained);

    expect(internal.takeRetainedGraph("/repo/foo")).toBeNull();
    expect(internal.takeRetainedGraph("/repo/Foo")).toBeNull();
    expect(internal.retainedGraphs.get("/repo/foo")).toBe(retained);
  });

  it("retains differently-cased Unix Workspace graphs independently", () => {
    const subject = lifecycle("linux");
    const upper = { canonicalCwd: "/repo/Foo" } as WorkspaceGraph;
    const lower = { canonicalCwd: "/repo/foo" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
      takeRetainedGraph: (canonicalCwd: string) => WorkspaceGraph | null;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(upper.canonicalCwd, "linux"), upper);
    internal.retainedGraphs.set(workspaceIdentityKey(lower.canonicalCwd, "linux"), lower);

    expect(internal.takeRetainedGraph(upper.canonicalCwd)).toBe(upper);
    expect(internal.takeRetainedGraph(lower.canonicalCwd)).toBe(lower);
  });

  it("invalidates only the retained graph for the matching Workspace", async () => {
    const subject = lifecycle("linux");
    const target = { canonicalCwd: "/repo/target" } as WorkspaceGraph;
    const unrelated = { canonicalCwd: "/repo/unrelated" } as WorkspaceGraph;
    const internal = subject as unknown as {
      retainedGraphs: Map<string, WorkspaceGraph>;
    };
    internal.retainedGraphs.set(workspaceIdentityKey(target.canonicalCwd, "linux"), target);
    internal.retainedGraphs.set(workspaceIdentityKey(unrelated.canonicalCwd, "linux"), unrelated);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    await subject.invalidateRetainedWorkspaceGraph(target.canonicalCwd);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(target);
    expect(internal.retainedGraphs.has(target.canonicalCwd)).toBe(false);
    expect(internal.retainedGraphs.get(unrelated.canonicalCwd)).toBe(unrelated);
  });

  it("canonicalizes an existing Workspace path", () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-workspace-lifecycle-"));
    try {
      expect(lifecycle().canonicalizeCwd(root)).toBe(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing Workspace path without mutating state", () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-workspace-lifecycle-"));
    const missing = join(root, "missing");
    try {
      let thrown: unknown;
      try {
        lifecycle().canonicalizeCwd(missing);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "WORKSPACE_SWITCH_FAILED",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing file as a Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-workspace-lifecycle-"));
    const file = join(root, "workspace.txt");
    writeFileSync(file, "not a directory");
    try {
      expect(() => lifecycle().canonicalizeCwd(file)).toThrowError(
        expect.objectContaining({ code: "WORKSPACE_NOT_DIRECTORY" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a symlink to a Workspace directory", () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-workspace-lifecycle-"));
    const target = join(root, "target");
    const link = join(root, "link");
    try {
      mkdirSync(target);
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      expect(lifecycle().canonicalizeCwd(link)).toBe(realpathSync(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds the public Workspace snapshot from lifecycle-owned fields", () => {
    const graph = {
      workspaceId: "workspace-id",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    } as WorkspaceGraph;

    expect(lifecycle().buildWorkspaceSnapshot(graph)).toEqual({
      id: "workspace-id",
      cwd: "C:/workspace",
      canonicalCwd: "C:/workspace",
      revision: 4,
      servicesReady: true,
    });
  });
});

/** Lifecycle with a controllable active graph and an optional C1 bound cap. */
function lifecycleWith(
  options: {
    platform?: NodeJS.Platform;
    maxBoundWorkspaces?: number;
    active?: WorkspaceGraph | null;
    onBoundWorkspacesChanged?: () => void;
  } = {},
): WorkspaceLifecycle {
  const active = options.active ?? null;
  return new WorkspaceLifecycle(
    {
      deps: {
        agentDir: "/agent",
        ...(options.maxBoundWorkspaces !== undefined
          ? { maxBoundWorkspaces: options.maxBoundWorkspaces }
          : {}),
        providerOwnership: { releaseOwner: vi.fn() },
      } as unknown as GraphFactoryDeps,
      getGraph: () => active,
      setGraph: vi.fn(),
      getServer: () => null,
      onModelHealthChanged: vi.fn(),
      platform: options.platform,
      ...(options.onBoundWorkspacesChanged
        ? { onBoundWorkspacesChanged: options.onBoundWorkspacesChanged }
        : {}),
    },
    {
      disposeIdleSessionRuntimes: vi.fn().mockResolvedValue(undefined),
      disposeGraphSessionRuntimes: vi.fn().mockResolvedValue(undefined),
      isSessionBusy: vi.fn((session: { isIdle?: boolean }) => session?.isIdle === false),
    } as unknown as SessionRuntimeCache,
  );
}

/** Minimum graph that survives the retention path (idle, no owner, no UI). */
function retainableGraph(canonicalCwd: string): WorkspaceGraph {
  return {
    canonicalCwd,
    servicesReady: true,
    agentSession: { isIdle: true },
    backgroundSessions: new Map(),
    resourceIdMap: new Map(),
    providerOwner: null,
    unsubscribeAgent: null,
    extensionUiCleanup: null,
  } as unknown as WorkspaceGraph;
}

async function retain(subject: WorkspaceLifecycle, graph: WorkspaceGraph): Promise<void> {
  await (
    subject as unknown as {
      retainGraph: (graph: WorkspaceGraph) => Promise<void>;
    }
  ).retainGraph(graph);
}

function retainedMap(subject: WorkspaceLifecycle): Map<string, WorkspaceGraph> {
  return (subject as unknown as { retainedGraphs: Map<string, WorkspaceGraph> }).retainedGraphs;
}

describe("Workspace lifecycle bound cap (C1 maxBoundWorkspaces)", () => {
  it("evicts the oldest retained graph beyond the configured bound", async () => {
    const subject = lifecycleWith({ platform: "linux", maxBoundWorkspaces: 2 });
    const first = retainableGraph("/repo/first");
    const second = retainableGraph("/repo/second");
    const third = retainableGraph("/repo/third");
    await retain(subject, first);
    await retain(subject, second);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    await retain(subject, third);

    expect(retainedMap(subject).size).toBe(2);
    expect([...retainedMap(subject).keys()]).toEqual([
      workspaceIdentityKey("/repo/second", "linux"),
      workspaceIdentityKey("/repo/third", "linux"),
    ]);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/first", "linux"))).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(first);
  });

  it("keeps the built-in cap (5) and its eviction when the dep is absent", async () => {
    const subject = lifecycleWith({ platform: "linux" });
    const cwds = ["/repo/1", "/repo/2", "/repo/3", "/repo/4", "/repo/5", "/repo/6"];
    const graphs = cwds.map((cwd) => retainableGraph(cwd));
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();
    for (const graph of graphs) await retain(subject, graph);

    expect(retainedMap(subject).size).toBe(5);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/1", "linux"))).toBe(false);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/2", "linux"))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(graphs[0]);
  });
});

/** A graph that is busy when parked: its sessions must keep running. */
function busyGraph(canonicalCwd: string, workspaceId: string): WorkspaceGraph {
  const unsubscribeAgent = vi.fn();
  const extensionUiCleanup = vi.fn();
  return {
    workspaceId,
    cwd: canonicalCwd,
    canonicalCwd,
    revision: 3,
    servicesReady: true,
    agentSession: { isIdle: false },
    backgroundSessions: new Map(),
    resourceIdMap: new Map(),
    providerOwner: null,
    unsubscribeAgent,
    extensionUiActivate: null,
    extensionUiCleanup,
    extensionUiUpdateIdentity: vi.fn(),
    extensionUiReplayState: vi.fn(),
  } as unknown as WorkspaceGraph;
}

describe("Workspace lifecycle busy-graph parking", () => {
  it("parks a busy graph with its own identity and keeps its live wiring", async () => {
    const onBoundWorkspacesChanged = vi.fn();
    const subject = lifecycleWith({ platform: "linux", onBoundWorkspacesChanged });
    const parked = busyGraph("/repo/busy", "workspace-busy");
    const unsubscribeAgent = parked.unsubscribeAgent as unknown as ReturnType<typeof vi.fn>;
    const extensionUiCleanup = parked.extensionUiCleanup as unknown as ReturnType<typeof vi.fn>;

    await retain(subject, parked);

    expect(parked.backgroundRunning).toBe(true);
    expect(parked.parkedIdentity).toMatchObject({
      workspaceId: "workspace-busy",
      workspaceRevision: 3,
    });
    // Parked graphs keep running: their subscription, Extension UI binding
    // and provider registration must all survive retention untouched.
    expect(unsubscribeAgent).not.toHaveBeenCalled();
    expect(extensionUiCleanup).not.toHaveBeenCalled();
    expect(parked.suspendedProviders).toBeUndefined();
    expect(retainedMap(subject).get(workspaceIdentityKey("/repo/busy", "linux"))).toBe(parked);
    expect(onBoundWorkspacesChanged).toHaveBeenCalled();

    // An idle graph still takes the plain retention path.
    const idle = retainableGraph("/repo/idle");
    await retain(subject, idle);
    expect(idle.backgroundRunning).toBe(false);
    expect(idle.parkedIdentity).toBeUndefined();
  });

  it("evicts idle graphs but never busy parked ones, exceeding the bound if needed", async () => {
    const subject = lifecycleWith({ platform: "linux", maxBoundWorkspaces: 2 });
    const busy = busyGraph("/repo/busy", "workspace-busy");
    const idle = retainableGraph("/repo/idle");
    await retain(subject, busy);
    await retain(subject, idle);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    const incoming = retainableGraph("/repo/incoming");
    await retain(subject, incoming);

    // Cap is 2 but only the stale idle graph is evictable; the busy parked
    // graph and the graph retained by this very switch are protected.
    expect(retainedMap(subject).size).toBe(2);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/busy", "linux"))).toBe(true);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/incoming", "linux"))).toBe(true);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/idle", "linux"))).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(idle);
  });

  it("temporarily exceeds the bound when every retained graph is busy", async () => {
    const subject = lifecycleWith({ platform: "linux", maxBoundWorkspaces: 1 });
    const first = busyGraph("/repo/first", "workspace-first");
    const second = busyGraph("/repo/second", "workspace-second");
    await retain(subject, first);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    await retain(subject, second);

    expect(retainedMap(subject).size).toBe(2);
    expect(dispose).not.toHaveBeenCalled();

    // A parked graph stays protected even after its sessions settle; only a
    // fresh retention (reactivation → re-retain) clears backgroundRunning.
    (first.agentSession as unknown as { isIdle: boolean }).isIdle = true;
    const third = retainableGraph("/repo/third");
    await retain(subject, third);
    expect(retainedMap(subject).size).toBe(3);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps busy parked graphs bound when skipping them during invalidation", async () => {
    const subject = lifecycleWith({ platform: "linux" });
    const busy = busyGraph("/repo/busy", "workspace-busy");
    const idle = retainableGraph("/repo/idle");
    await retain(subject, busy);
    await retain(subject, idle);
    const dispose = vi.spyOn(subject, "disposeGraph").mockResolvedValue();

    await subject.invalidateRetainedRuntimeCaches();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(idle);
    expect(subject.isBoundGraph(busy)).toBe(true);
    expect(retainedMap(subject).has(workspaceIdentityKey("/repo/busy", "linux"))).toBe(true);

    // Full disposal (shutdown path) still disposes everything.
    await subject.disposeRetainedGraphs();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenLastCalledWith(busy);
    expect(subject.isBoundGraph(busy)).toBe(false);
  });

  it("answers bound-workspace identity questions across active and retained graphs", async () => {
    const active = { ...retainableGraph("/repo/active"), workspaceId: "workspace-a", revision: 7 };
    const subject = lifecycleWith({ platform: "linux", active });
    const parked = busyGraph("/repo/parked", "workspace-b");
    await retain(subject, parked);

    expect(subject.isBoundGraph(active)).toBe(true);
    expect(subject.isBoundGraph(parked)).toBe(true);
    expect(subject.isBoundGraph(retainableGraph("/repo/stranger"))).toBe(false);
    expect(subject.isBoundWorkspaceIdentity("workspace-a", 7)).toBe(true);
    expect(subject.isBoundWorkspaceIdentity("workspace-b", 3)).toBe(true);
    expect(subject.isBoundWorkspaceIdentity("workspace-b", 4)).toBe(false);
    expect(subject.isBoundWorkspaceIdentity("workspace-stranger", 1)).toBe(false);
    expect(subject.hasBusyRetainedGraphs()).toBe(true);

    // Only service-ready graphs count as bound identities.
    (parked as { servicesReady: boolean }).servicesReady = false;
    expect(subject.isBoundWorkspaceIdentity("workspace-b", 3)).toBe(false);
    expect(subject.hasBusyRetainedGraphs()).toBe(true);
  });
});
