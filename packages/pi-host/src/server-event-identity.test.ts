import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostError, type HostIdentity } from "@piabyss/protocol";
import type { GraphOperationKind } from "./locks.js";
import { HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS, PiHostServer } from "./server.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

function server(): PiHostServer {
  const instance = new PiHostServer({
    agentDir: "C:/agent",
    sdkVersion: "0.82.1",
    getModelConfigHealth: () => ({
      state: "ok",
      source: "ModelRegistry.getError",
    }),
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    handlers: {},
  });
  instance.identity.workspaceId = WORKSPACE_ID;
  instance.identity.workspaceRevision = 1;
  instance.identity.sessionId = ACTIVE_SESSION_ID;
  instance.identity.sessionRevision = 2;
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PiHostServer.emitForIdentity", () => {
  it("keeps the global sequence while labeling an event with a background Session", async () => {
    const host = server();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const identity: HostIdentity = {
      ...host.getIdentity(),
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
    };

    host.emitForIdentity(identity, "session.runtimeChanged", {
      sessionId: BACKGROUND_SESSION_ID,
      sessionRevision: 7,
      state: "running",
      updatedAt: 1,
    });
    host.emit("host.statusChanged", host.buildStatus());
    // Writes flush asynchronously through the outbound queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.sessionId).toBe(BACKGROUND_SESSION_ID);
    expect(first.sessionRevision).toBe(7);
    expect(first.sequence).toBe(1);
    expect(second.sessionId).toBe(ACTIVE_SESSION_ID);
    expect(second.sequence).toBe(2);
  });

  it("rejects identities from another Workspace epoch", () => {
    const host = server();
    expect(() =>
      host.emitForIdentity(
        { ...host.getIdentity(), workspaceRevision: 2 },
        "session.runtimeChanged",
        {
          sessionId: ACTIVE_SESSION_ID,
          sessionRevision: 2,
          state: "idle",
          updatedAt: 1,
        },
      ),
    ).toThrow("stale Host or Workspace identity");
  });
});

describe("PiHostServer.emitForBoundIdentity", () => {
  function runtimeEvent(sessionId = BACKGROUND_SESSION_ID, sessionRevision = 7) {
    return {
      sessionId,
      sessionRevision,
      state: "running" as const,
      updatedAt: 1,
    };
  }

  it("passes through unchanged when the identity matches the current one", async () => {
    const host = server();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    host.setBoundWorkspaceChecker(() => false);

    host.emitForBoundIdentity(host.getIdentity(), "session.runtimeChanged", runtimeEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.workspaceId).toBe(WORKSPACE_ID);
    expect(first.sessionId).toBe(ACTIVE_SESSION_ID);
  });

  it("emits for a bound (parked) workspace identity when the checker accepts it", async () => {
    const host = server();
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const checked: Array<[string, number]> = [];
    host.setBoundWorkspaceChecker((workspaceId, revision) => {
      checked.push([workspaceId, revision]);
      return true;
    });
    const parked: HostIdentity = {
      ...host.getIdentity(),
      workspaceId: "99999999-9999-4999-8999-999999999999",
      workspaceRevision: 3,
      sessionId: null,
      sessionRevision: 0,
    };

    host.emitForBoundIdentity(
      { ...parked, sessionId: BACKGROUND_SESSION_ID, sessionRevision: 7 },
      "session.runtimeChanged",
      runtimeEvent(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(checked).toEqual([["99999999-9999-4999-8999-999999999999", 3]]);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.workspaceId).toBe("99999999-9999-4999-8999-999999999999");
    expect(first.workspaceRevision).toBe(3);
    expect(first.sessionId).toBe(BACKGROUND_SESSION_ID);
  });

  it("rejects a workspace identity that is neither current nor bound", () => {
    const host = server();
    host.setBoundWorkspaceChecker(() => false);

    expect(() =>
      host.emitForBoundIdentity(
        { ...host.getIdentity(), workspaceId: "88888888-8888-4888-8888-888888888888" },
        "session.runtimeChanged",
        runtimeEvent(),
      ),
    ).toThrow("stale Host or Workspace identity");
  });

  it("rejects a non-current workspace identity when no checker is installed", () => {
    const host = server();

    expect(() =>
      host.emitForBoundIdentity(
        { ...host.getIdentity(), workspaceId: "88888888-8888-4888-8888-888888888888" },
        "session.runtimeChanged",
        runtimeEvent(),
      ),
    ).toThrow("stale Host or Workspace identity");
  });

  it("rejects a foreign hostInstanceId even when the checker accepts the workspace", () => {
    const host = server();
    host.setBoundWorkspaceChecker(() => true);

    expect(() =>
      host.emitForBoundIdentity(
        {
          ...host.getIdentity(),
          hostInstanceId: "00000000-0000-4000-8000-000000000000",
          workspaceId: "88888888-8888-4888-8888-888888888888",
        },
        "session.runtimeChanged",
        runtimeEvent(),
      ),
    ).toThrow("stale Host or Workspace identity");
  });

  it("reports boundWorkspaces in buildStatus only while a provider is wired", () => {
    const host = server();
    expect(host.buildStatus().boundWorkspaces).toBeUndefined();

    host.setBoundWorkspacesProvider(() => [
      {
        workspaceId: "99999999-9999-4999-8999-999999999999",
        revision: 3,
        cwd: "C:/parked",
      },
    ]);
    expect(host.buildStatus().boundWorkspaces).toEqual([
      {
        workspaceId: "99999999-9999-4999-8999-999999999999",
        revision: 3,
        cwd: "C:/parked",
      },
    ]);

    host.setBoundWorkspacesProvider(() => undefined);
    expect(host.buildStatus().boundWorkspaces).toBeUndefined();
  });
});

describe("PiHostServer Extension UI presentation handshake", () => {
  it("defaults to auto and applies the optional hello mode", async () => {
    const host = server();
    const writeResponse = vi.spyOn(host, "writeResponse").mockImplementation(() => {});

    expect(host.getExtensionDecisionPresentation()).toBe("auto");
    expect(host.buildStatus().extensionDecisionPresentation).toBe("auto");

    await host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555551",
        method: "system.hello",
        context: {},
        params: {
          clientName: "piabyss",
          clientVersion: "0.1.0",
          protocolVersion: 1,
          extensionDecisionPresentation: "auto",
        },
      }),
    );

    expect(host.getExtensionDecisionPresentation()).toBe("auto");
    expect(writeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          extensionDecisionPresentation: "auto",
        }),
      }),
    );
  });
});

describe("PiHostServer rehydrate barrier", () => {
  it.each<GraphOperationKind>(["workspace.setCurrent", "session.open", "package.mutation"])(
    "does not sample graph state during %s",
    async (operationKind) => {
      const getRehydrateState = vi.fn(() => {
        throw new Error("uncommitted graph state was sampled");
      });
      const host = new PiHostServer({
        agentDir: "C:/agent",
        sdkVersion: "0.82.1",
        getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
        capabilities: {
          packageUpdateCheck: false,
          extensionUi: true,
          sessionExport: false,
        },
        handlers: {},
        getRehydrateState,
      });
      const responses: Array<Record<string, unknown>> = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        responses.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        return true;
      }) as typeof process.stdout.write);
      expect(
        host.serviceGraphLock.tryAcquire({
          operationKind,
          requestId: "graph-mutation",
        }),
      ).toBe(true);

      await host.handleLine(
        JSON.stringify({
          protocolVersion: 1,
          id: "55555555-5555-4555-8555-555555555555",
          method: "system.rehydrate",
          context: { expectedHostInstanceId: host.identity.hostInstanceId },
          params: null,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getRehydrateState).not.toHaveBeenCalled();
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        ok: false,
        error: {
          code: "SERVICE_GRAPH_BUSY",
          retryable: true,
          details: { operationKind },
        },
      });
      expect(host.serviceGraphLock.getOwner()?.requestId).toBe("graph-mutation");
      host.serviceGraphLock.release("graph-mutation");
    },
  );

  it("returns an atomic no-Workspace snapshot at the preceding event watermark", async () => {
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({
        state: "ok",
        source: "ModelRegistry.getError",
      }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
    });
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    host.emit("host.statusChanged", host.buildStatus());
    const response = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555555",
        method: "system.rehydrate",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    host.emit("host.statusChanged", host.buildStatus());
    await response;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((message) => message.sequence ?? message.method)).toEqual([
      1,
      "system.rehydrate",
      2,
    ]);
    expect(parsed[1]).toMatchObject({
      ok: true,
      result: {
        watermark: 1,
        workspace: null,
        session: null,
        tools: null,
        packages: null,
      },
    });
    expect(host.serviceGraphLock.isHeld()).toBe(false);
  });
});

describe("PiHostServer shutdown", () => {
  it("publishes fatal state, cleans up, and exits nonzero for unknown async failures", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const emit = vi.spyOn(host, "emit").mockImplementation(() => {});
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    const error = createHostError("INTERNAL_ERROR", "detached task failed");

    await host.requestFatalShutdown(error, "unhandled promise rejection");

    expect(emit).toHaveBeenCalledWith("host.fatal", { error });
    expect(host.buildStatus().fatalError).toEqual(error);
    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith(1);
  });

  it("cancels and waits for a package mutation before disposing the graph", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({
        state: "ok",
        source: "ModelRegistry.getError",
      }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    expect(
      host.serviceGraphLock.tryAcquire({
        operationKind: "package.mutation",
        requestId: "package-request",
      }),
    ).toBe(true);
    const operation = host.graphOperations.begin({
      operationKind: "package.mutation",
      requestId: "package-request",
      operationId: "package-operation",
    });
    expect(operation).not.toBeNull();
    const shutdownSignal = host.getShutdownSignal();
    expect(shutdownSignal.aborted).toBe(false);

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "55555555-5555-4555-8555-555555555555",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );

    await vi.waitFor(() => expect(operation?.signal.aborted).toBe(true));
    expect(shutdownSignal.aborted).toBe(true);
    expect(host.getShutdownSignal()).toBe(shutdownSignal);
    expect(dispose).not.toHaveBeenCalled();

    host.serviceGraphLock.release("package-request");
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    operation?.finish();
    await handling;

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(host.serviceGraphLock.getOwner()).toBeNull();
  });

  it("fails shutdown instead of accepting when graph-lock quiescing times out", async () => {
    vi.useFakeTimers();
    const host = server();
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    const writeResponse = vi.spyOn(host, "writeResponse").mockImplementation(() => {});
    host.serviceGraphLock.tryAcquire({
      operationKind: "workspace.setCurrent",
      requestId: "workspace-request",
    });

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "66666666-6666-4666-8666-666666666666",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS);
    await handling;

    expect(writeResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "HOST_RESTART_REQUIRED" }),
      }),
    );
    expect(shutdown).toHaveBeenCalledWith(1);
  });

  it("applies the shutdown deadline to graph disposal", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn(() => new Promise<void>(() => {}));
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    const writeResponse = vi.spyOn(host, "writeResponse").mockImplementation(() => {});

    const handling = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "77777777-7777-4777-8777-777777777777",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_QUIESCE_TIMEOUT_MS);
    await handling;

    expect(dispose).toHaveBeenCalledOnce();
    expect(writeResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(shutdown).toHaveBeenCalledWith(1);
  });

  it("runs cleanup and transport shutdown exactly once for duplicate signals", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();

    await Promise.all([host.requestShutdown("stdin end"), host.requestShutdown("stdin close")]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shares cleanup and transport shutdown between RPC and signal entry points", async () => {
    const dispose = vi.fn(async () => {});
    const host = new PiHostServer({
      agentDir: "C:/agent",
      sdkVersion: "0.82.1",
      getModelConfigHealth: () => ({ state: "ok", source: "ModelRegistry.getError" }),
      capabilities: {
        packageUpdateCheck: false,
        extensionUi: true,
        sessionExport: false,
      },
      handlers: {},
      onShutdown: dispose,
    });
    const shutdown = vi.spyOn(host, "shutdown").mockResolvedValue();
    vi.spyOn(host, "writeResponse").mockImplementation(() => {});

    const rpc = host.handleLine(
      JSON.stringify({
        protocolVersion: 1,
        id: "88888888-8888-4888-8888-888888888888",
        method: "system.shutdown",
        context: { expectedHostInstanceId: host.identity.hostInstanceId },
        params: null,
      }),
    );
    const signal = host.requestShutdown("SIGTERM");
    await Promise.all([rpc, signal]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
