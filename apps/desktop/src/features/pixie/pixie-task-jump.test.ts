/**
 * 跳转定位的行为：打开锚点所在的会话，落地后滚到那条消息。
 * 三个边界都要守住——目标就是眼前这条会话时不跳页；没有锚点时只打开不滚动；
 * 从未落点的任务根本不给打开的机会。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, PixieTaskJump, SessionSnapshot } from "@piabyss/protocol";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { scrollTranscriptToSource } from "../../lib/transcript-navigation";
import { useAppStore } from "../../lib/stores/app-store";
import { canJumpToPixieTask, jumpToPixieTask } from "./pixie-task-jump";

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: vi.fn(async () => ({ status: "opened" }) as const),
}));

vi.mock("../../lib/transcript-navigation", () => ({
  scrollTranscriptToSource: vi.fn(),
}));

vi.mock("../../lib/bridge/host-context", () => ({
  workspaceContext: () => ({}),
}));

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: vi.fn(async () => ({ ok: false })) },
}));

function jump(overrides: Partial<PixieTaskJump> = {}): PixieTaskJump {
  return {
    cwd: "C:/work/PiAbyss",
    sessionId: "s-1",
    sessionPath: "C:/agent/sessions/s-1.jsonl",
    messageId: "entry-1",
    anchor: "dispatch",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(openSessionAcrossWorkspaces).mockClear();
  vi.mocked(scrollTranscriptToSource).mockClear();
  useAppStore.setState({
    host: { hostInstanceId: "host-1" } as unknown as HostStatusSnapshot | null,
    page: "pixie",
    session: { sessionId: "other-session" } as unknown as SessionSnapshot | null,
  });
});

describe("jumpToPixieTask", () => {
  it("打开目标会话、切到对话页、滚动到锚点消息", async () => {
    await expect(jumpToPixieTask(jump())).resolves.toBe(true);
    expect(openSessionAcrossWorkspaces).toHaveBeenCalledWith(
      { cwd: "C:/work/PiAbyss", sessionId: "s-1", sessionPath: "C:/agent/sessions/s-1.jsonl" },
      expect.objectContaining({ resolveSessionPath: expect.any(Function) }),
    );
    expect(useAppStore.getState().page).toBe("chat");
    expect(scrollTranscriptToSource).toHaveBeenCalledWith("entry-1");
  });

  it("锚点就在眼前这条会话里时只滚动，不跳页", async () => {
    useAppStore.setState({ session: { sessionId: "s-1" } as unknown as SessionSnapshot | null });
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "already-active" });
    await expect(jumpToPixieTask(jump())).resolves.toBe(true);
    expect(useAppStore.getState().page).toBe("pixie");
    expect(scrollTranscriptToSource).toHaveBeenCalledWith("entry-1");
  });

  it("老记录没有锚点：照常打开会话，但不发滚动请求", async () => {
    await expect(jumpToPixieTask(jump({ messageId: null, anchor: null }))).resolves.toBe(true);
    expect(openSessionAcrossWorkspaces).toHaveBeenCalled();
    expect(scrollTranscriptToSource).not.toHaveBeenCalled();
  });

  it("从未落点的任务不发起跳转", async () => {
    const stranded = jump({ sessionId: null, sessionPath: null });
    expect(canJumpToPixieTask(stranded)).toBe(false);
    await expect(jumpToPixieTask(stranded)).resolves.toBe(false);
    expect(openSessionAcrossWorkspaces).not.toHaveBeenCalled();
  });

  it("打开失败（会话被删）时不切页、不滚动", async () => {
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "failed" });
    await expect(jumpToPixieTask(jump())).resolves.toBe(false);
    expect(useAppStore.getState().page).toBe("pixie");
    expect(scrollTranscriptToSource).not.toHaveBeenCalled();
  });
});
