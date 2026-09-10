import { describe, expect, it } from "vitest";
import {
  anchorHostEpoch,
  applySessionSnapshot,
  applyWorkspaceSnapshot,
  beginHostEpoch,
  emptyEpoch,
  noteSequence,
  type EpochState,
} from "./epoch-store.js";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";

const host = (id: string): HostStatusSnapshot =>
  ({
    hostInstanceId: id,
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    protocolVersion: 1,
    sdkVersion: "0.82.1",
    nodeVersion: "v22",
    agentDir: "/tmp",
    phase: "waitingForWorkspace",
    capabilities: {
      packageUpdateCheck: false,
      extensionUi: true,
      sessionExport: false,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  }) as HostStatusSnapshot;

describe("epoch-store", () => {
  it("beginHostEpoch clears prior workspace/session/packages", () => {
    let s = emptyEpoch();
    s = {
      ...s,
      workspace: { id: "old" } as WorkspaceSnapshot,
      session: { sessionId: "s" } as SessionSnapshot,
    };
    s = beginHostEpoch(s, host("h2"));
    expect(s.host?.hostInstanceId).toBe("h2");
    expect(s.workspace).toBeNull();
    expect(s.session).toBeNull();
  });

  it("workspace id change clears session/tools/packages", () => {
    let s = emptyEpoch();
    s = applyWorkspaceSnapshot(s, {
      id: "a",
      cwd: "/a",
      canonicalCwd: "/a",
      revision: 1,
      servicesReady: true,
    });
    s = applySessionSnapshot(s, {
      sessionId: "s1",
      cwd: "/a",
      revision: 1,
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pending: { revision: 0, steering: [], followUp: [] },
      messages: [{ role: "user", content: "hi" }],
      tools: {
        revision: 1,
        workspaceId: "a",
        sessionId: "s1",
        sessionRevision: 1,
        tools: [],
        active: [],
      },
    });
    s = applyWorkspaceSnapshot(s, {
      id: "b",
      cwd: "/b",
      canonicalCwd: "/b",
      revision: 2,
      servicesReady: true,
    });
    expect(s.session).toBeNull();
    expect(s.tools).toBeNull();
  });

  it("anchorHostEpoch keeps the visible epoch and only resets host/sequence", () => {
    let s = beginHostEpoch(emptyEpoch(), host("h1"));
    s = {
      ...s,
      workspace: { id: "w1" } as WorkspaceSnapshot,
      session: { sessionId: "s1" } as SessionSnapshot,
      packages: { workspaceId: "w1", revision: 4 } as unknown as EpochState["packages"],
      tools: { revision: 2 } as unknown as EpochState["tools"],
      desynchronized: true,
      desyncReason: "sequence gap 7 -> 9",
      lastSequence: 9,
    };
    s = anchorHostEpoch(s, host("h2"));
    // Identity and sequence anchor move to the new Host...
    expect(s.host?.hostInstanceId).toBe("h2");
    expect(s.lastSequence).toBe(0);
    // ...but the visible snapshots and the desync marker survive so the UI
    // keeps painting the old state until completeRehydrate swaps it in.
    expect(s.workspace?.id).toBe("w1");
    expect(s.session?.sessionId).toBe("s1");
    expect(s.packages).not.toBeNull();
    expect(s.tools).not.toBeNull();
    expect(s.desynchronized).toBe(true);
    expect(s.desyncReason).toBe("sequence gap 7 -> 9");
  });

  it("sequence gap marks desynchronized and advances lastSequence", () => {
    let s = emptyEpoch();
    s = { ...s, lastSequence: 3 };
    const r = noteSequence(s, 6);
    expect(r.action).toBe("gap");
    expect(r.state.desynchronized).toBe(true);
    // Must advance watermark or every later event re-gaps forever
    expect(r.state.lastSequence).toBe(6);
    const next = noteSequence(r.state, 7);
    // still desync until rehydrate, but sequence action is apply (not gap again)
    expect(next.action).toBe("apply");
    expect(next.state.lastSequence).toBe(7);
  });

  it("null session is authoritative empty", () => {
    let s = emptyEpoch();
    s = applySessionSnapshot(s, {
      sessionId: "s",
      cwd: "/",
      revision: 1,
      isStreaming: false,
      isIdle: true,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pending: { revision: 0, steering: [], followUp: [] },
      messages: [],
      tools: {
        revision: 1,
        workspaceId: "w",
        sessionId: "s",
        sessionRevision: 1,
        tools: [],
        active: [],
      },
    });
    s = applySessionSnapshot(s, null);
    expect(s.session).toBeNull();
    expect(s.tools).toBeNull();
  });
});
