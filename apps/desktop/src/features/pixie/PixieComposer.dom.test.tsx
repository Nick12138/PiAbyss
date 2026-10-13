/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  PixieDispatchRecord,
  SessionSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixiePage } from "./PixiePage";

// jsdom 没有 scrollIntoView；命令补全高亮项滚动依赖它。
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const PIXIE_CWD = "/agent/workspace/pixie";

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

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: PIXIE_CWD,
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
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

/**
 * v5：页面挂载后走 openSessionAcrossWorkspaces 完成跨工作区切换 + 会话打开。
 * 测试里 mock 该模块：把 mock 的 pixie 工作区与会话写进 app store 并返回
 * opened，使页面进入就绪态；activateWorkspaceAcrossWorkspaces（卸载恢复）
 * 同样 mock 掉。
 */
vi.mock("../../lib/bridge/session-navigation", async () => {
  const { useAppStore } = await import("../../lib/stores/app-store");
  return {
    openSessionAcrossWorkspaces: vi.fn(async (target: { cwd: string }) => {
      useAppStore.getState().setWorkspace({
        id: WORKSPACE_ID,
        cwd: target.cwd,
        canonicalCwd: target.cwd,
        revision: 1,
        servicesReady: true,
      });
      useAppStore.getState().applySessionSnapshot(sessionSnapshot());
      return { status: "opened" } as const;
    }),
    activateWorkspaceAcrossWorkspaces: vi.fn(async () => ({ status: "opened" }) as const),
  };
});

const dispatchesMock: PixieDispatchRecord[] = [];

function dispatchRecord(overrides: Partial<PixieDispatchRecord> = {}): PixieDispatchRecord {
  return {
    id: "d1",
    cwd: "/other/ws",
    sessionId: "s-other",
    sessionPath: null,
    task: "check bot",
    status: "dispatched",
    kind: null,
    report: null,
    question: null,
    options: [],
    failCount: 0,
    createdAt: Date.now(),
    startedAt: null,
    lastActiveAt: null,
    model: null,
    thinkingLevel: null,
    batchId: null,
    progressSummary: null,
    files: null,
    stale: false,
    staleNotified: false,
    ...overrides,
  } as PixieDispatchRecord;
}

beforeEach(() => {
  useAppStore.getState().setHost(host());
  // desktopSettings 必须是稳定对象（knownWorkspaces 用 `?? []` 会在每次渲染
  // 新建数组并触发无限循环）。
  useAppStore.setState({
    desktopSettings: {
      theme: "system",
      language: "en",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  dispatchesMock.length = 0;
  usePixieViewStore.setState({
    current: null,
    dispatches: [],
    dispatchesLoaded: false,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
  useAppStore.setState({ desktopSettings: null });
  usePixieViewStore.setState({
    current: null,
    dispatches: [],
    dispatchesLoaded: false,
    error: null,
  });
});

function mockPixieHost() {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "pixie.ensureCurrent") {
      return {
        ok: true,
        result: {
          cwd: PIXIE_CWD,
          sessionId: SESSION_ID,
          sessionPath: "/agent/sessions/pixie/x.jsonl",
        },
      } as never;
    }
    if (method === "pixie.dispatches") {
      return { ok: true, result: { dispatches: [...dispatchesMock] } } as never;
    }
    if (method === "session.getCommands") {
      return { ok: true, result: { commands: [] } } as never;
    }
    if (method === "model.list") {
      return { ok: true, result: { models: [], current: null } } as never;
    }
    return { ok: true, result: null } as never;
  });
}

describe("PixiePage 复用共享 Composer（v5 标准通道）", () => {
  it("挂载时先取锚点，textarea 保留 data-testid=pixie-input，按 Enter 发出 agent.prompt", async () => {
    const request = mockPixieHost();
    const user = userEvent.setup();
    render(<PixiePage />);

    // 锚点请求先于一切。
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pixie.ensureCurrent",
        expect.anything(),
        null,
        expect.anything(),
      ),
    );

    const input = await screen.findByTestId("pixie-input");
    await user.type(input, "你好");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.prompt",
        expect.objectContaining({ expectedSessionId: SESSION_ID }),
        { text: "你好" },
        null,
      ),
    );
  });

  it("有 ask 待回复时，发送改道 pixie.reply", async () => {
    dispatchesMock.push(
      dispatchRecord({ status: "awaiting_user", kind: "ask", question: "选哪个方案？" }),
    );
    const request = mockPixieHost();
    const user = userEvent.setup();
    render(<PixiePage />);

    const input = await screen.findByTestId("pixie-input");
    await user.type(input, "方案 A");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pixie.reply",
        expect.objectContaining({ expectedHostInstanceId: HOST_ID }),
        { dispatchId: "d1", text: "方案 A" },
        expect.anything(),
      ),
    );
    // 不应落到 agent.prompt。
    expect(request).not.toHaveBeenCalledWith(
      "agent.prompt",
      expect.anything(),
      expect.anything(),
      null,
    );
  });

  it("会话弹窗切到另一条会话后不被拉回锚点（host 身份字段更新不得触发 re-acquire）", async () => {
    const request = mockPixieHost();
    render(<PixiePage />);
    await screen.findByTestId("pixie-input");

    const ensureCalls = () =>
      request.mock.calls.filter(([method]) => method === "pixie.ensureCurrent").length;
    expect(ensureCalls()).toBe(1);

    // 模拟用户在会话弹窗里打开另一条会话：session.open 成功后 store 收到的
    // 正是这两笔更新（session 快照 + host 身份字段前进）。host 对象引用因此
    // 改变，但 hostInstanceId 不变——mount-acquire 不应重跑把会话拉回锚点。
    const OTHER_SESSION_ID = "44444444-4444-4444-8444-444444444444";
    act(() => {
      useAppStore
        .getState()
        .applySessionSnapshot(sessionSnapshot({ sessionId: OTHER_SESSION_ID, revision: 7 }));
      useAppStore
        .getState()
        .setHost({ ...host(), sessionId: OTHER_SESSION_ID, sessionRevision: 7 });
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ensureCalls()).toBe(1);
    expect(useAppStore.getState().session?.sessionId).toBe(OTHER_SESSION_ID);
  });
});
