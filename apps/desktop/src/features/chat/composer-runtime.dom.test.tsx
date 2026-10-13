/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { useComposerRuntime } from "./composer-runtime";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "test",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(messages: SessionSnapshot["messages"] = []): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages,
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

describe("useComposerRuntime 默认实现（无 Provider）", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
  });

  it("回落到默认实现并暴露 store 的草稿键", () => {
    const { result } = renderHook(() => useComposerRuntime());
    expect(result.current.draftKey).toBe("new:/workspace");
    expect(result.current.host?.hostInstanceId).toBe(HOST_ID);
  });

  it("send 在空闲会话上走 agent.prompt", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: { accepted: true, runId: "r1" } } as never);
    const { result } = renderHook(() => useComposerRuntime());

    await act(async () => {
      const res = await result.current.send({ text: "hi", images: [], attachmentIds: [] });
      expect(res).toEqual({ ok: true });
    });

    expect(request).toHaveBeenCalledWith(
      "agent.prompt",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      { text: "hi" },
      null,
    );
  });

  it("send 在忙会话上走 agent.steer / agent.followUp", async () => {
    useAppStore.getState().applySessionSnapshot({ ...session(), isIdle: false, isStreaming: true });
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: { accepted: true } } as never);
    const { result } = renderHook(() => useComposerRuntime());

    await act(async () => {
      await result.current.send({ text: "queued", images: [], attachmentIds: [] });
    });

    expect(request).toHaveBeenCalledWith(
      "agent.followUp",
      expect.objectContaining({ expectedSessionId: SESSION_ID }),
      { text: "queued" },
    );
  });
});
