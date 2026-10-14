/**
 * createNewSessionFromPixiePage — 小精灵页「新会话」的作用域测试。
 *
 * 核心语义：点击侧边栏「新会话」时若正处于小精灵页，必须先切回进入
 * 小精灵前的工作区（记录缺失则退回最近位置），再建会话；绝不把
 * session.create 打到 pixie 工作区上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import {
  clearPixiePreviousWorkspace,
  createNewSessionFromPixiePage,
  rememberPixiePreviousWorkspace,
  resetPixiePreviousWorkspaceForTests,
} from "./pixie-previous-workspace";

const activateSpy = vi.hoisted(() => vi.fn());
const createSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../lib/bridge/session-navigation", () => ({
  activateWorkspaceAcrossWorkspaces: activateSpy,
}));
vi.mock("../../lib/commands/actions", () => ({
  createNewSession: createSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetPixiePreviousWorkspaceForTests();
  useAppStore.setState({
    page: "pixie",
    desktopSettings: {
      theme: "system",
      language: "en",
      lastWorkspace: "/fallback/workspace",
    } as never,
  });
});

afterEach(() => {
  resetPixiePreviousWorkspaceForTests();
  useAppStore.setState({ page: "chat", desktopSettings: null });
});

describe("createNewSessionFromPixiePage", () => {
  it("切回进入前的工作区（阻塞式）后回到 chat 页再建会话", async () => {
    rememberPixiePreviousWorkspace("/previous/workspace");
    activateSpy.mockResolvedValue({ status: "opened" });

    const ok = await createNewSessionFromPixiePage();

    expect(ok).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith("/previous/workspace", { optimistic: false });
    expect(useAppStore.getState().page).toBe("chat");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("无记录时退回最近位置（lastWorkspace 一定是普通工作区）", async () => {
    activateSpy.mockResolvedValue({ status: "opened" });

    await createNewSessionFromPixiePage();

    expect(activateSpy).toHaveBeenCalledWith("/fallback/workspace", { optimistic: false });
    expect(createSpy).toHaveBeenCalled();
  });

  it("工作区已是目标（already-active）时仍落 chat 页并建会话", async () => {
    rememberPixiePreviousWorkspace("/previous/workspace");
    activateSpy.mockResolvedValue({ status: "already-active" });

    const ok = await createNewSessionFromPixiePage();

    expect(ok).toBe(true);
    expect(useAppStore.getState().page).toBe("chat");
    expect(createSpy).toHaveBeenCalled();
  });

  it("切换被阻断（blocked/failed）时不建会话、不切页", async () => {
    rememberPixiePreviousWorkspace("/previous/workspace");
    activateSpy.mockResolvedValue({ status: "blocked" });

    const ok = await createNewSessionFromPixiePage();

    expect(ok).toBe(false);
    expect(useAppStore.getState().page).toBe("pixie");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("既无记录也无最近位置时不建（宁可不建也不在 pixie 里误建）", async () => {
    useAppStore.setState({ desktopSettings: null });

    const ok = await createNewSessionFromPixiePage();

    expect(ok).toBe(false);
    expect(activateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("非小精灵页防御性退回普通建会话路径", async () => {
    useAppStore.setState({ page: "chat" });

    await createNewSessionFromPixiePage();

    expect(activateSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("clearPixiePreviousWorkspace 清掉记录（退回 lastWorkspace 兜底）", async () => {
    rememberPixiePreviousWorkspace("/previous/workspace");
    clearPixiePreviousWorkspace();
    activateSpy.mockResolvedValue({ status: "opened" });

    await createNewSessionFromPixiePage();

    expect(activateSpy).toHaveBeenCalledWith("/fallback/workspace", { optimistic: false });
  });
});
