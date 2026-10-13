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
import { PixieNapButton } from "./PixieNapButton";

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
    messages: [],
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
    expect(openSpy).toHaveBeenCalledWith({ cwd: PIXIE_CWD, sessionId: "live-1" });
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

describe("PixieNapButton（空会话禁用打盹）", () => {
  it("没有打开会话时禁用", () => {
    render(<PixieNapButton />);

    const button = screen.getByTestId("pixie-nap-button") as HTMLButtonElement;
    expect(button).toBeDisabled();
  });

  it("空会话（新建会话界面）禁用并给出提示", () => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot());
    render(<PixieNapButton />);

    const button = screen.getByTestId("pixie-nap-button") as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Nothing to nap on yet — say something first");
  });

  it("有消息的会话可以打盹", () => {
    useAppStore
      .getState()
      .applySessionSnapshot(
        sessionSnapshot({ messages: [{ role: "user", content: "hi" }] as never }),
      );
    render(<PixieNapButton />);

    expect(screen.getByTestId("pixie-nap-button")).toBeEnabled();
  });
});
