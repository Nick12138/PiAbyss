/**
 * Shared-host multi-workspace: events emitted by parked (bound but not
 * active) workspaces must reach the store without triggering recovery, and
 * their terminal markers must be keyed by the owning workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEventEnvelope, HostStatusSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../lib/stores/app-store";
import { handleHostEvent } from "./App";

const HOST_ID = "10000000-0000-4000-8000-000000000001";
const ACTIVE_WS_ID = "22222222-2222-4222-8222-222222222222";
const PARKED_WS_ID = "33333333-3333-4333-8333-333333333333";
const UNBOUND_WS_ID = "44444444-4444-4444-8444-444444444444";

function hostStatus(): HostStatusSnapshot {
  return {
    hostInstanceId: HOST_ID,
    workspaceId: ACTIVE_WS_ID,
    workspaceRevision: 1,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    protocolVersion: 1 as const,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready" as const,
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok" as const, source: "ModelRegistry.getError" },
    boundWorkspaces: [
      { workspaceId: ACTIVE_WS_ID, revision: 1, cwd: "/p/active" },
      { workspaceId: PARKED_WS_ID, revision: 3, cwd: "/p/parked" },
    ],
  };
}

function envelope(
  event: "session.runtimeChanged" | "session.infoChanged",
  overrides: {
    workspaceId?: string | null;
    workspaceRevision?: number;
    sequence?: number;
    sessionId?: string;
    payload?: Record<string, unknown>;
  } = {},
): HostEventEnvelope {
  const sessionId = overrides.sessionId ?? "s-bg";
  const base = {
    protocolVersion: 1 as const,
    event,
    hostInstanceId: HOST_ID,
    workspaceId: overrides.workspaceId ?? PARKED_WS_ID,
    workspaceRevision: overrides.workspaceRevision ?? 3,
    sessionId,
    sessionRevision: 1,
    packageRevision: 0,
    sequence: overrides.sequence ?? 1,
    timestamp: Date.now(),
  };
  if (event === "session.runtimeChanged") {
    return {
      ...base,
      payload: {
        sessionId,
        sessionRevision: 1,
        state: "idle",
        updatedAt: 123,
        ...(overrides.payload ?? {}),
      },
    } as HostEventEnvelope;
  }
  return {
    ...base,
    payload: { sessionId, name: "renamed", ...(overrides.payload ?? {}) },
  } as HostEventEnvelope;
}

function eventBuffer() {
  return { enqueue: vi.fn(), flush: vi.fn() };
}

describe("App cross-workspace event handling", () => {
  let requestRecovery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    requestRecovery = vi.fn();
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      sessionCatalog: { workspaceId: null, entries: {}, order: [], loaded: false },
      sessionRuntimeStates: {},
      sessionTerminalStates: {},
      boundWorkspaces: {},
      notifications: [],
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      lastSequence: 0,
      hostFatal: null,
      connecting: true,
    });
    useAppStore.getState().beginHostEpoch(hostStatus());
    useAppStore.getState().applyWorkspaceSnapshot({
      id: ACTIVE_WS_ID,
      cwd: "/p/active",
      canonicalCwd: "/p/active",
      revision: 1,
      servicesReady: true,
    });
  });

  it("accepts a parked workspace runtimeChanged and marks its own workspace", () => {
    const agentEvents = eventBuffer();
    expect(
      handleHostEvent(
        envelope("session.runtimeChanged", {
          sequence: 1,
          payload: { state: "running" },
        }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);
    expect(
      handleHostEvent(
        envelope("session.runtimeChanged", { sequence: 2 }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);

    expect(requestRecovery).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.desynchronized).toBe(false);
    // Flat runtime state is recorded regardless of ownership.
    expect(state.sessionRuntimeStates["s-bg"]).toBe("idle");
    // The done marker is keyed by the event's owning workspace…
    expect(state.sessionTerminalStates[PARKED_WS_ID]?.["s-bg"]).toEqual({
      state: "done",
      acknowledged: false,
    });
    // …never by the active one.
    expect(state.sessionTerminalStates[ACTIVE_WS_ID]?.["s-bg"]).toBeUndefined();
    // The active workspace's Session Catalog is not touched by parked events.
    expect(state.sessionCatalog.entries["s-bg"]).toBeUndefined();
  });

  it("accepts a parked workspace infoChanged without recovery", () => {
    const agentEvents = eventBuffer();
    expect(
      handleHostEvent(
        envelope("session.infoChanged", { sessionId: "s-bg" }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(useAppStore.getState().desynchronized).toBe(false);
  });

  it("still rejects runtimeChanged from a workspace that is not bound", () => {
    const agentEvents = eventBuffer();
    expect(
      handleHostEvent(
        envelope("session.runtimeChanged", { workspaceId: UNBOUND_WS_ID }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(false);
    expect(requestRecovery).toHaveBeenCalledWith(
      expect.stringContaining("identity mismatch for session.runtimeChanged"),
    );
    expect(useAppStore.getState().desynchronized).toBe(true);
    expect(useAppStore.getState().sessionTerminalStates[PARKED_WS_ID]?.["s-bg"]).toBeUndefined();
  });

  it("still rejects a parked event from a different Host instance", () => {
    const agentEvents = eventBuffer();
    const foreign = envelope("session.runtimeChanged");
    (foreign as { hostInstanceId: string }).hostInstanceId = "99999999-9999-4999-8999-999999999999";
    expect(handleHostEvent(foreign, requestRecovery, agentEvents)).toBe(false);
    expect(requestRecovery).toHaveBeenCalled();
    expect(useAppStore.getState().desynchronized).toBe(true);
  });

  it("keeps the active workspace runtimeChanged path unchanged", () => {
    const agentEvents = eventBuffer();
    const active = (sequence: number, state: string) =>
      envelope("session.runtimeChanged", {
        workspaceId: ACTIVE_WS_ID,
        workspaceRevision: 1,
        sequence,
        sessionId: "s-active",
        payload: { state },
      });
    expect(handleHostEvent(active(1, "running"), requestRecovery, agentEvents)).toBe(true);
    expect(handleHostEvent(active(2, "idle"), requestRecovery, agentEvents)).toBe(true);

    expect(requestRecovery).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.sessionTerminalStates[ACTIVE_WS_ID]?.["s-active"]).toEqual({
      state: "done",
      acknowledged: false,
    });
    expect(state.sessionTerminalStates[PARKED_WS_ID]).toBeUndefined();
  });

  it("replaces the bound-workspace map from host.statusChanged", () => {
    const agentEvents = eventBuffer();
    const statusChanged = {
      protocolVersion: 1 as const,
      event: "host.statusChanged" as const,
      hostInstanceId: HOST_ID,
      workspaceId: ACTIVE_WS_ID,
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        ...hostStatus(),
        boundWorkspaces: [
          { workspaceId: ACTIVE_WS_ID, revision: 1, cwd: "/p/active" },
          { workspaceId: UNBOUND_WS_ID, revision: 5, cwd: "/p/other" },
        ],
      },
    };
    expect(handleHostEvent(statusChanged, requestRecovery, agentEvents)).toBe(true);
    expect(useAppStore.getState().boundWorkspaces).toEqual({
      [ACTIVE_WS_ID]: { revision: 1, cwd: "/p/active" },
      [UNBOUND_WS_ID]: { revision: 5, cwd: "/p/other" },
    });

    // A status without the field (older Host) must not clear known bindings.
    const { boundWorkspaces: _omitted, ...olderStatus } = statusChanged.payload;
    expect(
      handleHostEvent(
        { ...statusChanged, sequence: 2, payload: olderStatus },
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);
    expect(useAppStore.getState().boundWorkspaces[UNBOUND_WS_ID]).toBeDefined();
  });

  it("accepts a newly bound workspace's events after its statusChanged arrived", () => {
    const agentEvents = eventBuffer();
    const statusChanged = {
      protocolVersion: 1 as const,
      event: "host.statusChanged" as const,
      hostInstanceId: HOST_ID,
      workspaceId: ACTIVE_WS_ID,
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 0,
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        ...hostStatus(),
        boundWorkspaces: [{ workspaceId: UNBOUND_WS_ID, revision: 5, cwd: "/p/other" }],
      },
    };
    handleHostEvent(statusChanged, requestRecovery, agentEvents);

    // A busy→idle edge across the newly bound workspace creates its own marker.
    expect(
      handleHostEvent(
        envelope("session.runtimeChanged", {
          workspaceId: UNBOUND_WS_ID,
          sequence: 2,
          payload: { state: "running" },
        }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);
    expect(
      handleHostEvent(
        envelope("session.runtimeChanged", { workspaceId: UNBOUND_WS_ID, sequence: 3 }),
        requestRecovery,
        agentEvents,
      ),
    ).toBe(true);
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionTerminalStates[UNBOUND_WS_ID]?.["s-bg"]).toEqual({
      state: "done",
      acknowledged: false,
    });
  });
});
