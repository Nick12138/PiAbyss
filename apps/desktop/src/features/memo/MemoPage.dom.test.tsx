/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, MemoNote, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { MemoPage } from "./MemoPage";
import { clearPendingMemoRevealForTest, requestMemoReveal } from "./memo-reveal";

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

describe("MemoPage 速记小窗跳转预览（memo-reveal）", () => {
  beforeEach(() => {
    clearPendingMemoRevealForTest();
  });

  // pending 是模块级状态：不清掉会泄漏进后续用例（10s TTL 内被补投）。
  afterEach(() => {
    clearPendingMemoRevealForTest();
  });

  it("opens the note's detail after a reveal request made before mount (page was elsewhere)", async () => {
    // 小窗点击发生在备忘页未挂载时（App.tsx 先 requestMemoReveal 再切页）：
    // 请求挂在模块里，MemoPage 挂载后补投并打开详情。
    requestMemoReveal("memo-1");
    render(<MemoPage />);

    expect(await screen.findByTestId("memo-detail")).toBeInTheDocument();
    expect(screen.getByTestId("memo-detail-complete")).toBeInTheDocument();
    // 列表里该行处于选中态（详情标题同名，从列表行里找）。
    const row = screen
      .getAllByTestId("memo-list-item")
      .find((el) => el.textContent?.includes("手动完成一条"));
    expect(row?.getAttribute("data-state")).toBe("active");
  });

  it("reveals a note while the page is already mounted", async () => {
    render(<MemoPage />);
    await screen.findByText("手动完成一条");
    // 挂载后默认是新建表单（详情未开）。
    expect(screen.queryByTestId("memo-detail")).toBeNull();

    requestMemoReveal("memo-1");
    expect(await screen.findByTestId("memo-detail")).toBeInTheDocument();
  });

  it("switches the status tab and clears filters so the revealed note is visible", async () => {
    // 记录是「已完成」：默认在「待处理」页签看不到——预览要切到 Done 页签。
    mocks.listMemoNotes.mockResolvedValue([openNote, doneNote]);
    render(<MemoPage />);
    await screen.findByText("手动完成一条");
    // 搜索框先输入内容，验证预览会清掉筛选。
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在的关键词" } });

    requestMemoReveal("memo-3");

    expect(await screen.findByTestId("memo-detail-reopen")).toBeInTheDocument();
    // 页签切到了该记录的状态，搜索词被清空。
    expect(screen.getByRole("tab", { name: /^Done/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("keeps the current view when the revealed note no longer exists", async () => {
    render(<MemoPage />);
    await screen.findByText("手动完成一条");
    expect(screen.queryByTestId("memo-detail")).toBeNull();

    requestMemoReveal("memo-gone");
    // 等一个渲染周期：不硬跳、不打开详情、不报错。
    await waitFor(() => {
      expect(mocks.listMemoNotes).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("memo-detail")).toBeNull();
    expect(screen.getByText("手动完成一条")).toBeInTheDocument();
  });
});
