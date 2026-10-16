/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import type { MemoSyncSettings } from "@piabyss/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemoSyncSettings } from "./memo-client";
import { MemoSyncHeaderActions } from "./MemoSyncHeaderActions";

/**
 * 顶栏云同步图标：唯一入口 + 状态着色。
 *
 * 「立即同步」按钮与标题旁那颗绿色状态点都撤了——一个入口配一颗点，读起来分不清谁是谁。
 * 现在状态写在唯一的图标上：最近同步失败转红并把原因写进可访问名，成功与未配置都是常态。
 * 这个组件同时是 `useMemoSyncStatus` 30s 轮询的挂载方，所以「后台同步落地 → 面板刷新」
 * 那条广播也依赖它渲染（这里顺带验一次轮询被真的发起）。
 */
vi.mock("./memo-client", () => ({
  getMemoSyncSettings: vi.fn(),
  testMemoSync: vi.fn(),
  syncMemoNow: vi.fn(),
}));

function settings(overrides: Partial<MemoSyncSettings> = {}): MemoSyncSettings {
  return {
    accountId: "acct",
    bucket: "memos",
    configured: true,
    autoSync: true,
    lastSyncAt: 1_700_000_000_000,
    lastSyncOk: true,
    lastSyncError: null,
    ...overrides,
  } as MemoSyncSettings;
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MemoSyncHeaderActions（顶栏云同步图标）", () => {
  it("只有一个同步入口：没有独立的「立即同步」按钮，也没有状态点", async () => {
    vi.mocked(getMemoSyncSettings).mockResolvedValue(settings());
    const { container } = render(<MemoSyncHeaderActions />);
    await waitFor(() => expect(getMemoSyncSettings).toHaveBeenCalled());

    expect(screen.getByTestId("memo-sync-open")).toBeInTheDocument();
    expect(screen.queryByTestId("memo-sync-refresh")).toBeNull();
    expect(container.querySelector("[data-sync-state]")).toHaveClass("size-7");
  });

  it("最近同步失败：图标转红，原因写进可访问名", async () => {
    vi.mocked(getMemoSyncSettings).mockResolvedValue(
      settings({ lastSyncOk: false, lastSyncError: "R2 503" }),
    );
    render(<MemoSyncHeaderActions />);

    const button = await screen.findByTestId("memo-sync-open");
    await waitFor(() => expect(button).toHaveAttribute("data-sync-state", "fail"));
    expect(button.className).toContain("text-danger");
    expect(button).toHaveAccessibleName("Cloud sync (Cloudflare R2) · Last sync failed");
  });

  it("同步成功与未配置都不标红：未配置只在可访问名上说清楚", async () => {
    vi.mocked(getMemoSyncSettings).mockResolvedValue(settings());
    render(<MemoSyncHeaderActions />);
    const ok = await screen.findByTestId("memo-sync-open");
    await waitFor(() => expect(ok).toHaveAttribute("data-sync-state", "idle"));
    expect(ok.className).not.toContain("text-danger");
    expect(ok).toHaveAccessibleName("Cloud sync (Cloudflare R2)");
    cleanup();

    vi.mocked(getMemoSyncSettings).mockResolvedValue(
      settings({
        configured: false,
        accountId: "",
        bucket: "",
        lastSyncAt: null,
        lastSyncOk: null,
      }),
    );
    render(<MemoSyncHeaderActions />);
    const off = await screen.findByTestId("memo-sync-open");
    await waitFor(() => expect(off).toHaveAttribute("data-sync-state", "unconfigured"));
    expect(off.className).not.toContain("text-danger");
    expect(off).toHaveAccessibleName("Cloud sync (Cloudflare R2) · Cloud sync not configured");
  });
});
