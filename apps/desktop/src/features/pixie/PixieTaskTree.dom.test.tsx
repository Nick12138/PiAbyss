/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PixieTaskJump, PixieTaskTreeTask, PixieTaskTreeWorkspace } from "@piabyss/protocol";
import { PixieTaskTree, type PixieTaskActions } from "./PixieTaskTree";

vi.mock("./pixie-task-jump", () => ({
  canJumpToPixieTask: vi.fn((jump: PixieTaskJump) => Boolean(jump.sessionId || jump.sessionPath)),
  jumpToPixieTask: vi.fn(async () => true),
}));

const { jumpToPixieTask } = await import("./pixie-task-jump");

function task(overrides: Partial<PixieTaskTreeTask> = {}): PixieTaskTreeTask {
  return {
    dispatchId: "d1",
    label: "跑登录测试",
    status: "running",
    statusDetail: "dispatched",
    kind: null,
    question: null,
    options: [],
    failCount: 0,
    stale: false,
    createdAt: Date.now(),
    lastActiveAt: null,
    dispatchMessageId: "entry-1",
    reportMessageId: null,
    jump: {
      cwd: "C:/work/PiAbyss",
      sessionId: "s-1",
      sessionPath: "C:/agent/sessions/s-1.jsonl",
      messageId: "entry-1",
      anchor: "dispatch",
    },
    ...overrides,
  } as PixieTaskTreeTask;
}

function groups(tasks: PixieTaskTreeTask[]): PixieTaskTreeWorkspace[] {
  return [
    {
      cwd: "C:/work/PiAbyss",
      workspaceLabel: "PiAbyss",
      sessions: [{ sessionId: "s-1", label: "登录修复", tasks }],
    },
  ];
}

function actions(): PixieTaskActions {
  return {
    onReply: vi.fn(),
    onInterject: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(jumpToPixieTask).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("PixieTaskTree", () => {
  it("渲染三层：工作区名 / 会话名 / 任务短名 + 四态", () => {
    render(
      <PixieTaskTree
        groups={groups([task(), task({ dispatchId: "d2", label: "整理周报", status: "done" })])}
        actions={actions()}
      />,
    );
    expect(screen.getByText("PiAbyss")).toBeInTheDocument();
    expect(screen.getByText("登录修复")).toBeInTheDocument();
    expect(screen.getByText("跑登录测试")).toBeInTheDocument();
    expect(screen.getByText("整理周报")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("空树给出空态文案", () => {
    render(<PixieTaskTree groups={[]} actions={actions()} />);
    expect(screen.getByText("No delegated tasks yet")).toBeInTheDocument();
  });

  it("点击定位按钮跳到该任务的锚点坐标", async () => {
    const user = userEvent.setup();
    render(<PixieTaskTree groups={groups([task()])} actions={actions()} />);
    await user.click(screen.getByTestId("pixie-task-jump"));
    await waitFor(() =>
      expect(jumpToPixieTask).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "entry-1", anchor: "dispatch" }),
      ),
    );
  });

  it("结果回执锚点优先：跳转坐标指向小精灵段会话", async () => {
    const user = userEvent.setup();
    const withReport = task({
      reportMessageId: "entry-9",
      jump: {
        cwd: "C:/agent/workspace/pixie",
        sessionId: "seg-1",
        sessionPath: "C:/agent/sessions/seg-1.jsonl",
        messageId: "entry-9",
        anchor: "report",
      },
    });
    render(<PixieTaskTree groups={groups([withReport])} actions={actions()} />);
    await user.click(screen.getByTestId("pixie-task-jump"));
    await waitFor(() =>
      expect(jumpToPixieTask).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "seg-1", messageId: "entry-9" }),
      ),
    );
  });

  it("老记录没有锚点：按钮仍会打开会话，只是不滚动（messageId 为 null）", async () => {
    const user = userEvent.setup();
    const legacy = task({
      dispatchMessageId: null,
      jump: { ...task().jump, messageId: null, anchor: null },
    });
    render(<PixieTaskTree groups={groups([legacy])} actions={actions()} />);
    const button = screen.getByTestId("pixie-task-jump");
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() =>
      expect(jumpToPixieTask).toHaveBeenCalledWith(expect.objectContaining({ messageId: null })),
    );
  });

  it("任务从未落点（无会话 id 也无路径）时禁用定位", () => {
    const stranded = task({
      dispatchMessageId: null,
      jump: {
        cwd: "C:/work/PiAbyss",
        sessionId: null,
        sessionPath: null,
        messageId: null,
        anchor: null,
      },
    });
    render(<PixieTaskTree groups={groups([stranded])} actions={actions()} />);
    expect(screen.getByTestId("pixie-task-jump")).toBeDisabled();
  });

  it("展开任务行只多出操作区，不多出正文；等答复的行内能回复", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const asking = task({
      statusDetail: "awaiting_user",
      status: "running",
      kind: "ask",
      question: "选哪个方案？",
    });
    render(<PixieTaskTree groups={groups([asking])} actions={handlers} />);
    const row = document.querySelector('[data-testid="pixie-task-row"]')!;
    await user.click(row.querySelector("button")!);
    expect(screen.getByText("选哪个方案？")).toBeInTheDocument();
    const input = screen.getByTestId("pixie-dispatch-reply-input");
    await user.type(input, "方案 A");
    await user.keyboard("{Enter}");
    expect(handlers.onReply).toHaveBeenCalledWith("d1", "方案 A");
  });

  it("失败任务展开后给出续跑与重派", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(
      <PixieTaskTree
        groups={groups([task({ status: "failed", statusDetail: "failed" })])}
        actions={handlers}
      />,
    );
    const row = document.querySelector('[data-testid="pixie-task-row"]')!;
    await user.click(row.querySelector("button")!);
    await user.click(screen.getByTestId("pixie-dispatch-resume"));
    expect(handlers.onRetry).toHaveBeenCalledWith("d1", "resume");
  });

  it("收起工作区节点后任务不再渲染", async () => {
    const user = userEvent.setup();
    render(<PixieTaskTree groups={groups([task()])} actions={actions()} />);
    await user.click(screen.getByText("PiAbyss"));
    expect(document.querySelectorAll('[data-testid="pixie-task-row"]').length).toBe(0);
  });
});
