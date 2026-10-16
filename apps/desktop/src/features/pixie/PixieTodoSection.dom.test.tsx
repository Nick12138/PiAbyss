/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import {
  completeMemoNote,
  createMemoNote,
  deleteMemoNote,
  listMemoNotes,
} from "../memo/memo-client";
import { injectMemoReference } from "../memo/memo-agent";
import { PixieTodoSection } from "./PixieTodoSection";

/**
 * 随行面板「待办 · 方寸间」：概览 / 页签 / 日期分组 / 就地详情 / 两个新建入口。
 * 数据与方寸间页同源（memo-client），这里只验面板自己的组织方式与动作路由。
 */
vi.mock("../plugin-library/plugin-gate", () => ({
  usePluginEnabled: () => true,
  usePluginCatalogData: () => ({ catalog: null, packages: null }),
}));

vi.mock("../memo/memo-client", () => ({
  listMemoNotes: vi.fn(),
  createMemoNote: vi.fn(),
  completeMemoNote: vi.fn(),
  deleteMemoNote: vi.fn(),
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

function overviewCell(cell: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-cell="${cell}"]`)!;
}

function buckets(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="pixie-todo-bucket"]'),
  ).map((el) => el.dataset.bucket ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMemoNotes).mockResolvedValue(FIXTURE);
  vi.mocked(createMemoNote).mockResolvedValue(note());
  vi.mocked(completeMemoNote).mockResolvedValue(note({ status: "done" }));
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
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
  globalThis.localStorage?.clear();
});

describe("PixieTodoSection", () => {
  it("概览三格与页签计数来自同一份数据（进行中不单独分区）", async () => {
    render(<PixieTodoSection />);
    await waitFor(() => expect(overviewCell("open")).toBeInTheDocument());

    expect(overviewCell("open")).toHaveTextContent("2");
    expect(overviewCell("inProgress")).toHaveTextContent("1");
    expect(overviewCell("overdue")).toHaveTextContent("1");
    // 分组头计数 = 待处理总数；折叠态唯一的状态信息。
    expect(screen.getByTestId("pixie-todo-section-toggle")).toHaveTextContent("2");
  });

  it("待处理按日期落位：逾期在前、无日期的沉底", async () => {
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    expect(buckets()).toEqual(["overdue", "none"]);
    expect(screen.getByText("回复张工的邮件")).toBeInTheDocument();
    expect(screen.getByText("修复登录态串号")).toBeInTheDocument();
    // 已完成不进「待处理」页签。
    expect(screen.queryByText("订会议室")).toBeNull();
  });

  it("切到「已完成」页签看已完成的记录", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.click(screen.getByTestId("pixie-todo-tab-done"));

    expect(screen.getByText("订会议室")).toBeInTheDocument();
    expect(screen.queryByText("回复张工的邮件")).toBeNull();
  });

  it("就地展开详情：正文 / 标签 / 工作区 / 截止 + 三个动作", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    const rows = screen.getAllByTestId("pixie-todo-open-detail");
    await user.click(rows[0]);

    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/网关不支持自定义 header 透传/)).toBeInTheDocument();
    const detail = screen.getByTestId("pixie-todo-detail");
    expect(within(detail).getByText("#邮件")).toBeInTheDocument();
    expect(within(detail).getByText("文案库")).toBeInTheDocument();
    expect(within(detail).getByText("Due")).toBeInTheDocument();
    expect(screen.getByTestId("pixie-todo-handoff")).toBeInTheDocument();
    expect(screen.getByTestId("pixie-todo-edit")).toBeInTheDocument();
    expect(screen.getByTestId("pixie-todo-delete")).toBeInTheDocument();
  });

  it("勾选标记完成，列表随之刷新", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.click(screen.getAllByTestId("pixie-todo-complete")[0]);

    await waitFor(() => expect(completeMemoNote).toHaveBeenCalledWith("n-overdue"));
    expect(listMemoNotes).toHaveBeenCalledTimes(2);
  });

  it("「交给小精灵」把记录以引用胶囊注入当前会话草稿，不新开会话", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.click(screen.getAllByTestId("pixie-todo-open-detail")[0]);
    await user.click(screen.getByTestId("pixie-todo-handoff"));

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

  it("速记框 Enter 落一条：标题取首行、#标签 自动识别", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

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
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.type(screen.getByTestId("pixie-todo-quick"), "第一行{Shift>}{Enter}{/Shift}第二行");

    expect(createMemoNote).not.toHaveBeenCalled();
    expect(screen.getByTestId("pixie-todo-quick")).toHaveValue("第一行\n第二行");
  });

  it("多功能表单一次设好标题 / 截止 / 标签 / 工作区", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.click(screen.getByTestId("pixie-todo-new"));
    expect(screen.getByTestId("pixie-todo-form")).toBeInTheDocument();
    // 表单展开时速记框收起，两块新建 UI 不叠在一起。
    expect(screen.queryByTestId("pixie-todo-quick")).toBeNull();

    await user.type(screen.getByTestId("pixie-todo-form-title"), "订会议室");
    await user.type(screen.getByTestId("pixie-todo-form-due"), "2026-10-16T18:00");
    await user.type(screen.getByTestId("pixie-todo-form-tags"), "会议, 行政");
    await user.selectOptions(screen.getByTestId("pixie-todo-form-workspace"), "/work/okxbot");
    await user.click(screen.getByTestId("pixie-todo-form-submit"));

    await waitFor(() => expect(createMemoNote).toHaveBeenCalledTimes(1));
    const input = vi.mocked(createMemoNote).mock.calls[0][0];
    expect(input.title).toBe("订会议室");
    expect(input.tags).toEqual(["会议", "行政"]);
    expect(input.workspaceHint).toBe("/work/okxbot");
    expect(input.dueAt).toBe(new Date("2026-10-16T18:00").getTime());
  });

  it("删除要再点一次确认", async () => {
    const user = userEvent.setup();
    render(<PixieTodoSection />);
    await waitFor(() => expect(buckets().length).toBeGreaterThan(0));

    await user.click(screen.getAllByTestId("pixie-todo-open-detail")[0]);
    await user.click(screen.getByTestId("pixie-todo-delete"));
    expect(deleteMemoNote).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("pixie-todo-delete"));
    await waitFor(() => expect(deleteMemoNote).toHaveBeenCalledWith("n-overdue"));
  });
});
