/**
 * SessionList frozen 模式（小精灵页的侧边栏冻结快照）。
 *
 * 小精灵页把活动工作区切到 workspace/pixie、会话目录也被 pixie 快照重建，
 * 侧边栏会话列表改以 frozen 快照渲染：进入小精灵前的工作区目录 + 选中
 * 会话。核心断言：
 *   - 快照条目照常渲染，上一个会话保留选中态，pixie 目录不混入；
 *   - 点击行 = 离开小精灵（openSessionAcrossWorkspaces 切回快照工作区）
 *     并落回 chat 页；导航失败留在原地；
 *   - 不向活动工作区发 session.list（不刷新、不污染冻结目录）；
 *   - 会话 RPC（归档/改名/删除/导出）全部禁用，只剩本地动作（pin/复制）。
 */
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { SessionCatalogEntry } from "../../lib/stores/session-catalog";
import { closeContextMenu } from "../../lib/context-menu";
import { MenuHost } from "../../components/Menu";
import { SessionList, type SessionListFrozenData } from "./SessionList";

const openSpy = vi.hoisted(() => vi.fn(async () => ({ status: "opened" }) as const));

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: openSpy,
  activateWorkspaceAcrossWorkspaces: vi.fn(),
}));

/** 进入小精灵前的工作区（冻结快照归属）。 */
const previousWorkspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/previous",
  canonicalCwd: "/previous",
  revision: 1,
  servicesReady: true,
};

/** 小精灵页期间的活动工作区（pixie）。 */
const pixieWorkspace: WorkspaceSnapshot = {
  id: "pixie-workspace",
  cwd: "/agent/workspace/pixie",
  canonicalCwd: "/agent/workspace/pixie",
  revision: 1,
  servicesReady: true,
};

const pixieSummary: SessionSummary = {
  sessionId: "pixie-1",
  sessionPath: "/agent/workspace/pixie/pixie-1.jsonl",
  name: "Pixie segment",
  cwd: "/agent/workspace/pixie",
  updatedAt: 2,
  messageCount: 4,
};

function frozenEntry(sessionId: string, name: string): SessionCatalogEntry {
  return {
    sessionId,
    sessionPath: `/previous/sessions/${sessionId}.jsonl`,
    name,
    cwd: "/previous",
    updatedAt: 1,
    messageCount: 2,
    runtimeState: "idle",
  };
}

const frozen: SessionListFrozenData = {
  workspace: previousWorkspace,
  items: [frozenEntry("prev-1", "Previous active"), frozenEntry("prev-2", "Another session")],
  activeSessionId: "prev-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  openSpy.mockResolvedValue({ status: "opened" } as never);
  vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
  useAppStore.setState({
    page: "pixie",
    host: { hostInstanceId: "host-1" } as never,
    workspace: pixieWorkspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    sessionCatalog: { workspaceId: null, entries: {}, order: [], loaded: false },
    sessionTerminalStates: {},
    workspaceActivities: {},
  });
  // 活动工作区（pixie）的目录里只有小精灵自己的会话——冻结列表绝不能显示它。
  useAppStore.getState().replaceSessionCatalog(pixieWorkspace.id, [pixieSummary]);
});

afterEach(() => {
  closeContextMenu();
  cleanup();
  useAppStore.setState({ page: "chat", host: null, workspace: null });
  vi.restoreAllMocks();
});

describe("SessionList frozen 模式（小精灵页侧边栏）", () => {
  it("渲染冻结快照，上一个会话保留选中态，pixie 目录不混入", () => {
    render(<SessionList showCreateAction={false} frozen={frozen} />);

    expect(screen.getByText("Previous active")).toBeInTheDocument();
    expect(screen.getByText("Another session")).toBeInTheDocument();
    // pixie 目录里那条不得出现在冻结列表里。
    expect(screen.queryByText("Pixie segment")).not.toBeInTheDocument();

    const activeRow = screen.getByText("Previous active").closest("li");
    expect(activeRow).toHaveAttribute("data-state", "active");
    const inactiveRow = screen.getByText("Another session").closest("li");
    expect(inactiveRow).toHaveAttribute("data-state", "inactive");

    // 冻结期间不向活动工作区拉目录。
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "session.list",
      expect.anything(),
      expect.anything(),
    );
  });

  it("点击会话行：切回快照工作区打开该会话并落回 chat 页", async () => {
    render(<SessionList showCreateAction={false} frozen={frozen} />);

    fireEvent.click(screen.getByText("Another session"));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith({
        cwd: "/previous",
        sessionPath: "/previous/sessions/prev-2.jsonl",
      }),
    );
    await waitFor(() => expect(useAppStore.getState().page).toBe("chat"));
  });

  it("点击选中的那条也照常导航（离开小精灵回到该会话）", async () => {
    render(<SessionList showCreateAction={false} frozen={frozen} />);

    fireEvent.click(screen.getByText("Previous active"));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith({
        cwd: "/previous",
        sessionPath: "/previous/sessions/prev-1.jsonl",
      }),
    );
  });

  it("导航失败时不切页，留在小精灵页", async () => {
    openSpy.mockResolvedValue({ status: "failed" } as never);
    render(<SessionList showCreateAction={false} frozen={frozen} />);

    fireEvent.click(screen.getByText("Another session"));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(useAppStore.getState().page).toBe("pixie");
  });

  it("冻结期间禁用会话 RPC：归档按钮隐藏，右键只剩本地动作可用", async () => {
    render(
      <>
        <MenuHost />
        <SessionList showCreateAction={false} frozen={frozen} />
      </>,
    );

    // 悬停归档按钮隐藏（那是 workspace RPC，会打着 pixie 上下文发出去）。
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("Another session"));

    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Export HTML" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Export JSONL" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    // 纯本地动作仍可用。
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Copy session path" })).toBeEnabled();
  });
});
