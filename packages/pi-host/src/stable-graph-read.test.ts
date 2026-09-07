import { createHostError } from "@piabyss/protocol";
import { describe, expect, it, vi } from "vitest";
import { withStableGraphRead } from "./stable-graph-read.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";

describe("withStableGraphRead", () => {
  it("returns captured identity after successful read", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 2;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r1",
      identity,
      serviceGraphLock: lock,
      run: async () => ({ items: [1] }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.identity.workspaceId).toBe("w1");
      expect(out.identity.workspaceRevision).toBe(2);
      expect(out.result).toEqual({ items: [1] });
    }
    expect(lock.isHeld()).toBe(false);
  });

  it("waits for a current graph owner before reading", async () => {
    const identity = new IdentityState();
    const lock = new TryMutex();
    lock.tryAcquire({ operationKind: "package.mutation", requestId: "other" });
    let readStarted = false;
    const pending = withStableGraphRead({
      requestId: "r2",
      identity,
      serviceGraphLock: lock,
      run: async () => {
        readStarted = true;
        return 1;
      },
    });

    await Promise.resolve();
    expect(readStarted).toBe(false);
    lock.release("other");

    const out = await pending;
    expect(out.ok).toBe(true);
    expect(readStarted).toBe(true);
    expect(lock.isHeld()).toBe(false);
  });

  it("allows a slower SDK read owner to finish without surfacing graph busy", async () => {
    vi.useFakeTimers();
    try {
      const identity = new IdentityState();
      const lock = new TryMutex();
      lock.tryAcquire({ operationKind: "sdk.read", requestId: "first-read" });
      let settled = false;
      const pending = withStableGraphRead({
        requestId: "queued-read",
        identity,
        serviceGraphLock: lock,
        run: async () => "ready",
      }).then((out) => {
        settled = true;
        return out;
      });

      await vi.advanceTimersByTimeAsync(251);
      expect(settled).toBe(false);
      lock.release("first-read");

      const out = await pending;
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toBe("ready");
      expect(lock.isHeld()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the short default deadline behind a graph mutation", async () => {
    vi.useFakeTimers();
    try {
      const identity = new IdentityState();
      const lock = new TryMutex();
      lock.tryAcquire({ operationKind: "package.mutation", requestId: "install" });
      const pending = withStableGraphRead({
        requestId: "blocked-read",
        identity,
        serviceGraphLock: lock,
        run: async () => 1,
      });

      await vi.advanceTimersByTimeAsync(250);
      const out = await pending;
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("SERVICE_GRAPH_BUSY");
      lock.release("install");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns SERVICE_GRAPH_BUSY after the bounded lock wait expires", async () => {
    vi.useFakeTimers();
    try {
      const identity = new IdentityState();
      const lock = new TryMutex();
      lock.tryAcquire({ operationKind: "package.mutation", requestId: "other" });
      let settled = false;
      const pending = withStableGraphRead({
        requestId: "r2-timeout",
        identity,
        serviceGraphLock: lock,
        lockTimeoutMs: 50,
        run: async () => 1,
      }).then((out) => {
        settled = true;
        return out;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const out = await pending;
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("SERVICE_GRAPH_BUSY");
      expect(lock.getOwner()?.requestId).toBe("other");
      lock.release("other");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks request validity after waiting for the graph lock", async () => {
    const identity = new IdentityState();
    const lock = new TryMutex();
    lock.tryAcquire({ operationKind: "package.mutation", requestId: "other" });
    let stale = false;
    let readStarted = false;
    const pending = withStableGraphRead({
      requestId: "r2-stale",
      identity,
      serviceGraphLock: lock,
      precheck: () =>
        stale ? createHostError("STALE_REVISION", "Request identity changed") : null,
      run: async () => {
        readStarted = true;
        return 1;
      },
    });

    stale = true;
    lock.release("other");

    const out = await pending;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("STALE_REVISION");
    expect(readStarted).toBe(false);
    expect(lock.isHeld()).toBe(false);
  });

  it("returns STALE_REVISION if graph revision changes during await", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 1;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r3",
      identity,
      serviceGraphLock: lock,
      run: async () => {
        identity.bumpWorkspaceRevision();
        return "data";
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("STALE_REVISION");
    expect(lock.isHeld()).toBe(false);
  });

  it("concurrent switch cannot re-label old data with new identity (barrier)", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "A";
    identity.workspaceRevision = 1;
    const lock = new TryMutex();

    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    let readEntered = false;

    const readPromise = withStableGraphRead({
      requestId: "read-a",
      identity,
      serviceGraphLock: lock,
      run: async () => {
        readEntered = true;
        await readGate;
        return { cwd: "A-data" };
      },
    });

    // Wait until read holds lock
    while (!readEntered) {
      await new Promise((r) => setTimeout(r, 1));
    }

    // Concurrent workspace switch bumps revision while read is mid-await
    // (switch would take serviceGraphLock in real code; here we simulate identity change)
    identity.workspaceId = "B";
    identity.workspaceRevision = 2;
    releaseRead();

    const out = await readPromise;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("STALE_REVISION");
      // Must not return A-data under B identity
      expect(out.identity.workspaceId).toBe("B");
    }
    expect(lock.isHeld()).toBe(false);
  });

  it("successful read identity matches pre-await capture, not post-mutation host", async () => {
    const identity = new IdentityState();
    identity.workspaceId = "w1";
    identity.workspaceRevision = 5;
    identity.packageRevision = 3;
    const lock = new TryMutex();
    const out = await withStableGraphRead({
      requestId: "r4",
      identity,
      serviceGraphLock: lock,
      run: async () => ({ listed: true }),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.identity.workspaceRevision).toBe(5);
      expect(out.identity.packageRevision).toBe(3);
    }
  });
});
