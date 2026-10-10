import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, MemoNote } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { openMemoWithAgent, openMemoWithAgentById } from "./memo-agent";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.82.1",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  return {
    id: "memo-1",
    type: "memo",
    title: "交给 Agent",
    contentMd: "交给 Agent\n正文",
    status: "open",
    sessionId: null,
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("memo-agent（交给 Agent 处理）", () => {
  beforeEach(() => {
    const pushNotification = vi.fn();
    useAppStore.setState({
      host,
      workspace: null,
      session: null,
      desktopSettings: null,
      page: "chat",
      pushNotification: pushNotification as any,
    });
  });

  it("没有活动工作区时提示警告，不切页、不抛错", async () => {
    await expect(openMemoWithAgent(note())).resolves.toBeUndefined();
    const state = useAppStore.getState();
    // 文案随语言环境变化（zh「工作区」/ en "workspace"），只断言级别与形态。
    expect(state.pushNotification).toHaveBeenCalledWith(expect.any(String), "warning");
    expect(state.page).toBe("chat");
  });

  it("openMemoWithAgentById 在 Host 未就绪（拉取列表失败）时静默返回", async () => {
    useAppStore.setState({ host: null, workspace: null });
    await expect(openMemoWithAgentById("memo-1")).resolves.toBeUndefined();
    expect(useAppStore.getState().pushNotification).not.toHaveBeenCalled();
  });
});
