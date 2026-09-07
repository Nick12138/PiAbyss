import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostIdentity, SubagentsStatusSnapshot } from "@piabyss/protocol";
import { createSubagentStatusBridge } from "./subagent-status-extension.js";
import { getSubagentApi, type SubagentHttpRunSummary } from "./subagent-api.js";

vi.mock("./subagent-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-api.js")>();
  return {
    ...actual,
    getSubagentApi: vi.fn(),
    postSubagentApi: vi.fn(),
  };
});

function run(overrides: Partial<SubagentHttpRunSummary> = {}): SubagentHttpRunSummary {
  return {
    id: "run_1",
    title: "explore auth",
    agent: "scout",
    // Matches the identity session id used in the tests below.
    sessionId: "s",
    status: "running",
    statusLabel: "运行中",
    createdAt: 1,
    resumeCount: 0,
    retryLeft: 1,
    worktree: false,
    outputPreview: "",
    cost: 0,
    turns: 0,
    ...overrides,
  };
}

/**
 * Regression: installing pi-subagent mid-session triggers an SDK
 * agentSession.reload(), which re-invokes the inline bridge extension factory
 * (bumping its generation). The session lifecycle only calls setIdentity /
 * markReady on create/open, so without re-arming the generation gate every
 * publish after the reload was dropped and the panel stayed on the stale
 * pre-install "pi-subagent not detected" state.
 */
describe("createSubagentStatusBridge reload resilience", () => {
  function harness(runs: SubagentHttpRunSummary[] | null) {
    const lifecycle = new Map<string, Array<(data: unknown) => void>>();
    const api: ExtensionAPI = {
      on(event: string, cb: (data: unknown) => void) {
        const list = lifecycle.get(event) ?? [];
        list.push(cb);
        lifecycle.set(event, list);
        return () => {
          const cur = lifecycle.get(event) ?? [];
          lifecycle.set(
            event,
            cur.filter((fn) => fn !== cb),
          );
        };
      },
    } as unknown as ExtensionAPI;

    const fire = (event: string, data: unknown) => {
      for (const cb of lifecycle.get(event) ?? []) cb(data);
    };
    const getMock = vi.mocked(getSubagentApi);
    getMock.mockResolvedValue(
      runs === null ? null : ({ runs, runsRoot: "/tmp/runs" } as never),
    );
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { api, fire, flush, getMock };
  }

  beforeEach(() => {
    vi.mocked(getSubagentApi).mockReset();
  });

  afterEach(() => {
    vi.mocked(getSubagentApi).mockReset();
  });

  const identity = (): HostIdentity => ({
    hostInstanceId: "h",
    workspaceId: "w",
    workspaceRevision: 1,
    sessionId: "s",
    sessionRevision: 1,
    packageRevision: 0,
  });

  it("re-arms the generation gate and resumes polling after a mid-session factory re-invocation", async () => {
    const emitted: Array<{ identity: HostIdentity; snapshot: SubagentsStatusSnapshot }> = [];
    const bridge = createSubagentStatusBridge((identity, snapshot) => {
      emitted.push({ identity, snapshot });
    });
    const h = harness([run()]);

    // Session create: factory invoked once, identity committed, ready.
    bridge.extension(h.api);
    bridge.setIdentity(identity());
    bridge.markReady();
    h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.flush();
    expect(emitted.at(-1)?.snapshot).toMatchObject({ available: true, totalActive: 1 });

    // pi-subagent is now installed. The SDK reloads: session_shutdown on the
    // old runner, factory re-invocation (generation bump), then a reloaded
    // session_start during which the plugin's HTTP API becomes reachable. The
    // package controller then bumps the session revision and re-commits the
    // bridge identity (setIdentity) before publishing session.snapshot, and
    // calls markReady afterwards.
    h.fire("session_shutdown", {});
    bridge.extension(h.api);
    h.fire("session_start", { type: "session_start", reason: "reload" });
    const bumped = { ...identity(), sessionRevision: 2 };
    bridge.setIdentity(bumped);
    bridge.markReady();
    await h.flush();

    // The availability flip must reach the desktop, stamped with the current
    // identity so the workspace-level identity match accepts it.
    const last = emitted.at(-1);
    expect(last?.snapshot).toMatchObject({ available: true });
    expect(last?.identity).toEqual(bumped);
  });

  it("keeps polling after a resource-loader-only reload (no session_start follows)", async () => {
    const emitted: SubagentsStatusSnapshot[] = [];
    const bridge = createSubagentStatusBridge((_identity, snapshot) => {
      emitted.push(snapshot);
    });
    const h = harness([run({ status: "running" })]);

    bridge.extension(h.api);
    bridge.setIdentity(identity());
    bridge.markReady();
    h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.flush();
    expect(emitted.at(-1)).toMatchObject({ available: true });

    // Skill-mutation style reload: the resource loader re-invokes the factory
    // but the running session is not rebuilt, so no session_start fires.
    const callsBefore = h.getMock.mock.calls.length;
    bridge.extension(h.api);
    await h.flush();

    expect(h.getMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(emitted.at(-1)).toMatchObject({ available: true });
  });

  it("does not re-arm the gate when the previous instance was never live (fresh graph)", async () => {
    const emit = vi.fn();
    const bridge = createSubagentStatusBridge((_identity, snapshot) => {
      emit(snapshot);
    });
    const h = harness([run()]);

    // First invocation with no session yet: must not emit.
    bridge.extension(h.api);
    expect(emit).not.toHaveBeenCalled();

    // A second invocation before any session lifecycle (e.g. reload with no
    // active session) must also stay silent: identity is null.
    bridge.extension(h.api);
    await h.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps polling after a belated shutdown of a retained session (promotion re-points the bridge)", async () => {
    vi.useFakeTimers();
    try {
      const emitted: Array<{ identity: HostIdentity; snapshot: SubagentsStatusSnapshot }> = [];
      const bridge = createSubagentStatusBridge((identity, snapshot) => {
        emitted.push({ identity, snapshot });
      });
      const h = harness([run()]);

      // Session B is created and bound: factory invoked once, identity B
      // ready, polling starts under the single active generation.
      bridge.extension(h.api);
      bridge.setIdentity(identity());
      bridge.markReady();
      h.fire("session_start", { type: "session_start", reason: "startup" });
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted.at(-1)?.snapshot).toMatchObject({ available: true });

      // The user switches back to idle-cached session A: promoteBackgroundRuntime
      // re-points the bridge without re-invoking the factory (same generation).
      const promoted = { ...identity(), sessionId: "a", sessionRevision: 2 };
      bridge.setIdentity(promoted);
      bridge.markReady();

      // Later, retained session B is disposed; its runner fires session_shutdown
      // under the still-active generation. The bridge must keep polling with
      // the promoted identity instead of freezing on an unavailable snapshot.
      const callsBefore = h.getMock.mock.calls.length;
      h.fire("session_shutdown", {});
      await vi.advanceTimersByTimeAsync(800);

      expect(h.getMock.mock.calls.length).toBeGreaterThan(callsBefore);
      const last = emitted.at(-1);
      expect(last?.identity).toEqual(promoted);
      expect(last?.snapshot).toMatchObject({ available: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when a shutdown fires with no identity bound", async () => {
    const emit = vi.fn();
    const bridge = createSubagentStatusBridge(emit);
    const h = harness([run()]);

    // A generation whose identity was never bound (e.g. a fresh graph with no
    // session yet) must still honor shutdown: polling stays off and nothing
    // is published.
    bridge.extension(h.api);
    h.fire("session_shutdown", {});
    await h.flush();
    expect(emit).not.toHaveBeenCalled();
    expect(h.getMock).not.toHaveBeenCalled();
  });

  it("degrades to unavailable when the plugin HTTP API is unreachable", async () => {
    const emitted: SubagentsStatusSnapshot[] = [];
    const bridge = createSubagentStatusBridge((_identity, snapshot) => {
      emitted.push(snapshot);
    });
    const h = harness(null);

    bridge.extension(h.api);
    bridge.setIdentity(identity());
    bridge.markReady();
    h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.flush();

    expect(emitted.at(-1)).toMatchObject({ available: false, runs: [] });
  });
});
