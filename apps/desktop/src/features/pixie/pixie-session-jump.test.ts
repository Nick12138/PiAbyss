/**
 * 会话跳转的行为：打开这一行对应的会话。两个边界要守住——目标就是眼前
 * 这条会话时不跳页；打开失败时不切页。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot } from "@piabyss/protocol";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { useAppStore } from "../../lib/stores/app-store";
import { jumpToPixieSession } from "./pixie-session-jump";

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: vi.fn(async () => ({ status: "opened" }) as const),
}));

vi.mock("../../lib/bridge/host-context", () => ({
  workspaceContext: () => ({}),
}));

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: vi.fn(async () => ({ ok: false })) },
}));

beforeEach(() => {
  vi.mocked(openSessionAcrossWorkspaces).mockClear();
  useAppStore.setState({
    host: { hostInstanceId: "host-1" } as unknown as HostStatusSnapshot | null,
    page: "pixie",
    session: { sessionId: "other-session" } as unknown as SessionSnapshot | null,
  });
});

describe("jumpToPixieSession", () => {
  it("打开目标会话并切到对话页", async () => {
    await expect(jumpToPixieSession({ cwd: "C:/work/PiAbyss", sessionId: "s-1" })).resolves.toBe(
      true,
    );
    expect(openSessionAcrossWorkspaces).toHaveBeenCalledWith(
      { cwd: "C:/work/PiAbyss", sessionId: "s-1" },
      expect.objectContaining({ resolveSessionPath: expect.any(Function) }),
    );
    expect(useAppStore.getState().page).toBe("chat");
  });

  it("目标就是眼前这条会话时不跳页", async () => {
    useAppStore.setState({ session: { sessionId: "s-1" } as unknown as SessionSnapshot | null });
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "already-active" });
    await expect(jumpToPixieSession({ cwd: "C:/work/PiAbyss", sessionId: "s-1" })).resolves.toBe(
      true,
    );
    expect(useAppStore.getState().page).toBe("pixie");
  });

  it("打开失败（会话被删）时不切页", async () => {
    vi.mocked(openSessionAcrossWorkspaces).mockResolvedValueOnce({ status: "failed" });
    await expect(jumpToPixieSession({ cwd: "C:/work/PiAbyss", sessionId: "s-1" })).resolves.toBe(
      false,
    );
    expect(useAppStore.getState().page).toBe("pixie");
  });
});
