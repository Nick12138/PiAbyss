import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "@piabyss/protocol";

const buildSessionSnapshotMock = vi.fn();
vi.mock("./session-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-snapshot.js")>();
  return {
    ...actual,
    buildSessionSnapshot: (...args: unknown[]) => buildSessionSnapshotMock(...args),
  };
});

import {
  clearSessionModel,
  isPiAbyssNoModel,
  publishIdleActiveSessionSnapshot,
} from "./no-model.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

describe("isPiAbyssNoModel", () => {
  it("recognizes the no-model sentinel", () => {
    expect(isPiAbyssNoModel({ provider: "unknown", id: "unknown" })).toBe(true);
  });

  it("rejects real models, partial matches and empty input", () => {
    expect(isPiAbyssNoModel({ provider: "custom", id: "primary" })).toBe(false);
    expect(isPiAbyssNoModel({ provider: "unknown", id: "primary" })).toBe(false);
    expect(isPiAbyssNoModel({ provider: "custom", id: "unknown" })).toBe(false);
    expect(isPiAbyssNoModel(null)).toBe(false);
    expect(isPiAbyssNoModel(undefined)).toBe(false);
  });
});

describe("clearSessionModel", () => {
  it("delegates to the SDK clearModel on the session", async () => {
    const clearModel = vi.fn(async () => undefined);
    const session = { clearModel } as unknown as AgentSession;
    await clearSessionModel(session);
    expect(clearModel).toHaveBeenCalledTimes(1);
  });
});

describe("publishIdleActiveSessionSnapshot", () => {
  beforeEach(() => {
    buildSessionSnapshotMock.mockReset();
  });

  function fixture() {
    const current = { sessionId: "session-1", revision: 5 } as unknown as SessionSnapshot;
    const session = {
      model: { provider: "unknown", id: "unknown" },
    } as unknown as AgentSession;
    const sessionManager = {} as unknown as SessionManager;
    const graph: {
      agentSession: AgentSession;
      sessionManager: SessionManager;
      sessionSnapshot: SessionSnapshot | null;
      canonicalCwd: string;
      workspaceId: string;
      toolRevision: number;
    } = {
      agentSession: session,
      sessionManager,
      sessionSnapshot: current,
      canonicalCwd: "/cwd",
      workspaceId: "ws-1",
      toolRevision: 2,
    };
    const emit = vi.fn();
    const server = { emit } as unknown as {
      emit: ReturnType<typeof vi.fn>;
    };
    const factory = {
      getGraph: () => graph,
      server,
    } as unknown as WorkspaceGraphFactory;
    return { current, graph, emit, factory };
  }

  it("rebuilds the snapshot and emits session.snapshot without bumping revision", () => {
    const { current, graph, emit, factory } = fixture();
    const rebuilt = { sessionId: "session-1", revision: 5, model: undefined };
    buildSessionSnapshotMock.mockReturnValue(rebuilt);

    publishIdleActiveSessionSnapshot(factory);

    expect(buildSessionSnapshotMock).toHaveBeenCalledWith({
      session: graph.agentSession,
      sessionManager: graph.sessionManager,
      cwd: "/cwd",
      sessionId: "session-1",
      revision: 5,
      workspaceId: "ws-1",
      toolRevision: 2,
    });
    expect(graph.sessionSnapshot).toBe(rebuilt);
    expect(emit).toHaveBeenCalledWith("session.snapshot", rebuilt);
    // Revision stays the same — this is not a session switch.
    expect(current.revision).toBe(5);
  });

  it("is a no-op when the graph lacks snapshot parts", () => {
    const { graph, emit, factory } = fixture();
    graph.sessionSnapshot = null;
    publishIdleActiveSessionSnapshot(factory);
    expect(buildSessionSnapshotMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
