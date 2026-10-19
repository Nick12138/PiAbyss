/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixiePage } from "./PixiePage";

/**
 * 进页面锚定获取（acquire）的并发回归。
 *
 * React StrictMode 在 dev 下会「挂载 effect → 立即清理 → 再跑一次」，于是进小精灵
 * 页会并发跑两次 acquire：两次都发 workspace.setCurrent（同一 cwd），宿主侧必然撞
 * 一次 SERVICE_GRAPH_BUSY，前端 workspaceSwitchTarget 槽位又互相踩，慢的那次被判
 * 为被取代 → blocked → 页面闪「暂不可用」。生产构建没有这次重放，所以只在 dev 复现。
 */
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CWD = "/workspace/other";
const PIXIE_CWD = "/agent/workspace/pixie";
const PICKED_CWD = "/workspace/picked";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: "22222222-2222-4222-8222-222222222222",
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

const otherWorkspace: WorkspaceSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  cwd: OTHER_CWD,
  canonicalCwd: OTHER_CWD,
  revision: 1,
  servicesReady: true,
};

const pixieWorkspace: WorkspaceSnapshot = {
  id: "44444444-4444-4444-8444-444444444444",
  cwd: PIXIE_CWD,
  canonicalCwd: PIXIE_CWD,
  revision: 2,
  servicesReady: true,
};

// 真实的会话导航会把活动工作区落到目标 cwd 上（见 session-navigation）；这里照做，
// 否则页面会认为「工作区被切走了」，触发它自己的重锚（那条路径由页面用例覆盖）。
const openSpy = vi.hoisted(() =>
  vi.fn(async () => {
    useAppStore.getState().setWorkspace(pixieWorkspace);
    return { status: "opened" } as const;
  }),
);
const activateSpy = vi.hoisted(() => vi.fn(async () => ({ status: "opened" }) as const));

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: openSpy,
  activateWorkspaceAcrossWorkspaces: activateSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
    if (method === "pixie.ensureCurrent") {
      return {
        ok: true,
        result: { cwd: PIXIE_CWD, sessionId: "live-1", sessionPath: `${PIXIE_CWD}/live-1.jsonl` },
      } as never;
    }
    if (method === "pixie.dispatches") return { ok: true, result: { dispatches: [] } } as never;
    return { ok: true, result: null } as never;
  });
  vi.spyOn(hostClient, "onEvent").mockReturnValue(() => {});
  useAppStore.setState({
    host,
    workspace: otherWorkspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    activeSubagentNodeId: null,
    workspaceSwitchTarget: null,
    desktopSettings: {
      theme: "system",
      language: "zh",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

describe("PixiePage 锚定获取（acquire）", () => {
  it("设置还没加载完（knownWorkspaces 缺省）时不会自激重渲染", () => {
    // 冷启动直接落在小精灵页：desktopSettings 已经进了 store，但 knownWorkspaces
    // 还没写进来。selector 若写成 `?? []`，每次提交都返回一个新数组，
    // useSyncExternalStore 便判定「快照一直在变」→ forceStoreRerender 无限循环，
    // 整页崩成 Maximum update depth exceeded。这里守住「缺省字段也不新造引用」。
    useAppStore.setState({
      desktopSettings: { theme: "system", language: "zh" } as unknown as DesktopSettings,
    });

    expect(() =>
      render(
        <StrictMode>
          <PixiePage />
        </StrictMode>,
      ),
    ).not.toThrow();
  });

  it("StrictMode 重放挂载 effect 时只锚定一次，不闪「暂不可用」", async () => {
    render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    // 给重放的第二次 effect 足够时间落地（若未被拦截，这里会变成 2 次）。
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith({
      cwd: PIXIE_CWD,
      sessionId: "live-1",
      sessionPath: `${PIXIE_CWD}/live-1.jsonl`,
      quiet: true,
    });
    expect(document.body.textContent ?? "").not.toContain("暂不可用");
  });

  it("工作区被人从脚下换走时重新锚定，不会停在空白加载页", async () => {
    render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // 跳转失败 / 外部路由把活动工作区切到别处：本页只能坐在小精灵工作区上，
    // 发现之后就再锚一次（之前这里永远停在加载态，也就是用户看到的空白页）。
    useAppStore.getState().setWorkspace(otherWorkspace);
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));

    // 锚回来即停：不会因为一次切换就无限重锚。
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("用户点了别的工作区（切换已在途）时不抢着重锚", async () => {
    render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    useAppStore.getState().setWorkspace(otherWorkspace);
    useAppStore.getState().setWorkspaceSwitchTarget(OTHER_CWD);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("用户点了别的工作区时不再抢发第二次切换", async () => {
    // 复现「切到小精灵后点其他工作区弹界面状态已过期」的时序：WorkspacePicker
    // 先占 workspaceSwitchTarget，再 setPage("chat") 卸载本页；它的
    // workspace.setCurrent 此刻还没落地，store 里仍是小精灵工作区，所以卸载
    // 清理的「非 pixie」守卫拦不住，只有让位给已在途的那一次。
    const { unmount } = render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    useAppStore.getState().setWorkspace(pixieWorkspace);
    useAppStore.getState().setWorkspaceSwitchTarget(PICKED_CWD);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 两次并发 setCurrent 各自生成新 workspaceId 并 bump revision，后提交的一方
    // 会让先提交那方的身份立刻过期，宿主还会用后来者取消在飞的构建。
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("没有其它切换在途时仍把工作区还给用户", async () => {
    const { unmount } = render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    useAppStore.getState().setWorkspace(pixieWorkspace);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(activateSpy).toHaveBeenCalledWith(OTHER_CWD, { quiet: true });
  });

  it("委派面板跳转成功后的换页（pixieJumpNavigation）不归还工作区，锁存一次性消费", async () => {
    // 跳转的全部意义就是把活动工作区留在目标会话上：卸载清理若照旧把工作区
    // 归还给进入前的 cwd，跳过去又会被拉回 pixie。锁存消费掉之后，下次正常
    // 进入仍要照常归还（后半段断言）。
    const { unmount } = render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalled());

    useAppStore.getState().setWorkspace(pixieWorkspace);
    useAppStore.getState().setPixieJumpNavigation(true);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(activateSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().pixieJumpNavigation).toBe(false);

    // 再进一次（新组件实例、无锁存）：归还逻辑恢复。
    useAppStore.setState({
      workspace: otherWorkspace,
      workspaceSwitchTarget: null,
      pixieJumpNavigation: false,
    });
    render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));
    useAppStore.getState().setWorkspace(pixieWorkspace);
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(activateSpy).toHaveBeenCalledWith(OTHER_CWD, { quiet: true });
  });
});
