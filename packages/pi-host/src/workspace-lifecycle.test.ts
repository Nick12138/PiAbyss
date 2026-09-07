import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLifecycle, workspaceIdentityKey } from "./workspace-lifecycle.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
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
    internal.retainedGraphs.set(
      workspaceIdentityKey(unrelated.canonicalCwd, "linux"),
      unrelated,
    );
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
function lifecycleWith(options: {
  platform?: NodeJS.Platform;
  maxBoundWorkspaces?: number;
  active?: WorkspaceGraph | null;
} = {}): WorkspaceLifecycle {
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
    },
    {
      disposeIdleSessionRuntimes: vi.fn().mockResolvedValue(undefined),
      disposeGraphSessionRuntimes: vi.fn().mockResolvedValue(undefined),
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
  await (subject as unknown as {
    retainGraph: (graph: WorkspaceGraph) => Promise<void>;
  }).retainGraph(graph);
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

describe("Workspace lifecycle bound-graph lookup (C1)", () => {
  it("prefers the active graph when its identity key matches", () => {
    const active = retainableGraph("/repo/active");
    const subject = lifecycleWith({ platform: "linux", active });

    expect(subject.getRetainedGraphByKey(workspaceIdentityKey("/repo/active", "linux"))).toBe(
      active,
    );
    expect(subject.getRetainedGraphByKey(workspaceIdentityKey("/repo/elsewhere", "linux"))).toBeNull();
  });

  it("falls back to retained graphs and lists active first", () => {
    const active = retainableGraph("/repo/active");
    const retained = retainableGraph("/repo/parked");
    const subject = lifecycleWith({ platform: "linux", active });
    retainedMap(subject).set(workspaceIdentityKey("/repo/parked", "linux"), retained);

    expect(subject.getRetainedGraphByKey(workspaceIdentityKey("/repo/parked", "linux"))).toBe(
      retained,
    );
    expect(subject.listBoundWorkspaceKeys()).toEqual([
      workspaceIdentityKey("/repo/active", "linux"),
      workspaceIdentityKey("/repo/parked", "linux"),
    ]);
  });
});

describe("WorkspaceGraphFactory bound-workspace queries (C1)", () => {
  it("resolves active and retained graphs by cwd and lists bound cwds", () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-graph-factory-"));
    const activeDir = join(root, "active");
    const parkedDir = join(root, "parked");
    mkdirSync(activeDir);
    mkdirSync(parkedDir);
    try {
      const factory = new WorkspaceGraphFactory({ agentDir: root } as unknown as GraphFactoryDeps);
      const activeCanonical = realpathSync(activeDir);
      const parkedCanonical = realpathSync(parkedDir);
      const active = retainableGraph(activeCanonical);
      const parked = retainableGraph(parkedCanonical);
      factory.graph = active;
      const lifecycle = (
        factory as unknown as { workspaceLifecycle: WorkspaceLifecycle }
      ).workspaceLifecycle;
      retainedMap(lifecycle as unknown as WorkspaceLifecycle).set(
        workspaceIdentityKey(parkedCanonical),
        parked,
      );

      expect(factory.getGraphForCwd(activeDir)).toBe(active);
      expect(factory.getGraphForCwd(parkedDir)).toBe(parked);
      expect(factory.getGraphForCwd(join(root, "missing"))).toBeNull();
      expect(factory.boundWorkspaceCwds()).toEqual([activeCanonical, parkedCanonical]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
