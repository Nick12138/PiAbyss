/**
 * R6: agent.prompt blocked while resourceReloadRequired until
 * package.reloadResources success path clears the flag.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentHandlers } from "./agent-controller.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import {
  createPackageHandlers,
  gitInstallSuffixFromMissingPath,
  isMissingPathError,
  missingPathFromError,
  npmPackageNameFromMissingPath,
} from "./package-controller.js";
import { createSessionHandlers } from "./session-controller.js";
import { logger } from "./logger.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";

function mockFactory(opts: {
  resourceReloadRequired: boolean;
  graphBusy?: boolean;
  graphBusyAfterAgentAcquire?: boolean;
  agentBusy?: boolean;
}): WorkspaceGraphFactory {
  const globalSettings = {
    packages: [] as unknown[],
    extensions: [] as string[],
  };
  const projectSettings = {
    packages: [] as unknown[],
    extensions: [] as string[],
  };
  const g = {
    resourceReloadRequired: opts.resourceReloadRequired,
    agentSession: {
      reload: vi.fn(async () => {}),
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      prompt: vi.fn(async () => {}),
      compact: vi.fn(async (instructions?: string) => ({ summary: instructions ?? "default" })),
      model: undefined,
      thinkingLevel: "off",
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "all" as const,
      followUpMode: "all" as const,
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      sessionName: "test",
      setSessionName: vi.fn((name: string) => {
        g.agentSession.sessionName = name;
      }),
      setModel: vi.fn(async () => {}),
      messages: [] as unknown[],
      getAvailableThinkingLevels: () => ["off"],
      getSteeringMessages: () => [] as string[],
      getFollowUpMessages: () => [] as string[],
      getAllTools: () => [] as Array<{ name: string }>,
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName: vi.fn(),
    },
    sessionManager: {},
    sessionSnapshot: null as null | object,
    toolRevision: 1,
    workspaceId: "w1",
    canonicalCwd: "/tmp",
    packageManager: {
      listConfiguredPackages: () => [],
      resolve: async () => ({
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      }),
      setProgressCallback: () => {},
    },
    settingsManager: {
      flush: async () => {},
      drainErrors: () => [],
      getGlobalSettings: () => globalSettings,
      getProjectSettings: () => projectSettings,
      setExtensionPaths: vi.fn((paths: string[]) => {
        globalSettings.extensions = paths;
      }),
      setProjectExtensionPaths: vi.fn((paths: string[]) => {
        projectSettings.extensions = paths;
      }),
    },
    resourceIdMap: new Map(),
    resourceLoader: {
      reload: vi.fn(async () => {}),
    },
    extensionUiUpdateIdentity: vi.fn(),
    packageSnapshot: {
      revision: 1,
      workspaceId: "w1",
      scope: "all" as const,
      configured: [],
      resources: [],
      updateCheck: { supported: false },
      diagnostics: [],
      resourceReloadRequired: opts.resourceReloadRequired,
    },
  };

  const identity = {
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    snapshot: () => ({
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: identity.sessionRevision,
      packageRevision: identity.packageRevision,
    }),
    bumpSessionRevision: () => {
      identity.sessionRevision += 1;
      return identity.sessionRevision;
    },
    bumpPackageRevision: () => {
      identity.packageRevision += 1;
      return identity.packageRevision;
    },
  };

  let phase = "ready";
  let graphHeldChecks = 0;
  const releaseAgent = vi.fn();
  const server = {
    identity,
    graphOperations: new GraphOperationRegistry(),
    serviceGraphLock: {
      isHeld: () => {
        graphHeldChecks += 1;
        return (
          opts.graphBusy === true ||
          (opts.graphBusyAfterAgentAcquire === true && graphHeldChecks > 1)
        );
      },
      getOwner: () => null,
      tryAcquire: () => true,
      release: () => {},
    },
    agentOperationLock: {
      tryAcquire: () => opts.agentBusy !== true,
      release: releaseAgent,
      isHeld: () => opts.agentBusy === true,
    },
    emit: () => {},
    emitForBoundIdentity: () => {},
    getIdentity: () => identity.snapshot(),
    setPhase: (p: string) => {
      phase = p;
    },
    getPhase: () => phase,
    requestShutdown: vi.fn(async () => {}),
  };

  return {
    checkIdentity: () => null,
    getGraph: () => g,
    getServer: () => server,
    getSessionOperationLock: () => server.agentOperationLock,
    hasBusySessions: () => opts.agentBusy === true || !g.agentSession.isIdle,
    hasAnyBusySessions: () => opts.agentBusy === true || !g.agentSession.isIdle,
    setSessionRunId: () => {},
    clearSessionRunId: () => {},
    publishCurrentRuntimeState: vi.fn(),
    publishCurrentRuntimeStateForSession: vi.fn(),
    currentSessionIdentity: vi.fn(() => null),
    invalidateRetainedRuntimeCaches: vi.fn(async () => {}),
    setActiveSessionName: vi.fn((name: string) => {
      g.agentSession.setSessionName(name);
      const snapshot = { sessionId: "s1", name };
      g.sessionSnapshot = snapshot;
      return snapshot;
    }),
    refineActiveSessionName: vi.fn(async () => {}),
    currentRunId: null as string | null,
    deps: {
      agentDir: "C:\\nonexistent\\pi-agent",
      packageUpdateCheck: false,
      refreshModelHealth: () => {},
      getModelConfigHealth: () => ({
        state: "ok" as const,
        source: "ModelRegistry.getError" as const,
      }),
      modelRegistry: { getAll: () => [] },
    },
    onModelHealthChanged: () => {},
  } as unknown as WorkspaceGraphFactory;
}

const promptCtx = {
  id: "req-prompt",
  context: {
    expectedHostInstanceId: "h1",
    expectedWorkspaceId: "w1",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "s1",
    expectedSessionRevision: 1,
  },
  params: { text: "hello" },
};

const reloadCtx = {
  id: "req-reload",
  context: {
    expectedHostInstanceId: "h1",
    expectedWorkspaceId: "w1",
    expectedWorkspaceRevision: 1,
    expectedSessionId: "s1",
    expectedSessionRevision: 1,
    expectedPackageRevision: 1,
  },
  params: null,
};

const preferenceCtx = {
  ...reloadCtx,
  id: "req-resource-preference",
  params: {
    resourceId: "resource-extension",
    targetScope: "user",
    preference: "disabled",
  },
};

describe("RESOURCE_RELOAD_FAILED prompt block", () => {
  it("blocks agent.prompt when resourceReloadRequired", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error.code).toBe("RESOURCE_RELOAD_FAILED");
    }
  });

  it("allows agent.prompt when reload flag already clear", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { accepted: boolean }).accepted).toBe(true);
    }
  });

  it("provisionally names an unnamed session and schedules refinement", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    (graph.agentSession as unknown as { sessionName?: string }).sessionName = undefined;

    const out = await createAgentHandlers(factory)["agent.prompt"]!({
      ...promptCtx,
      params: { text: "修复 session 恢复问题。然后补测试" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.setActiveSessionName).toHaveBeenCalledWith("🐛 修复 session 恢复问题");
    await vi.waitFor(() => {
      expect(factory.refineActiveSessionName).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "s1",
          provisionalTitle: "🐛 修复 session 恢复问题",
          userPrompt: "修复 session 恢复问题。然后补测试",
        }),
      );
    });
  });

  it("catches failures from the detached prompt task", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const graph = factory.getGraph()!;
    (graph.agentSession as unknown as { sessionName?: string }).sessionName = undefined;
    vi.mocked(factory.refineActiveSessionName).mockRejectedValueOnce(
      new Error("refinement escaped"),
    );
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {});

    const out = await createAgentHandlers(factory)["agent.prompt"]!({
      ...promptCtx,
      params: { text: "Create a safe title" },
    } as never);

    expect("error" in out).toBe(false);
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "Detached agent prompt task failed",
        expect.objectContaining({ error: "refinement escaped" }),
      );
    });
  });

  it("agent.compact passes the public SDK instructions string and updates the snapshot", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.compact"]!({
      ...promptCtx,
      id: "req-compact",
      params: { instructions: "preserve decisions" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.getGraph()!.agentSession!.compact).toHaveBeenCalledWith("preserve decisions");
    expect(factory.getGraph()!.sessionSnapshot).not.toBeNull();
  });

  it("agent.compact rejects while a graph mutation owns the service lock", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, graphBusy: true });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.compact"]!({
      ...promptCtx,
      id: "req-compact-busy",
      params: {},
    } as never);

    expect("error" in out && out.error.code).toBe("SERVICE_GRAPH_BUSY");
    expect(factory.getGraph()!.agentSession!.compact).not.toHaveBeenCalled();
  });

  it("agent.prompt releases the agent lock when a graph mutation wins the handoff", async () => {
    const factory = mockFactory({
      resourceReloadRequired: false,
      graphBusyAfterAgentAcquire: true,
    });
    const handlers = createAgentHandlers(factory);
    const out = await handlers["agent.prompt"]!(promptCtx as never);

    expect("error" in out && out.error.code).toBe("SERVICE_GRAPH_BUSY");
    expect(factory.getGraph()!.agentSession!.prompt).not.toHaveBeenCalled();
    expect(factory.getServer()!.agentOperationLock.release).toHaveBeenCalledWith(promptCtx.id);
  });

  it("graph mutations reject while the agent operation lock is held", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, agentBusy: true });
    const packageOut = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );

    expect("error" in packageOut && packageOut.error.code).toBe("AGENT_BUSY");
  });

  it("agent.setActiveTools rechecks the agent operation lock after acquiring the graph lock", async () => {
    const factory = mockFactory({ resourceReloadRequired: false, agentBusy: true });
    const out = await createAgentHandlers(factory)["agent.setActiveTools"]!({
      ...promptCtx,
      id: "req-tools-busy",
      context: {
        ...promptCtx.context,
        expectedToolRevision: 1,
      },
      params: { names: [] },
    } as never);

    expect("error" in out && out.error.code).toBe("AGENT_BUSY");
    expect(factory.getGraph()!.agentSession!.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("session.setName uses the public AgentSession API without advancing generations", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const before = factory.getServer()!.identity.snapshot();
    const out = await createSessionHandlers(factory)["session.setName"]!({
      ...promptCtx,
      id: "req-session-name",
      params: { name: "Renamed" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.getGraph()!.agentSession!.setSessionName).toHaveBeenCalledWith("Renamed");
    expect(factory.getServer()!.identity.snapshot()).toMatchObject({
      workspaceRevision: before.workspaceRevision,
      sessionRevision: before.sessionRevision,
      packageRevision: before.packageRevision,
    });
  });

  it("session.setName remains available while the Agent is running", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    Reflect.set(factory.getGraph()!.agentSession!, "isIdle", false);
    const out = await createSessionHandlers(factory)["session.setName"]!({
      ...promptCtx,
      id: "req-session-name-busy",
      params: { name: "Renamed while running" },
    } as never);

    expect("error" in out).toBe(false);
    expect(factory.getGraph()!.agentSession!.setSessionName).toHaveBeenCalledWith(
      "Renamed while running",
    );
  });

  it("package.reloadResources success path clears flag then agent.prompt accepts", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const g = factory.getGraph()!;
    expect(g.resourceReloadRequired).toBe(true);
    // Snapshot still says reload required (stale until mutation finalizes)
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(true);

    // Blocked while flag is set
    const agentHandlers = createAgentHandlers(factory);
    const blocked = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(true);

    // Drive REAL package.reloadResources handler (not a manual flag flip)
    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(reloadCtx as never);
    expect("error" in reloadOut).toBe(false);
    if (!("error" in reloadOut)) {
      const result = reloadOut.result as {
        status: string;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      // UI contract: returned snapshot must clear the banner (not only graph flag)
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }

    // Graph + stored snapshot both cleared by finalizePackageSnapshot
    expect(g.resourceReloadRequired).toBe(false);
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(false);
    expect(g.resourceLoader!.reload).not.toHaveBeenCalled();
    expect(g.agentSession!.reload).toHaveBeenCalledTimes(1);
    expect(g.extensionUiUpdateIdentity).toHaveBeenCalledOnce();
    expect(g.extensionUiUpdateIdentity).toHaveBeenCalledWith({
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 2,
      packageRevision: 2,
    });

    // Prompt unblocked after real reloadResources
    const allowed = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in allowed).toBe(false);
    if (!("error" in allowed)) {
      expect((allowed.result as { accepted: boolean }).accepted).toBe(true);
    }
  });

  it("flushes settings, reloads resources, rebuilds snapshot, then emits", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    const server = factory.getServer()!;
    const order: string[] = [];
    g.settingsManager!.flush = vi.fn(async () => {
      order.push("flush");
    });
    g.agentSession!.reload = vi.fn(async () => {
      order.push("reload");
    });
    g.packageManager!.resolve = vi.fn(async () => {
      order.push("snapshot");
      return { extensions: [], skills: [], prompts: [], themes: [] };
    });
    server.emit = vi.fn((event: string) => {
      if (event === "package.snapshot") order.push("emit");
    }) as never;

    const result = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in result).toBe(false);
    expect(order).toEqual(["flush", "reload", "snapshot", "emit"]);
  });

  it("uses the official full reload for both preference and resource reload paths", async () => {
    const preferenceFactory = mockFactory({ resourceReloadRequired: false });
    const preferenceGraph = preferenceFactory.getGraph()!;
    preferenceGraph.resourceIdMap.set("resource-extension", {
      type: "extension",
      scope: "user",
      path: "/tmp/.pi/extensions/example.ts",
      baseDir: "/tmp/.pi",
      relativePath: "extensions/example.ts",
      origin: "top-level",
      configurableScopes: ["user"],
    });

    const preferenceOut = await createPackageHandlers(preferenceFactory)["resource.setPreference"]!(
      preferenceCtx as never,
    );

    expect("error" in preferenceOut).toBe(false);
    // 0.82.1 removed preserveExtensionCache: preference reconcile now takes the
    // same official full reload as every other path.
    expect(preferenceGraph.agentSession!.reload).toHaveBeenCalledWith();

    const reloadFactory = mockFactory({ resourceReloadRequired: false });
    const reloadGraph = reloadFactory.getGraph()!;
    const reloadOut = await createPackageHandlers(reloadFactory)["package.reloadResources"]!(
      reloadCtx as never,
    );

    expect("error" in reloadOut).toBe(false);
    expect(reloadGraph.agentSession!.reload).toHaveBeenCalledWith();
  });

  it("clean package failure does not advance the authoritative package revision", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const packageHandlers = createPackageHandlers(factory);
    const beforeRevision = factory.getServer()!.identity.packageRevision;
    const out = await packageHandlers["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-missing",
      params: { packageId: "missing" },
    } as never);

    expect("error" in out).toBe(true);
    expect(factory.getServer()!.identity.packageRevision).toBe(beforeRevision);
  });

  it("cancels a timed-out package operation, reconciles, and releases ownership", async () => {
    vi.useFakeTimers();
    try {
      const factory = mockFactory({ resourceReloadRequired: false });
      const graph = factory.getGraph()!;
      const server = factory.getServer()!;
      let operationSignal: AbortSignal | undefined;
      let mutationSignal: AbortSignal | undefined;
      graph.packageManager!.setOperationSignal = vi.fn((signal) => {
        operationSignal = signal;
        if (signal) mutationSignal = signal;
      });
      graph.packageManager!.installAndPersist = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            if (operationSignal?.aborted) {
              reject(operationSignal.reason);
              return;
            }
            operationSignal?.addEventListener("abort", () => reject(operationSignal?.reason), {
              once: true,
            });
          }),
      );

      const pending = createPackageHandlers(factory)["package.install"]!({
        ...reloadCtx,
        id: "req-timeout-install",
        params: { source: "npm:never-finishes", scope: "user" },
      } as never);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(operationSignal).toBeDefined());
      expect(operationSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(600_000);
      const out = await pending;

      expect("error" in out && out.error.code).toBe("PACKAGE_PARTIAL_FAILURE");
      expect(mutationSignal?.aborted).toBe(true);
      expect(operationSignal).toBeUndefined();
      expect(server.serviceGraphLock.isHeld()).toBe(false);
      expect(server.graphOperations.getActive()).toBeNull();
      expect(server.requestShutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("package.reloadResources failure keeps snapshot flag true and prompt blocked", async () => {
    const factory = mockFactory({ resourceReloadRequired: true });
    const g = factory.getGraph()!;
    g.agentSession!.reload = vi.fn(async () => {
      throw new Error("reload boom");
    });

    const packageHandlers = createPackageHandlers(factory);
    const reloadOut = await packageHandlers["package.reloadResources"]!(reloadCtx as never);
    // Should return result with partialFailure, not throw
    expect("error" in reloadOut).toBe(false);
    if (!("error" in reloadOut)) {
      const result = reloadOut.result as {
        status: string;
        reconcileRequired: boolean;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("partialFailure");
      expect(result.reconcileRequired).toBe(true);
      // UI contract: snapshot still requires reload banner
      expect(result.packageSnapshot.resourceReloadRequired).toBe(true);
    }
    expect(g.resourceReloadRequired).toBe(true);
    expect(g.packageSnapshot?.resourceReloadRequired).toBe(true);
    expect(g.resourceLoader!.reload).not.toHaveBeenCalled();
    expect(g.agentSession!.reload).toHaveBeenCalledTimes(1);
    expect(g.extensionUiUpdateIdentity).not.toHaveBeenCalled();

    const agentHandlers = createAgentHandlers(factory);
    const blocked = await agentHandlers["agent.prompt"]!(promptCtx as never);
    expect("error" in blocked && blocked.error.code === "RESOURCE_RELOAD_FAILED").toBe(true);
  });
});

function enoentError(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), {
    code: "ENOENT",
  });
}

describe("uninstalled-package ENOENT tolerance", () => {
  it("classifies missing paths by install marker and configured sources", () => {
    expect(isMissingPathError(enoentError("C:\\pi\\gone"))).toBe(true);
    expect(isMissingPathError(new Error("npm crashed"))).toBe(false);
    expect(missingPathFromError(enoentError("C:\\pi\\npm\\node_modules\\gone"))).toBe(
      "C:\\pi\\npm\\node_modules\\gone",
    );
    expect(npmPackageNameFromMissingPath("C:\\pi\\npm\\node_modules\\@scope\\pkg\\dist")).toBe(
      "@scope/pkg",
    );
    expect(npmPackageNameFromMissingPath("C:\\pi\\npm\\node_modules\\gone\\x.js")).toBe("gone");
    expect(gitInstallSuffixFromMissingPath("C:\\pi\\git\\github.com\\owner\\repo")).toBe(
      "github.com/owner/repo",
    );
    // A host segment with no dot is not an SDK git clone (e.g. Portable Git).
    expect(gitInstallSuffixFromMissingPath("C:\\PortableGit\\git\\cmd")).toBeNull();
    expect(gitInstallSuffixFromMissingPath("C:\\pi\\git\\localhost\\repo")).toBeNull();
  });

  it("keeps the mutation committed when reload stats a just-removed npm package", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    g.agentSession!.reload = vi.fn(async () => {
      throw enoentError("C:\\pi\\agent\\npm\\node_modules\\removed-pkg");
    });

    const out = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      const result = out.result as {
        status: string;
        packageSnapshot: { resourceReloadRequired?: boolean };
      };
      expect(result.status).toBe("committed");
      expect(result.packageSnapshot.resourceReloadRequired).toBe(false);
    }
    expect(g.resourceReloadRequired).toBe(false);
    // Snapshot rebuild still ran: the reloaded bundle is authoritative.
    expect(g.extensionUiUpdateIdentity).toHaveBeenCalled();
  });

  it("keeps the mutation committed when reload stats a just-removed git clone", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    g.agentSession!.reload = vi.fn(async () => {
      throw enoentError("C:\\pi\\agent\\git\\github.com\\owner\\repo");
    });

    const out = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { status: string }).status).toBe("committed");
    }
    expect(g.resourceReloadRequired).toBe(false);
  });

  it("keeps a real reload failure when the missing npm package is still configured", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    g.packageManager!.listConfiguredPackages = vi.fn(() => [{ source: "npm:kept-pkg" }]) as never;
    g.agentSession!.reload = vi.fn(async () => {
      throw enoentError("C:\\pi\\agent\\npm\\node_modules\\kept-pkg");
    });

    const out = await createPackageHandlers(factory)["package.reloadResources"]!(
      reloadCtx as never,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect((out.result as { status: string }).status).toBe("partialFailure");
    }
    expect(g.resourceReloadRequired).toBe(true);
  });

  it("persists the settings drop when remove hits a missing package entry", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    g.packageSnapshot = {
      ...(g.packageSnapshot as object),
      configured: [{ id: "p1", source: "npm:gone-pkg", kind: "npm", scope: "user" }],
    } as never;
    const pm = g.packageManager as unknown as {
      listConfiguredPackages: ReturnType<typeof vi.fn>;
      removeAndPersist: ReturnType<typeof vi.fn>;
      removeSourceFromSettings: ReturnType<typeof vi.fn>;
    };
    pm.listConfiguredPackages = vi.fn(() => [{ source: "npm:gone-pkg" }]);
    pm.removeAndPersist = vi.fn(async () => {
      throw enoentError("C:\\pi\\agent\\npm\\node_modules\\gone-pkg");
    });
    pm.removeSourceFromSettings = vi.fn(() => true);

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-enoent",
      params: { packageId: "p1" },
    } as never);

    expect("error" in out).toBe(false);
    expect(pm.removeSourceFromSettings).toHaveBeenCalledWith("npm:gone-pkg", { local: false });
  });

  it("rethrows remove failures that are not missing-path errors", async () => {
    const factory = mockFactory({ resourceReloadRequired: false });
    const g = factory.getGraph()!;
    g.packageSnapshot = {
      ...(g.packageSnapshot as object),
      configured: [{ id: "p1", source: "npm:boom", kind: "npm", scope: "user" }],
    } as never;
    const pm = g.packageManager as unknown as {
      removeAndPersist: ReturnType<typeof vi.fn>;
      removeSourceFromSettings: ReturnType<typeof vi.fn>;
    };
    pm.removeAndPersist = vi.fn(async () => {
      throw new Error("npm crashed");
    });
    pm.removeSourceFromSettings = vi.fn(() => true);

    const out = await createPackageHandlers(factory)["package.remove"]!({
      ...reloadCtx,
      id: "req-remove-crash",
      params: { packageId: "p1" },
    } as never);

    expect("error" in out && out.error.code).toBe("PACKAGE_REMOVE_FAILED");
    expect(pm.removeSourceFromSettings).not.toHaveBeenCalled();
  });
});
