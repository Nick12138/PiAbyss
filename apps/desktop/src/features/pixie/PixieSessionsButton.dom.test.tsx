/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  SessionSummary,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { PixieSessionsButton } from "./PixieSessionsButton";

const summary: SessionSummary = {
  sessionId: "session-1",
  sessionPath: "/sessions/session-1.jsonl",
  name: "Position the menu",
  cwd: "/workspace",
  updatedAt: 1,
  messageCount: 1,
};

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

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

beforeEach(() => {
  useAppStore.setState({
    host,
    workspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    sessionCatalog: { workspaceId: null, entries: {}, order: [], loaded: false },
    sessionTerminalStates: {},
    workspaceActivities: {},
    // 稳定对象：knownWorkspaces 用 `?? []` 会在每次渲染新建数组并触发无限循环。
    desktopSettings: {
      theme: "system",
      language: "en",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  useAppStore.getState().replaceSessionCatalog(workspace.id, [summary]);
  vi.spyOn(hostClient, "request").mockResolvedValue({
    ok: true,
    result: { items: [summary] },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.setState({ desktopSettings: null });
});

describe("PixieSessionsButton 点击浮层", () => {
  it("悬停不打开（只有点击才展开，鼠标扫过顶栏不误弹）", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);

    await user.hover(screen.getByTestId("pixie-sessions-button"));

    expect(screen.queryByTestId("pixie-sessions-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("pixie-sessions-button")).toHaveAttribute("aria-expanded", "false");
  });

  it("点击后在按钮下方浮出非模态面板（挂 body、无遮罩）", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);
    const button = screen.getByTestId("pixie-sessions-button");

    await user.click(button);

    const panel = await screen.findByTestId("pixie-sessions-panel");
    // 浮层 portal 到 body（脱离顶栏的拖拽区/裁切），且不是全屏模态弹窗：
    // 没有遮罩、没有 aria-modal、没有焦点陷阱。
    expect(panel.parentElement).toBe(document.body);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", panel.id);
    // 复用标准 SessionList：会话行在面板内。
    expect(within(panel).getByText("Position the menu")).toBeInTheDocument();
  });

  it("面板右边缘贴住按钮右边缘（不随面板内容宽度漂移）", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);
    const button = screen.getByTestId("pixie-sessions-button");
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 830,
      right: 900,
      top: 20,
      bottom: 40,
      width: 70,
      height: 20,
    } as DOMRect);

    await user.click(button);

    const panel = await screen.findByTestId("pixie-sessions-panel");
    // 锚定用 right 而非 left：面板只有 max-width，宽度会随会话名收缩，
    // 按 left = rect.right - maxWidth 定位时窄面板会整体飘离按钮。
    expect(panel.style.right).toBe(`${window.innerWidth - 900}px`);
    expect(panel.style.left).toBe("");
    expect(panel.style.top).toBe("46px");
    expect(panel.style.maxWidth).toBe("320px");
  });

  it("再点一次按钮即收起（toggle）", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);
    const button = screen.getByTestId("pixie-sessions-button");
    await user.click(button);
    await screen.findByTestId("pixie-sessions-panel");

    await user.click(button);

    await waitFor(() =>
      expect(screen.queryByTestId("pixie-sessions-panel")).not.toBeInTheDocument(),
    );
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("点击面板外部收起", async () => {
    const user = userEvent.setup();
    render(
      <>
        <div data-testid="outside" className="p-4">
          elsewhere
        </div>
        <PixieSessionsButton />
      </>,
    );
    await user.click(screen.getByTestId("pixie-sessions-button"));
    await screen.findByTestId("pixie-sessions-panel");

    await user.click(screen.getByTestId("outside"));

    await waitFor(() =>
      expect(screen.queryByTestId("pixie-sessions-panel")).not.toBeInTheDocument(),
    );
  });

  it("Esc 收起面板", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);
    await user.click(screen.getByTestId("pixie-sessions-button"));
    await screen.findByTestId("pixie-sessions-panel");

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("pixie-sessions-panel")).not.toBeInTheDocument(),
    );
  });

  it("面板内没有新建会话按钮，也没有“最近会话”标题行", async () => {
    const user = userEvent.setup();
    render(<PixieSessionsButton />);
    await user.click(screen.getByTestId("pixie-sessions-button"));
    const panel = await screen.findByTestId("pixie-sessions-panel");

    expect(within(panel).queryByTestId("pixie-new-session-button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "New session" })).not.toBeInTheDocument();
    expect(within(panel).queryByText("Recent conversations")).not.toBeInTheDocument();
    expect(within(panel).getByTestId("session-list-flat")).toBeInTheDocument();
  });
});
