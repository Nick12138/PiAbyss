/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, MemoNote, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { MemoPage } from "./MemoPage";

const mocks = vi.hoisted(() => ({
  listMemoNotes: vi.fn(),
  updateMemoNote: vi.fn(),
  createMemoNote: vi.fn(),
  deleteMemoNote: vi.fn(),
  optimizeMemo: vi.fn(),
  getMemoDraft: vi.fn(),
  setMemoDraft: vi.fn(),
  clearMemoDraft: vi.fn(),
  readMemoImageDataUrl: vi.fn(),
}));

vi.mock("./memo-client", () => mocks);

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

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  return {
    id: "memo-1",
    type: "memo",
    title: "手动完成一条",
    contentMd: "手动完成一条\n正文",
    status: "open",
    sessionId: null,
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    result: null,
    deletedAt: null,
    ...overrides,
  };
}

const openNote = note();
const runningNote = note({
  id: "memo-2",
  title: "进行中一条",
  status: "in_progress",
  sessionId: "s1",
});
const doneNote = note({ id: "memo-3", title: "已完成一条", status: "done", completedAt: 9 });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listMemoNotes.mockResolvedValue([openNote, runningNote]);
  mocks.getMemoDraft.mockResolvedValue(null);
  mocks.setMemoDraft.mockResolvedValue(null);
  mocks.clearMemoDraft.mockResolvedValue(undefined);
  mocks.createMemoNote.mockImplementation(async () => openNote);
  mocks.deleteMemoNote.mockResolvedValue(undefined);
  mocks.optimizeMemo.mockResolvedValue({ contentMd: "", type: "memo", workspaceId: null });
  mocks.readMemoImageDataUrl.mockResolvedValue("");
  mocks.updateMemoNote.mockImplementation(async (id: string, patch: Partial<MemoNote>) => {
    const source =
      [openNote, runningNote, doneNote].find((entry) => entry.id === id) ?? note({ id });
    return { ...source, ...patch };
  });
  useAppStore.setState({
    host,
    workspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    desktopSettings: null,
  });
});

afterEach(() => cleanup());

describe("MemoPage 手动标记完成 / 重新打开", () => {
  it("lets a 待处理 record be completed from its detail header (no row button)", async () => {
    render(<MemoPage />);

    const row = (await screen.findByText("手动完成一条")).closest("li");
    expect(row).not.toBeNull();
    // 行内不再放「标记完成」——详情页有常驻按钮。
    expect(within(row as HTMLElement).queryByRole("button", { name: "Mark done" })).toBeNull();

    fireEvent.click(within(row as HTMLElement).getByTestId("memo-list-item"));
    fireEvent.click(await screen.findByTestId("memo-detail-complete"));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-1", { status: "done" });
    });
  });

  it("keeps a 进行中 record completable from its detail header (spinner in the row)", async () => {
    render(<MemoPage />);
    await screen.findByText("手动完成一条");

    fireEvent.click(screen.getByRole("tab", { name: /In progress/ }));
    const row = (await screen.findByText("进行中一条")).closest("li");
    expect(row?.querySelector(".animate-spin")).not.toBeNull();
    expect(within(row as HTMLElement).queryByRole("button", { name: "Mark done" })).toBeNull();

    fireEvent.click(within(row as HTMLElement).getByTestId("memo-list-item"));
    fireEvent.click(await screen.findByTestId("memo-detail-complete"));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-2", { status: "done" });
    });
  });

  it("offers a persistent reopen action for a 已完成 record's detail", async () => {
    mocks.listMemoNotes.mockResolvedValue([doneNote]);
    render(<MemoPage />);

    // 已完成记录在「已完成」页签下；行内绿色对勾已移除，重新打开只保留详情页常驻按钮。
    fireEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    const row = (await screen.findByText("已完成一条")).closest("li");
    expect(within(row as HTMLElement).queryByRole("button", { name: "Reopen" })).toBeNull();
    fireEvent.click(screen.getByTestId("memo-list-item"));
    fireEvent.click(await screen.findByTestId("memo-detail-reopen"));

    await waitFor(() => {
      expect(mocks.updateMemoNote).toHaveBeenCalledWith("memo-3", { status: "open" });
    });
  });
});

describe("MemoPage 详情 Markdown 预览", () => {
  it("renders the detail body as Markdown instead of the raw source", async () => {
    mocks.listMemoNotes.mockResolvedValue([
      note({ id: "memo-md", title: "Markdown 记录", contentMd: "Markdown 记录\n\n**加粗**文字" }),
    ]);
    render(<MemoPage />);

    fireEvent.click(await screen.findByTestId("memo-list-item"));

    // 渲染器按需加载：Suspense 解析后详情正文才出现。
    await screen.findByText("加粗", undefined, { timeout: 5_000 });

    // 正文按 Markdown 渲染（Streamdown 用 data-streamdown 标记，项目样式同样按该属性
    // 匹配），而不是保留 `**加粗**` 源码。列表摘要仍走纯文本，故只断言正文容器。
    const body = document.querySelector<HTMLElement>(".chat-markdown.memo-markdown");
    expect(body).not.toBeNull();
    expect(body?.querySelector('[data-streamdown="strong"]')?.textContent).toBe("加粗");
    expect(body?.textContent).not.toContain("**加粗**");
  });
});
