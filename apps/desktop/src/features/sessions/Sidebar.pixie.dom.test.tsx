/**
 * 小精灵页的侧边栏整体接线（jsdom）：冻结快照就位时，会话列表与上一个
 * 工作区的选中态都要照常显示。
 *
 * 侧边栏 pixie 分支的渲染此前只有 SSR 断言（renderToStaticMarkup 下
 * zustand v5 只读模块加载时的初始快照，运行期 capture 不可见），真实
 * 接线必须有 jsdom 用例钉住。
 */
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { SidebarLayout } from "../../components/Sidebar";
import {
  usePixieSidebarSnapshot,
  resetPixieSidebarSnapshotForTests,
} from "../pixie/pixie-sidebar-snapshot";

const PREV_CWD = "/p/alpha";
const PIXIE_CWD = "/agent/workspace/pixie";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-pixie",
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

/** 小精灵页期间的活动工作区（pixie）。 */
const pixieWorkspace: WorkspaceSnapshot = {
  id: "workspace-pixie",
  cwd: PIXIE_CWD,
  canonicalCwd: PIXIE_CWD,
  revision: 1,
  servicesReady: true,
};

/** 进入小精灵前的工作区（冻结快照归属）。 */
const previousWorkspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: PREV_CWD,
  canonicalCwd: PREV_CWD,
  revision: 1,
  servicesReady: true,
};

const desktopSettings: DesktopSettings = {
  theme: "light",
  autoRestartHostOnce: false,
  extensionDecisionPresentation: "auto",
  terminalProfile: "auto",
  language: "en",
  knownWorkspaces: [PREV_CWD],
};

beforeEach(() => {
  useAppStore.setState({
    host,
    workspace: pixieWorkspace,
    session: null,
    page: "pixie",
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    desktopSettings,
    sessionCatalog: { workspaceId: null, entries: {}, order: [], loaded: false },
    sessionTerminalStates: {},
    workspaceActivities: {},
  });
});

afterEach(() => {
  cleanup();
  resetPixieSidebarSnapshotForTests();
  useAppStore.setState({ page: "chat", host: null, workspace: null });
});

describe("小精灵页侧边栏（冻结快照接线）", () => {
  it("冻结快照就位：会话列表可见，上一个会话与上一个工作区保持选中态", () => {
    usePixieSidebarSnapshot.getState().capture({
      workspace: previousWorkspace,
      items: [
        {
          sessionId: "prev-1",
          sessionPath: `${PREV_CWD}/prev-1.jsonl`,
          name: "Previous session",
          cwd: PREV_CWD,
          updatedAt: 1,
          messageCount: 2,
          runtimeState: "idle",
        },
      ],
      activeSessionId: "prev-1",
    });

    render(<SidebarLayout page="pixie" setPage={vi.fn()} />);

    // 会话列表（含头部）照常显示，选中态来自快照。
    expect(screen.getByText("Recent conversations")).toBeInTheDocument();
    const sessionRow = screen.getByText("Previous session").closest("li");
    expect(sessionRow).toHaveAttribute("data-state", "active");

    // 工作区行同样保持选中视觉（跟随快照工作区），点击它可离开小精灵。
    const workspaceButton = screen
      .getAllByText("alpha")
      .map((node) => node.closest("button"))
      .find((button): button is HTMLButtonElement => button?.getAttribute("aria-current") !== null);
    expect(workspaceButton).toHaveAttribute("aria-current", "true");
    expect(workspaceButton).toBeEnabled();
  });

  it("无冻结快照（冷启动直落 pixie）：会话列表为空、无任何选中态", () => {
    render(<SidebarLayout page="pixie" setPage={vi.fn()} />);

    expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
    // 工作区行不带选中视觉（aria-current 只在 showActive 时输出）。
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
  });
});
