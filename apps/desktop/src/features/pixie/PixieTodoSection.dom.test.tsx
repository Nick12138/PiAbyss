/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  MemoNote,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { closeContextMenu } from "../../lib/context-menu";
import { MenuHost } from "../../components/Menu";
import {
  completeMemoNote,
  createMemoNote,
  deleteMemoNote,
  listMemoNotes,
  readMemoImageDataUrl,
  updateMemoNote,
} from "../memo/memo-client";
import { injectMemoReference } from "../memo/memo-agent";
import { MEMO_SYNCED_EVENT } from "../memo/memo-sync-status";
import { PixieTodoSection } from "./PixieTodoSection";

/**
 * 随行面板「方寸间」页签：二级页签 / 三层行（标题 · 摘要 · 标签·工作区·截止）/ 就地 Markdown 正文 / 新建。
 * 数据走 memo-client，这里只验面板自己的组织方式与动作路由：
 * 行首状态、行尾 ✨、右键编辑 / 删除、已完成页签的勾选式批量删除。
 * 面板的插件门与页签栏归 `PixieSidePanel`（见它的用例），这里直接以「可见的那块」渲染。
 */
const onCount = vi.fn();

vi.mock("../memo/memo-client", () => ({
  listMemoNotes: vi.fn(),
  createMemoNote: vi.fn(),
  completeMemoNote: vi.fn(),
  updateMemoNote: vi.fn(),
  deleteMemoNote: vi.fn(),
  // 编辑弹窗（MemoEditor / MemoNoteDialog）会取这两个：本组用例不触发，给空实现即可。
  optimizeMemo: vi.fn(),
  readMemoImageDataUrl: vi.fn(),
}));

vi.mock("../memo/memo-agent", () => ({
  injectMemoReference: vi.fn(),
}));

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const PIXIE_CWD = "/agent/workspace/pixie";

const host = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 1,
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionRevision: 3,
  packageRevision: 1,
  sdkVersion: "test",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
} satisfies HostStatusSnapshot;

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  return {
    id: "n1",
    title: "t",
    contentMd: "t",
    status: "open",
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    result: null,
    deletedAt: null,
    dueAt: null,
    recurrence: null,
    nextDueAt: null,
    lastDoneAt: null,
    ...overrides,
  } as MemoNote;
}

const YESTERDAY = Date.now() - 24 * 60 * 60 * 1000;

const FIXTURE: MemoNote[] = [
  note({
    id: "n-overdue",
    title: "回复张工的邮件",
    contentMd: "回复张工的邮件\n网关不支持自定义 header 透传，需要替代方案。",
    tags: ["邮件"],
    workspaceHint: "文案库",
    dueAt: YESTERDAY,
  }),
  note({ id: "n-doing", title: "修复登录态串号", status: "in_progress" }),
  note({ id: "n-done", title: "订会议室", status: "done", completedAt: 1 }),
];

function rows(): HTMLElement[] {
  return screen.getAllByTestId("pixie-todo-row");
}

/** 列表加载完 = 两行待处理（已完成那条不在这档）；顺带把行数组给出去。 */
async function waitForRows(): Promise<HTMLElement[]> {
  await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(2));
  return rows();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMemoNotes).mockResolvedValue(FIXTURE);
  vi.mocked(createMemoNote).mockResolvedValue(note());
  vi.mocked(completeMemoNote).mockResolvedValue(note({ status: "done" }));
  vi.mocked(updateMemoNote).mockResolvedValue(note({ status: "open" }));
  vi.mocked(deleteMemoNote).mockResolvedValue(undefined);
  useAppStore.setState({
    host,
    workspace: {
      id: "22222222-2222-4222-8222-222222222222",
      cwd: PIXIE_CWD,
      canonicalCwd: PIXIE_CWD,
      revision: 1,
      servicesReady: true,
    } as WorkspaceSnapshot,
    session: {
      sessionId: "33333333-3333-4333-8333-333333333333",
      cwd: PIXIE_CWD,
      messages: [{ role: "user", content: "hi" }],
    } as unknown as SessionSnapshot,
    desktopSettings: {
      language: "en",
      knownWorkspaces: ["/work/okxbot"],
    } as unknown as DesktopSettings,
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  closeContextMenu();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
  globalThis.localStorage?.clear();
});

describe("PixieTodoSection", () => {
  it("计数只在二级页签与页签徽章上：概览格已删，进行中只在行内转圈", async () => {
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    expect(screen.getByTestId("pixie-todo-tab-open")).toHaveTextContent("2");
    expect(screen.getByTestId("pixie-todo-tab-done")).toHaveTextContent("1");
    // 报给随行面板页签的就是待处理总数。
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
    expect(document.querySelector('[data-testid="pixie-todo-overview"]')).toBeNull();
    // 进行中不单独分区、不单独计数：混在待处理里，行内说明状态。
    expect(within(rows()[1]).getByText("In progress")).toBeInTheDocument();
  });

  it("日期只用来定顺序，不再渲染分组标题：逾期在前、无日期的沉底", async () => {
    render(<PixieTodoSection active onCount={onCount} />);
    const list = await waitForRows();

    expect(document.querySelectorAll('[data-testid="pixie-todo-bucket"]')).toHaveLength(0);
    expect(list[0].textContent).toContain("回复张工的邮件");
    expect(list[1].textContent).toContain("修复登录态串号");
    // 已完成不进「待处理」页签。
    expect(screen.queryByText("订会议室")).toBeNull();
  });

  it("速记框在列表下面、默认两行，两个页签都给", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    const quick = screen.getByTestId("pixie-todo-quick");
    expect(quick).toHaveAttribute("rows", "2");
    // 列表之后：它是这一块的最后一行，不在页签上面。
    const row = rows()[0];
    expect(row.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(
      0,
    );
    expect(screen.getByTestId("pixie-todo-new")).toBeInTheDocument();

    await user.click(screen.getByTestId("pixie-todo-tab-done"));

    expect(screen.getByText("订会议室")).toBeInTheDocument();
    expect(screen.getByTestId("pixie-todo-quick")).toHaveAttribute("rows", "2");
  });

  it("无日期那一档只先给 5 条，点「查看更多」补齐", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => note({ id: `x${index}`, title: `随手记 ${index}` })),
    );
    render(<PixieTodoSection active onCount={onCount} />);

    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(5));
    const more = screen.getByTestId("pixie-todo-show-more");
    expect(more).toHaveTextContent("2");

    await user.click(more);
    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(7));
    expect(screen.queryByTestId("pixie-todo-show-more")).toBeNull();

    // 同一位置换成「收起」，点回去重新只给 5 条。
    await user.click(screen.getByTestId("pixie-todo-show-less"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(5));
  });

  it("已完成整列也只先给 5 条；「查看更多」两个页签各记一份", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue([
      ...Array.from({ length: 8 }, (_, index) =>
        note({
          id: `d${index}`,
          title: `办完 ${index}`,
          status: "done",
          completedAt: index + 1,
        }),
      ),
      note({ id: "p1", title: "随手记一条" }),
    ]);
    render(<PixieTodoSection active onCount={onCount} />);
    await waitFor(() => expect(screen.getByTestId("pixie-todo-tab-done")).toHaveTextContent("8"));

    await user.click(screen.getByTestId("pixie-todo-tab-done"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(5));
    expect(screen.getByTestId("pixie-todo-show-more")).toHaveTextContent("3");

    await user.click(screen.getByTestId("pixie-todo-show-more"));
    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(8));

    // 摊开之后下面不再挂第二个「查看更多」（曾经的 bug），同一位置只剩「收起」。
    expect(screen.queryByTestId("pixie-todo-show-more")).toBeNull();
    const collapse = screen.getByTestId("pixie-todo-show-less");
    expect(collapse).toHaveTextContent("Show less");
    await user.click(collapse);
    await waitFor(() => expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(5));

    // 切回待处理重新收起：一边点开不影响另一边。
    await user.click(screen.getByTestId("pixie-todo-tab-open"));
    expect(screen.getAllByTestId("pixie-todo-row")).toHaveLength(1);
    expect(screen.queryByTestId("pixie-todo-show-more")).toBeNull();
  });

  it("已完成行的标记是选中态，点它转回待处理", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();
    await user.click(screen.getByTestId("pixie-todo-tab-done"));

    const tick = within(screen.getByTestId("pixie-todo-row")).getByTestId("pixie-todo-complete");
    expect(tick).toHaveAccessibleName("Reopen");

    await user.click(tick);
    await waitFor(() => expect(updateMemoNote).toHaveBeenCalledWith("n-done", { status: "open" }));
    expect(completeMemoNote).not.toHaveBeenCalled();
  });

  it("折叠态就给三层：标题 / 摘要 / 标签·工作区·截止", async () => {
    render(<PixieTodoSection active onCount={onCount} />);
    const list = await waitForRows();
    const first = within(list[0]);

    expect(first.getByTestId("pixie-todo-excerpt")).toHaveTextContent(
      "网关不支持自定义 header 透传",
    );
    expect(first.getByText("#邮件")).toBeInTheDocument();
    expect(first.getByText("文案库")).toBeInTheDocument();
    expect(first.getByTestId("pixie-todo-due")).toHaveTextContent(/^Yesterday \d{2}:\d{2}$/);
  });

  it("展开只补 Markdown 正文，动作不在展开区里", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    const list = await waitForRows();

    const toggle = within(list[0]).getByTestId("pixie-todo-open-detail");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByTestId("pixie-todo-detail");
    // 渲染器按需加载：Suspense 解析后正文才出现。
    await within(detail).findByText(/网关不支持自定义 header 透传/, undefined, { timeout: 5_000 });
    // 面板档位（11px），不是弹窗预览那个 13px。
    expect(detail.querySelector(".chat-markdown.memo-markdown.panel-markdown")).not.toBeNull();
    expect(within(detail).queryByText("#邮件")).toBeNull();
    // 编辑 / 删除都收进了右键菜单，展开区不再画动作按钮。
    expect(screen.queryByTestId("pixie-todo-edit")).toBeNull();
    expect(screen.queryByTestId("pixie-todo-delete")).toBeNull();
  });

  it("只有标题一行的记录展不开：没有正文就不给空壳", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    const list = await waitForRows();

    await user.click(within(list[1]).getByTestId("pixie-todo-open-detail"));

    expect(within(list[1]).getByTestId("pixie-todo-open-detail")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("pixie-todo-detail")).toBeNull();
  });

  it("勾选标记完成，列表随之刷新", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    await user.click(screen.getAllByTestId("pixie-todo-complete")[0]);

    await waitFor(() => expect(completeMemoNote).toHaveBeenCalledWith("n-overdue"));
    expect(listMemoNotes).toHaveBeenCalledTimes(2);
  });

  it("行尾 ✨ 把记录以引用胶囊注入当前会话草稿，不新开会话", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    const list = await waitForRows();

    await user.click(within(list[0]).getByTestId("pixie-todo-handoff"));

    expect(injectMemoReference).toHaveBeenCalledTimes(1);
    const [target, injected, payload] = vi.mocked(injectMemoReference).mock.calls[0];
    expect(target).toEqual({
      kind: "session",
      canonicalCwd: PIXIE_CWD,
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    expect(injected.id).toBe("n-overdue");
    expect(payload).toContain('<piabyss-memo id="n-overdue"');
    expect(payload).toContain("网关不支持自定义 header 透传");
  });

  it("右键「复制正文」连标题一起复制", async () => {
    // userEvent.setup() 会装自己的 clipboard 桩，所以这里跟 ChangesPanel 一样用 fireEvent。
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // 标题与正文首行不一致（正文里没写标题）：复制得把标题补成首行，不能只给正文。
    vi.mocked(listMemoNotes).mockResolvedValue([
      note({ id: "n-split", title: "点2杯美式", contentMd: "提醒：点 2 杯美式 ☕" }),
    ]);
    render(
      <>
        <MenuHost />
        <PixieTodoSection active onCount={onCount} />
      </>,
    );
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.contextMenu(rows()[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy note text" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("点2杯美式\n\n提醒：点 2 杯美式 ☕"),
    );
    expect(useAppStore.getState().transientNotifications.at(-1)?.message).toBe("Copied");
  });

  it("速记框 Enter 落一条：标题取首行、#标签 自动识别", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    await user.type(screen.getByTestId("pixie-todo-quick"), "订周五的会议室 #会议{Enter}");

    await waitFor(() =>
      expect(createMemoNote).toHaveBeenCalledWith({
        title: "订周五的会议室 #会议",
        contentMd: "订周五的会议室 #会议",
        tags: ["会议"],
      }),
    );
    expect(screen.getByTestId("pixie-todo-quick")).toHaveValue("");
  });

  it("Shift+Enter 换行不落条", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    await user.type(screen.getByTestId("pixie-todo-quick"), "第一行{Shift>}{Enter}{/Shift}第二行");

    expect(createMemoNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("pixie-todo-quick")).toHaveValue("第一行\n第二行");
  });

  it("＋ 开的是完整新建弹窗，落盘走 memo.create（标题从正文首行派生）", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    await user.click(screen.getByTestId("pixie-todo-new"));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(dialog).toBeInTheDocument();
    // 速记框不跟着收起：两条新建入口互不遮挡（旧的行内四字段表单已经并进这个弹窗）。
    expect(screen.getByTestId("pixie-todo-quick")).toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText("Write it down… #tags become tags. Markdown supported."),
      "订会议室\n#行政 周五下午两点，网关那条一起问。",
    );
    await user.click(within(dialog).getByTestId("memo-editor-save"));

    await waitFor(() => expect(createMemoNote).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createMemoNote).mock.calls[0][0];
    expect(input.title).toBe("订会议室");
    expect(input.tags).toEqual(["行政"]);
    expect(input.recurrence).toBeNull();
    expect(input.images).toEqual([]);
    // 保存成功 → 弹窗关掉并重新拉一次列表。
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New note" })).toBeNull());
    expect(listMemoNotes).toHaveBeenCalledTimes(2);
  });

  it("右键菜单给编辑 / 复制正文 / 删除；删除先过一次确认", async () => {
    const user = userEvent.setup();
    render(
      <>
        <MenuHost />
        <PixieTodoSection active onCount={onCount} />
      </>,
    );
    const list = await waitForRows();

    fireEvent.contextMenu(list[0]);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Edit",
      "Copy note text",
      "Delete",
    ]);

    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(deleteMemoNote).not.toHaveBeenCalled();

    // 右键已经是「主动作的二阶」，这里只报条数、点一次落盘，不再叠第二次点击确认。
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("1");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMemoNote).toHaveBeenCalledWith("n-overdue"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("右键「编辑」开弹窗改这一条，页面不动", async () => {
    const user = userEvent.setup();
    render(
      <>
        <MenuHost />
        <PixieTodoSection active onCount={onCount} />
      </>,
    );
    const list = await waitForRows();
    const pageBefore = useAppStore.getState().page;

    fireEvent.contextMenu(list[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("memo-editor")).toBeInTheDocument();
    expect(useAppStore.getState().page).toBe(pageBefore);

    // 弹窗打开时正文是 Markdown 源码；切「预览」才渲染。
    expect(within(dialog).queryByTestId("memo-editor-preview")).toBeNull();
    expect(within(dialog).getByRole("textbox")).toBeInTheDocument();
    await user.click(within(dialog).getByTestId("memo-dialog-mode-preview"));
    await waitFor(() =>
      expect(within(dialog).getByTestId("memo-editor-preview")).toBeInTheDocument(),
    );

    await user.click(within(dialog).getByTestId("memo-editor-save"));
    await waitFor(() =>
      expect(updateMemoNote).toHaveBeenCalledWith(
        "n-overdue",
        expect.objectContaining({ title: "回复张工的邮件" }),
      ),
    );
  });

  it("带总结的已完成记录：右键开总结弹窗，「继续讨论」引用给小精灵而不是跳会话", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue([
      note({
        id: "n-sum",
        title: "整理网关限流方案",
        contentMd: "整理网关限流方案\n要能按 key 分档",
        status: "done",
        completedAt: 1,
        result: {
          resultMd: "已产出方案：按 key 分档",
          sessionId: "s-1",
          sessionPath: "/tmp/s-1.jsonl",
          sessionTitle: "网关限流讨论",
          sessionCwd: "/work/okxbot",
          at: 2,
        },
      }),
    ]);
    render(
      <>
        <MenuHost />
        <PixieTodoSection active onCount={onCount} />
      </>,
    );
    await user.click(screen.getByTestId("pixie-todo-tab-done"));
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.contextMenu(rows()[0]);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Agent summary",
      "Edit",
      "Copy note text",
      "Delete",
    ]);
    const pageBefore = useAppStore.getState().page;
    await user.click(screen.getByRole("menuitem", { name: "Agent summary" }));

    const dialog = await screen.findByRole("dialog");
    // 总结正文同为 Markdown，渲染器按需加载。
    await within(dialog).findByText(/按 key 分档/, undefined, { timeout: 5_000 });
    expect(dialog).toHaveTextContent("网关限流讨论");

    await user.click(within(dialog).getByRole("button", { name: "Continue discussion" }));

    expect(injectMemoReference).toHaveBeenCalledTimes(1);
    const [, injected, payload] = vi.mocked(injectMemoReference).mock.calls[0];
    expect(injected.id).toBe("n-sum");
    expect(payload).toContain('<piabyss-memo id="n-sum"');
    expect(payload).toContain("已产出方案：按 key 分档");
    // 不跳去产出总结的那条会话：页面不动，弹窗关掉，引用落在当前小精灵草稿里。
    expect(useAppStore.getState().page).toBe(pageBefore);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("已完成页签：批量删除是勾选式的，确认后才逐条落 memo.delete", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();

    await user.click(screen.getByTestId("pixie-todo-tab-done"));
    await user.click(screen.getByTestId("pixie-todo-batch-toggle"));

    // 行首圆圈换成复选框，点整行即选中。
    expect(screen.queryByTestId("pixie-todo-complete")).toBeNull();
    await user.click(within(rows()[0]).getByTestId("pixie-todo-open-detail"));
    expect(screen.getByTestId("pixie-todo-batch-bar")).toHaveTextContent("1");

    // 没勾选时删除按钮不可点。
    await user.click(screen.getByTestId("pixie-todo-tab-open"));
    await user.click(screen.getByTestId("pixie-todo-tab-done"));
    expect(screen.queryByTestId("pixie-todo-batch-bar")).toBeNull();
    await user.click(screen.getByTestId("pixie-todo-batch-toggle"));
    await user.click(screen.getByTestId("pixie-todo-select-all"));
    expect(screen.getByTestId("pixie-todo-batch-bar")).toHaveTextContent("1");
    await user.click(screen.getByTestId("pixie-todo-batch-delete"));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMemoNote).toHaveBeenCalledWith("n-done"));
    // 删完自动退出勾选模式。
    expect(screen.queryByTestId("pixie-todo-batch-bar")).toBeNull();
  });

  it("批量模式的「全选」覆盖整列，不只是先给的 5 条", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue(
      Array.from({ length: 8 }, (_, index) =>
        note({
          id: `d${index}`,
          title: `办完 ${index}`,
          status: "done",
          completedAt: index + 1,
        }),
      ),
    );
    render(<PixieTodoSection active onCount={onCount} />);
    await waitFor(() => expect(screen.getByTestId("pixie-todo-tab-done")).toHaveTextContent("8"));

    await user.click(screen.getByTestId("pixie-todo-tab-done"));
    await user.click(screen.getByTestId("pixie-todo-batch-toggle"));

    // 进入勾选模式即摊开整列，「全选」才谈得上覆盖全部。
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(screen.getByTestId("pixie-todo-select-all"));
    expect(screen.getByTestId("pixie-todo-batch-bar")).toHaveTextContent("8");

    // 进入模式后入口图标自己不收场，退出靠选择条上的 ✕。
    await user.click(screen.getByTestId("pixie-todo-batch-exit"));
    expect(screen.queryByTestId("pixie-todo-batch-bar")).toBeNull();
    // 退出时要把这次「被迫摊开」还回去：复选框换回状态圆圈，列表收回预览的 5 条。
    // （进入前本来是收着的，留着 8 条摊在那儿就是「关掉删除后没折叠」。）
    expect(screen.queryAllByTestId("pixie-todo-select")).toHaveLength(0);
    expect(screen.getAllByTestId("pixie-todo-complete")).toHaveLength(5);
  });

  it("云同步落地（MEMO_SYNCED_EVENT）后重新拉列表，不用等下一次操作", async () => {
    render(<PixieTodoSection active onCount={onCount} />);
    await waitForRows();
    expect(listMemoNotes).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));

    await waitFor(() => expect(listMemoNotes).toHaveBeenCalledTimes(2));
  });

  it("带图的记录：行上报张数，摊开才取图并渲染缩略图", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue([
      note({
        id: "n-pic",
        title: "拍下来的白板",
        contentMd: "拍下来的白板\n箭头是网关那条",
        images: [{ id: "img-1", fileName: "board.png", mediaType: "image/png", bytes: 10 }],
      }),
    ]);
    vi.mocked(readMemoImageDataUrl).mockResolvedValue("data:image/png;base64,AA==");
    render(<PixieTodoSection active onCount={onCount} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    // 没摊开也知道这条带图；图本身不提前取。
    expect(screen.getByTestId("pixie-todo-images")).toHaveTextContent("1");
    expect(readMemoImageDataUrl).not.toHaveBeenCalled();

    await user.click(within(rows()[0]).getByTestId("pixie-todo-open-detail"));
    await waitFor(() => expect(readMemoImageDataUrl).toHaveBeenCalledWith("n-pic", "img-1"));
    const detail = await screen.findByTestId("pixie-todo-detail");
    expect(within(detail).getByTestId("lightbox-image-trigger")).toHaveAttribute(
      "src",
      "data:image/png;base64,AA==",
    );
  });

  it("进行中的记录右键给「转回待处理」：解掉会话绑定，不然它出不来", async () => {
    const user = userEvent.setup();
    vi.mocked(listMemoNotes).mockResolvedValue([
      note({ id: "n-stuck", title: "卡在跑批上", status: "in_progress", sessionId: "s-gone" }),
    ]);
    render(
      <>
        <MenuHost />
        <PixieTodoSection active onCount={onCount} />
      </>,
    );
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.contextMenu(rows()[0]);
    await user.click(
      await screen.findByRole("menuitem", { name: "Back to to-do (unbind session)" }),
    );

    await waitFor(() =>
      expect(updateMemoNote).toHaveBeenCalledWith("n-stuck", {
        status: "open",
        sessionId: null,
      }),
    );
  });
});
