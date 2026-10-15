/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PixieTaskTreeTask, PixieTaskTreeWorkspace } from "@piabyss/protocol";
import { PixieTaskTree } from "./PixieTaskTree";

vi.mock("./pixie-session-jump", () => ({
  jumpToPixieSession: vi.fn(async () => true),
}));

const { jumpToPixieSession } = await import("./pixie-session-jump");

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

beforeEach(() => {
  vi.mocked(jumpToPixieSession).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("PixieTaskTree", () => {
  it("两层：工作区名并进会话行当前缀，任务挂在它下面", () => {
    render(
      <PixieTaskTree
        groups={groups([task(), task({ dispatchId: "d2", label: "整理周报", status: "done" })])}
      />,
    );
    expect(document.querySelectorAll('[data-testid="pixie-task-group"]').length).toBe(1);
    expect(screen.getByText("PiAbyss · 登录修复")).toBeInTheDocument();
    expect(screen.getByText("跑登录测试")).toBeInTheDocument();
    expect(screen.getByText("整理周报")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("未落点的记录（没有会话 id）只显工作区名，不写成「PiAbyss · PiAbyss」", () => {
    render(
      <PixieTaskTree
        groups={[
          {
            cwd: "C:/work/PiAbyss",
            workspaceLabel: "PiAbyss",
            sessions: [{ sessionId: "", label: "PiAbyss", tasks: [task()] }],
          },
        ]}
      />,
    );
    expect(screen.getByText("PiAbyss")).toBeInTheDocument();
    expect(screen.queryByText(/PiAbyss · /)).toBeNull();
  });

  it("空树给出空态文案", () => {
    render(<PixieTaskTree groups={[]} />);
    expect(screen.getByText("No delegated tasks yet")).toBeInTheDocument();
  });

  it("任务行不挂任何按钮：既没有操作入口，也没有跳转", () => {
    render(<PixieTaskTree groups={groups([task()])} />);
    const row = document.querySelector<HTMLElement>('[data-testid="pixie-task-row"]')!;
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(row.querySelector("[aria-expanded]")).toBeNull();
    expect(row.querySelector("input")).toBeNull();
  });

  it("等用户答复的任务在「进行中」里被单独点出来", () => {
    render(
      <PixieTaskTree
        groups={groups([
          task({ statusDetail: "awaiting_user", kind: "ask", question: "选哪个？" }),
        ])}
      />,
    );
    expect(screen.getByText("waiting on you")).toBeInTheDocument();
    // 问题正文仍然不进面板
    expect(screen.queryByText("选哪个？")).toBeNull();
  });

  it("跳转按会话给：点会话行的按钮打开这个会话，不定位到消息", async () => {
    const user = userEvent.setup();
    render(<PixieTaskTree groups={groups([task()])} />);
    await user.click(screen.getByTestId("pixie-session-jump"));
    expect(jumpToPixieSession).toHaveBeenCalledWith({
      cwd: "C:/work/PiAbyss",
      sessionId: "s-1",
    });
  });

  it("未落点的分组行（没有会话 id）不给跳转按钮", () => {
    render(
      <PixieTaskTree
        groups={[
          {
            cwd: "C:/work/PiAbyss",
            workspaceLabel: "PiAbyss",
            sessions: [{ sessionId: "", label: "PiAbyss", tasks: [task()] }],
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("pixie-session-jump")).toBeNull();
  });

  it("收起分组行后任务不再渲染", async () => {
    const user = userEvent.setup();
    render(<PixieTaskTree groups={groups([task()])} />);
    await user.click(screen.getByText("PiAbyss · 登录修复"));
    expect(document.querySelectorAll('[data-testid="pixie-task-row"]').length).toBe(0);
  });
});
