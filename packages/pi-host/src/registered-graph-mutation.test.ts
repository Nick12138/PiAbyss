import { describe, expect, it } from "vitest";
import { TryMutex } from "./locks.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";

function host() {
  return {
    graphOperations: new GraphOperationRegistry(),
    serviceGraphLock: new TryMutex(),
  };
}

describe("withRegisteredGraphMutation", () => {
  it("shares operation ownership and cleans up after success", async () => {
    const server = host();
    const outcome = await withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: ({ operationId, signal }) => {
        expect(signal.aborted).toBe(false);
        expect(server.graphOperations.getActive()?.operationId).toBe(operationId);
        expect(server.serviceGraphLock.getOwner()).toMatchObject({
          operationKind: "provider.mutation",
          requestId: "provider-save",
          operationId,
        });
        return { result: "saved" };
      },
    });

    expect(outcome).toEqual({ result: "saved" });
    expect(server.serviceGraphLock.getOwner()).toBeNull();
    expect(server.graphOperations.getActive()).toBeNull();
  });

  it("returns SERVICE_GRAPH_BUSY when another operation is registered", async () => {
    const server = host();
    const active = server.graphOperations.begin({
      operationKind: "package.mutation",
      requestId: "package-save",
      operationId: "package-operation",
    });

    const outcome = await withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: () => ({ result: "unreachable" }),
    });

    expect(outcome).toMatchObject({
      error: {
        code: "SERVICE_GRAPH_BUSY",
        retryable: true,
        details: { operationKind: "package.mutation" },
      },
    });
    expect(server.graphOperations.getActive()).toBe(active);
    expect(server.serviceGraphLock.getOwner()).toBeNull();
    active?.finish();
  });

  it("finishes its registration when the graph mutex stays busy", async () => {
    const server = host();
    server.serviceGraphLock.tryAcquire({
      operationKind: "workspace.setCurrent",
      requestId: "workspace-switch",
    });

    const outcome = await withRegisteredGraphMutation({
      server,
      operationKind: "model.setCurrent",
      requestId: "model-select",
      lockWaitMs: 0,
      run: () => ({ result: "unreachable" }),
    });

    expect(outcome).toMatchObject({
      error: {
        code: "SERVICE_GRAPH_BUSY",
        details: { operationKind: "workspace.setCurrent" },
      },
    });
    expect(server.graphOperations.getActive()).toBeNull();
    expect(server.serviceGraphLock.getOwner()?.requestId).toBe("workspace-switch");
    server.serviceGraphLock.release("workspace-switch");
  });

  it("queues briefly behind a released lock instead of failing busy", async () => {
    const server = host();
    server.serviceGraphLock.tryAcquire({
      operationKind: "session.open",
      requestId: "session-open",
    });
    setTimeout(() => server.serviceGraphLock.release("session-open"), 20);

    const outcome = await withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: () => ({ result: "saved" }),
    });

    expect(outcome).toEqual({ result: "saved" });
    expect(server.serviceGraphLock.getOwner()).toBeNull();
    expect(server.graphOperations.getActive()).toBeNull();
  });

  it("stops waiting when the operation signal aborts and never leaks the lock", async () => {
    const server = host();
    server.serviceGraphLock.tryAcquire({
      operationKind: "session.open",
      requestId: "session-open",
    });

    const pending = withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: () => ({ result: "unreachable" }),
    });
    server.graphOperations.cancelActive("superseded");

    await expect(pending).resolves.toMatchObject({
      error: { code: "SERVICE_GRAPH_BUSY", details: { cancelled: true } },
    });
    expect(server.serviceGraphLock.getOwner()?.requestId).toBe("session-open");
    server.serviceGraphLock.release("session-open");
  });

  it("releases the mutex before finishing when the callback throws", async () => {
    const server = host();
    const cleanupOrder: string[] = [];
    const originalRelease = server.serviceGraphLock.release.bind(server.serviceGraphLock);
    server.serviceGraphLock.release = (requestId?: string) => {
      cleanupOrder.push("release");
      originalRelease(requestId);
    };

    await expect(withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: () => {
        const active = server.graphOperations.getActive();
        active?.completion.then(() => cleanupOrder.push("finish"));
        throw new Error("write failed");
      },
    })).rejects.toThrow("write failed");
    await Promise.resolve();

    expect(cleanupOrder).toEqual(["release", "finish"]);
    expect(server.serviceGraphLock.getOwner()).toBeNull();
    expect(server.graphOperations.getActive()).toBeNull();
  });

  it("delivers cancellation through the operation signal without leaking ownership", async () => {
    const server = host();
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = withRegisteredGraphMutation({
      server,
      operationKind: "provider.mutation",
      requestId: "provider-save",
      run: async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
        return { result: "unreachable" };
      },
    });
    await callbackEntered;

    server.graphOperations.cancelActive("shutdown");
    await expect(pending).rejects.toThrow("shutdown");
    expect(server.serviceGraphLock.getOwner()).toBeNull();
    expect(server.graphOperations.getActive()).toBeNull();
  });
});
