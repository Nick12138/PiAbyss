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
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { useAppStore } from "../../lib/stores/app-store";
import { resetPixiePanelSessionForTests, usePixieViewStore } from "./pixie-store";
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
  resetPixiePanelSessionForTests();
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
  resetPixiePanelSessionForTests();
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
  return mockPixieHostWithParams();
}

/** 同 mockPixieHost，但每次 pixie.dispatches 调用把 params 交给 onDispatches（归属断言用）。 */
function mockPixieHostWithParams(onDispatches?: (params: unknown) => void) {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method, _ctx, params) => {
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
      onDispatches?.(params);
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

/* ------------------------------------------------------------------ */
/* 提问工具与子代理视图适配：pixie 页挂载面与 ChatPage 对齐。            */
/* ------------------------------------------------------------------ */

const EXT_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

/** 内嵌呈现的 confirm 决策（ask_user_question 问卷之外最常见的 inline 形态）。 */
function inlineConfirmRequest(): ExtensionUiRequestState {
  return {
    requestId: "44444444-4444-4444-8444-000000000001",
    kind: "confirm",
    title: "Continue with the risky step?",
    presentation: "inline",
    context: EXT_CONTEXT,
  } as unknown as ExtensionUiRequestState;
}

function subagentRunsStatus() {
  return {
    version: 1 as const,
    available: true,
    generatedAt: 1,
    totalActive: 1,
    omitted: 0,
    fleet: [],
    runs: [{ id: "run-1", kind: "subagent", label: "Scout task", state: "running" }] as never,
  };
}

const EMPTY_SUBAGENTS_STATUS = {
  version: 1 as const,
  available: false,
  generatedAt: 0,
  totalActive: 0,
  omitted: 0,
  fleet: [],
  runs: [],
};

describe("PixiePage 适配提问与子代理（对齐 ChatPage 挂载面）", () => {
  afterEach(() => {
    useAppStore.setState({
      activeSubagentNodeId: null,
      extensionUiRequest: null,
      subagentsStatus: EMPTY_SUBAGENTS_STATUS,
    });
  });

  it("扩展 UI 请求（如 ask_user_question）在 pixie 页就地渲染内嵌卡片", async () => {
    mockPixieHost();
    render(<PixiePage />);
    await screen.findByTestId("pixie-input");

    act(() => {
      useAppStore.setState({ extensionUiRequest: inlineConfirmRequest() });
    });

    // 内嵌问题卡片必须出现——否则 Composer 被 decisionBlocked 锁死且无处可答。
    expect(document.querySelector('[data-extension-ui-surface="inline"]')).not.toBeNull();
    expect(screen.getByText("Continue with the risky step?")).toBeInTheDocument();
  });

  it("activeSubagentNodeId 时渲染子代理对话视图，主输入框让位", async () => {
    mockPixieHost();
    useAppStore.setState({
      activeSubagentNodeId: "run-1",
      subagentsStatus: subagentRunsStatus(),
    });
    render(<PixiePage />);

    await waitFor(() => {
      expect(document.querySelector("[data-subagent-conversation]")).not.toBeNull();
    });
    expect(screen.queryByTestId("pixie-input")).not.toBeInTheDocument();
  });

  it("卸载 pixie 页时丢弃子代理视图状态（不残留到 chat 页）", async () => {
    mockPixieHost();
    useAppStore.setState({
      activeSubagentNodeId: "run-1",
      subagentsStatus: subagentRunsStatus(),
    });
    const { unmount } = render(<PixiePage />);
    await waitFor(() => {
      expect(document.querySelector("[data-subagent-conversation]")).not.toBeNull();
    });

    unmount();

    expect(useAppStore.getState().activeSubagentNodeId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 委派面板分层（瘦身重构）：活跃详细卡置顶，终态记录进历史折叠区。      */
/* ------------------------------------------------------------------ */

describe("PixiePage 委派面板分层", () => {
  afterEach(() => {
    useAppStore.setState({ activeSubagentNodeId: null, extensionUiRequest: null });
  });

  it("活跃记录直接渲染详细卡；终态记录收进历史折叠区，展开行可再看详情", async () => {
    const user = userEvent.setup();
    dispatchesMock.push(
      dispatchRecord({ id: "d-run", status: "dispatched" }),
      dispatchRecord({
        id: "d-done",
        status: "reported",
        kind: "done",
        report: "干完了",
        lastActiveAt: Date.now() - 120_000,
      }),
    );
    mockPixieHost();
    render(<PixiePage />);
    await screen.findByTestId("pixie-input");

    // 活跃区：只有 running 那张详细卡；历史默认收起。
    const cards = document.querySelectorAll('[data-testid="pixie-dispatch-card"]');
    expect(cards.length).toBe(1);
    const toggle = screen.getByTestId("pixie-history-toggle");
    expect(toggle.textContent).toContain("1");

    await user.click(toggle);
    const row = screen.getByTestId("pixie-dispatch-history-row");
    expect(row).toBeInTheDocument();
    // 详情默认收起：展开行后出现完整卡（含回调正文与 retry 动作区）。
    expect(document.querySelectorAll('[data-testid="pixie-dispatch-card"]').length).toBe(1);
    await user.click(row.querySelector("button")!);
    expect(document.querySelectorAll('[data-testid="pixie-dispatch-card"]').length).toBe(2);
  });

  it("切换会话后面板归属跟随：pixie.dispatches 带上当前打开的 sessionId 重新拉取", async () => {
    const seenParams: Array<string | null | undefined> = [];
    mockPixieHostWithParams((params) => {
      seenParams.push((params as { sessionId?: string | null } | null)?.sessionId ?? null);
    });
    render(<PixiePage />);
    await screen.findByTestId("pixie-input");

    // 首次拉取归属 = 打开的会话。
    await waitFor(() => expect(seenParams).toContain(SESSION_ID));

    // 用户在会话弹窗里切到另一条会话（session.open 后的两笔 store 更新）。
    const OTHER_SESSION_ID = "44444444-4444-4444-8444-444444444444";
    act(() => {
      useAppStore
        .getState()
        .applySessionSnapshot(sessionSnapshot({ sessionId: OTHER_SESSION_ID, revision: 7 }));
      useAppStore
        .getState()
        .setHost({ ...host(), sessionId: OTHER_SESSION_ID, sessionRevision: 7 });
    });

    // 面板必须立即改用新会话作为归属重新拉取。
    await waitFor(() => {
      const last = seenParams[seenParams.length - 1];
      expect(last).toBe(OTHER_SESSION_ID);
    });
  });
});
