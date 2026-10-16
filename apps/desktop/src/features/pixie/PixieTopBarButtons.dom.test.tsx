/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore, resetPixiePanelSessionForTests } from "./pixie-store";
import { PixieBackToCurrentButton } from "./PixieBackToCurrentButton";
import { PixiePanelToggleButton } from "./PixiePanelToggleButton";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PIXIE_CWD = "/agent/workspace/pixie";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: WORKSPACE_ID,
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "test",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const workspace: WorkspaceSnapshot = {
  id: WORKSPACE_ID,
  cwd: PIXIE_CWD,
  canonicalCwd: PIXIE_CWD,
  revision: 1,
  servicesReady: true,
};

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "history-1",
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
    // 默认带一条消息：段 = 说过话的会话。空会话（刚点「新会话」）另有断言。
    messages: [{ role: "user", content: "hi" }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: "history-1",
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  } as SessionSnapshot;
}

const openSpy = vi.hoisted(() => vi.fn(async () => ({ status: "opened" }) as const));
const createSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: openSpy,
}));
vi.mock("../../lib/commands/actions", () => ({
  createNewSession: createSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetPixiePanelSessionForTests();
  useAppStore.setState({
    host,
    workspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    desktopSettings: {
      theme: "system",
      language: "en",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({
    current: { cwd: PIXIE_CWD, sessionId: "live-1", sessionPath: `${PIXIE_CWD}/live-1.jsonl` },
    dispatches: [],
    dispatchesLoaded: false,
    dispatchesLoading: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
  useAppStore.setState({ desktopSettings: null });
  usePixieViewStore.setState({
    current: null,
    dispatches: [],
    dispatchesLoaded: false,
    dispatchesLoading: false,
    error: null,
  });
});

function mockEnsureCurrent(
  out: { ok: true; sessionId: string; sessionPath: string } | { ok: false; message: string },
) {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "pixie.ensureCurrent") {
      if (!out.ok) return { ok: false, error: { message: out.message } } as never;
      return {
        ok: true,
        result: { cwd: PIXIE_CWD, sessionId: out.sessionId, sessionPath: out.sessionPath },
      } as never;
    }
    return { ok: true, result: null } as never;
  });
}

describe("PixieBackToCurrentButton（回到最新会话）", () => {
  it("打开的会话就是活段时按钮不出现", () => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot({ sessionId: "live-1" }));
    render(<PixieBackToCurrentButton />);

    expect(screen.queryByTestId("pixie-back-to-current-button")).not.toBeInTheDocument();
  });

  it("刚建出来还没说话的空会话不显示（它还不是段）", () => {
    // 点「新会话」只建出一条空会话：Host 要等用户在里面发出首条消息才认它作当前
    // 段（notePixieUserTurn）。这期间若弹出「回到最新」，用户会以为「点一下新会话
    // 就把当前段切走了」。
    useAppStore
      .getState()
      .applySessionSnapshot(sessionSnapshot({ sessionId: "draft-1", messages: [] }));
    render(<PixieBackToCurrentButton />);

    expect(screen.queryByTestId("pixie-back-to-current-button")).not.toBeInTheDocument();
  });

  it("打开历史会话时出现；点击 ensureCurrent 后标准切回活段", async () => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot({ sessionId: "history-1" }));
    const request = mockEnsureCurrent({
      ok: true,
      sessionId: "live-1",
      sessionPath: `${PIXIE_CWD}/live-1.jsonl`,
    });
    const user = userEvent.setup();
    render(<PixieBackToCurrentButton />);

    await user.click(await screen.findByTestId("pixie-back-to-current-button"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pixie.ensureCurrent",
        expect.anything(),
        null,
        expect.anything(),
      ),
    );
    expect(openSpy).toHaveBeenCalledWith({
      cwd: PIXIE_CWD,
      sessionId: "live-1",
      sessionPath: `${PIXIE_CWD}/live-1.jsonl`,
      quiet: true,
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("拿不到活段时回退到新建会话", async () => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot({ sessionId: "history-1" }));
    mockEnsureCurrent({ ok: false, message: "pixie unavailable" });
    const user = userEvent.setup();
    render(<PixieBackToCurrentButton />);

    await user.click(await screen.findByTestId("pixie-back-to-current-button"));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("PixiePanelToggleButton（随行面板开关）", () => {
  it("开关状态跟着 store 走：点一下收起，再点一下展开", async () => {
    useAppStore.setState({ pixiePanelOpen: true, pixiePanelWide: true });
    const user = userEvent.setup();
    render(<PixiePanelToggleButton />);

    const button = screen.getByTestId("pixie-panel-toggle");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "pixie-side-panel");
    expect(button).toHaveAccessibleName("Collapse panel");

    await user.click(button);

    expect(useAppStore.getState().pixiePanelOpen).toBe(false);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAccessibleName("Expand panel");

    await user.click(button);

    expect(useAppStore.getState().pixiePanelOpen).toBe(true);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("窄容器（pixiePanelWide=false）下开关仍在，管的是浮层抽屉而不是并排那一栏", async () => {
    useAppStore.setState({
      pixiePanelOpen: true,
      pixiePanelWide: false,
      pixiePanelDrawerOpen: false,
    });
    const user = userEvent.setup();
    render(<PixiePanelToggleButton />);

    const button = screen.getByTestId("pixie-panel-toggle");
    expect(button).toHaveAttribute("data-panel-drawer", "true");
    expect(button).toHaveAttribute("aria-expanded", "false");

    // 点它开抽屉，`pixiePanelOpen`（宽容器那份并排展开的记忆）不该跟着动。
    await user.click(button);
    expect(useAppStore.getState().pixiePanelDrawerOpen).toBe(true);
    expect(useAppStore.getState().pixiePanelOpen).toBe(true);
    expect(button).toHaveAttribute("aria-expanded", "true");

    await user.click(button);
    expect(useAppStore.getState().pixiePanelDrawerOpen).toBe(false);
  });
});
