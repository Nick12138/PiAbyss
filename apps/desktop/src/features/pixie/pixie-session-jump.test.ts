/**
 * 会话跳转的行为：打开这一行对应的会话。要守住的边界——会话已删除 / 已归档时
 * **在任何工作区切换之前**就判掉（Host 的投影已经说了落点不在），只在小精灵页
 * 给一句明确提示，不跳页、不试打开、不求助 Host；记录里没有落点路径时才退回
 * 按 id 解析；目标就是眼前这条会话时不跳页；打开失败时不切页。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostStatusSnapshot,
  SessionSnapshot,
  SessionSummary,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { jumpToPixieSession, type PixieSessionTarget } from "./pixie-session-jump";

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: vi.fn(async () => ({ status: "opened" }) as const),
  releaseWorkspaceSwitchSlot: vi.fn((cwd: string) => {
    if (useAppStore.getState().workspaceSwitchTarget === cwd) {
      useAppStore.getState().setWorkspaceSwitchTarget(null);
    }
  }),
}));

vi.mock("../../lib/bridge/host-context", () => ({
  workspaceContext: () => ({}),
}));

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: vi.fn(async () => ({ ok: false })) },
}));

const CWD = "C:/work/PiAbyss";
const SESSION_PATH = "/sessions/2026-10-12T13-02-40-119Z_s-1.jsonl";

function summary(sessionId: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    sessionPath: `/sessions/${sessionId}.jsonl`,
    cwd: CWD,
    updatedAt: 1,
    ...extra,
  };
}

/** 面板一行的跳转目标；默认是「记录里没有落点路径」那档。 */
function target(overrides: Partial<PixieSessionTarget> = {}): PixieSessionTarget {
  return { cwd: CWD, sessionId: "s-1", sessionPath: null, liveness: "unknown", ...overrides };
}

/** 让 hostClient.request 回答一次 session.list。 */
function sessionListReturns(items: SessionSummary[]): void {
  vi.mocked(hostClient.request).mockResolvedValueOnce({
    ok: true,
    result: { workspaceId: "w-1", items },
  } as never);
}

function setWorkspace(canonicalCwd: string): void {
  useAppStore.setState({ workspace: { canonicalCwd } as unknown as WorkspaceSnapshot });
}

beforeEach(() => {
  vi.mocked(openSessionAcrossWorkspaces).mockClear();
  vi.mocked(hostClient.request).mockClear();
  useAppStore.setState({
    host: { hostInstanceId: "host-1" } as unknown as HostStatusSnapshot | null,
    page: "pixie",
    session: { sessionId: "other-session" } as unknown as SessionSnapshot | null,
    workspace: null,
    notifications: [],
    workspaceSwitchTarget: null,
    pixieJumpNavigation: false,
  });
});

describe("jumpToPixieSession", () => {
  it("会话还在：带着记录里的落点路径直接打开，并切到对话页", async () => {
    await expect(
      jumpToPixieSession(target({ liveness: "active", sessionPath: SESSION_PATH })),
    ).resolves.toBe(true);
    expect(openSessionAcrossWorkspaces).toHaveBeenCalledWith(
      { cwd: CWD, sessionId: "s-1", sessionPath: SESSION_PATH, quiet: true, holdSlot: true },
      expect.objectContaining({ resolveSessionPath: expect.any(Function) }),
    );
    expect(useAppStore.getState().page).toBe("chat");
    // 成功跳转置一次性锁存，PixiePage 卸载时据此不归还工作区。
    expect(useAppStore.getState().pixieJumpNavigation).toBe(true);
  });

  it("跳转期间一直占着切换槽位，结束后释放——中间不能给 workspaceStrayed 防卫开窗", async () => {
    const slotDuringNavigation: (string | null)[] = [];
    vi.mocked(openSessionAcrossWorkspaces).mockImplementationOnce(async () => {
      slotDuringNavigation.push(useAppStore.getState().workspaceSwitchTarget);
      return { status: "opened" };
    });

    await expect(jumpToPixieSession(target({ liveness: "active" }))).resolves.toBe(true);

    // 导航进行中槽位被预占（PixiePage 的防卫因此沉默），导航结束才释放。
    expect(slotDuringNavigation).toEqual([CWD]);
    expect(useAppStore.getState().workspaceSwitchTarget).toBeNull();
  });

  it("跳转失败也释放槽位，不残留目标 cwd", async () => {
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "failed" });

    await expect(jumpToPixieSession(target({ liveness: "active" }))).resolves.toBe(false);

    expect(useAppStore.getState().workspaceSwitchTarget).toBeNull();
  });

  it("会话已删除：就地判掉——不切工作区、不试打开、不跳页、不问 Host", async () => {
    await expect(jumpToPixieSession(target({ liveness: "missing" }))).resolves.toBe(false);

    expect(openSessionAcrossWorkspaces).not.toHaveBeenCalled();
    expect(hostClient.request).not.toHaveBeenCalled();
    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: tCurrent("pixieSessionGone"),
      level: "warning",
    });
  });

  it("会话已归档：提示去恢复，照样不切工作区、不跳页", async () => {
    await expect(jumpToPixieSession(target({ liveness: "archived" }))).resolves.toBe(false);

    expect(openSessionAcrossWorkspaces).not.toHaveBeenCalled();
    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: tCurrent("pixieSessionArchived"),
      level: "warning",
    });
  });

  it("记录里没有落点路径：退回按 id 解析，解析得到就开", async () => {
    setWorkspace(CWD);
    sessionListReturns([summary("s-1")]);
    vi.mocked(openSessionAcrossWorkspaces).mockImplementationOnce(async (t, options) => {
      await options?.resolveSessionPath?.(t.sessionId ?? "");
      return { status: "opened" };
    });

    await expect(jumpToPixieSession(target())).resolves.toBe(true);

    expect(vi.mocked(hostClient.request)).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().page).toBe("chat");
  });

  it("记录里没有落点路径、解析也查无此条：给同一句「已不存在」，不是泛泛的失败", async () => {
    setWorkspace(CWD);
    sessionListReturns([summary("still-here")]);
    vi.mocked(openSessionAcrossWorkspaces).mockImplementationOnce(async (t, options) => {
      await options?.resolveSessionPath?.(t.sessionId ?? "");
      return { status: "failed" };
    });

    await expect(jumpToPixieSession(target())).resolves.toBe(false);

    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: tCurrent("pixieSessionGone"),
      level: "warning",
    });
  });

  it("目标就是眼前这条会话时不跳页、不置锁存", async () => {
    useAppStore.setState({ session: { sessionId: "s-1" } as unknown as SessionSnapshot | null });
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "already-active" });

    await expect(jumpToPixieSession(target({ liveness: "active" }))).resolves.toBe(true);

    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().pixieJumpNavigation).toBe(false);
  });

  it("打开失败（Host 报错 / 忙面）时不切页，并自己补一条失败提示", async () => {
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "failed" });

    await expect(jumpToPixieSession(target({ liveness: "active" }))).resolves.toBe(false);

    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: tCurrent("notifOpenSessionFailed"),
      level: "error",
    });
  });

  it("记录里没有落点路径、解析出来是归档的那一刻：同样给「已归档」，不静默失败", async () => {
    setWorkspace(CWD);
    sessionListReturns([summary("s-1", { archived: true })]);
    vi.mocked(openSessionAcrossWorkspaces).mockImplementationOnce(async (t, options) => {
      const resolved = await options?.resolveSessionPath?.(t.sessionId ?? "");
      return resolved?.archived ? { status: "archived" } : { status: "failed" };
    });

    await expect(jumpToPixieSession(target())).resolves.toBe(false);

    expect(useAppStore.getState().page).toBe("pixie");
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      message: tCurrent("pixieSessionArchived"),
      level: "warning",
    });
  });
});
