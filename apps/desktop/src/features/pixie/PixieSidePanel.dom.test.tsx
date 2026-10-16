/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  PixieTaskTreeSession,
  PixieTaskTreeTask,
  PixieTaskTreeWorkspace,
} from "@piabyss/protocol";
import { PIXIE_PANEL_COLLAPSED_KEY, useAppStore } from "../../lib/stores/app-store";
import { PixiePanelToggleButton } from "./PixiePanelToggleButton";
import {
  clampPixiePanelWidth,
  MAX_PIXIE_PANEL_WIDTH,
  MIN_PIXIE_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  PixieSidePanel,
  summarizePixieTasks,
} from "./PixieSidePanel";

/**
 * 小精灵页「随行面板」：
 *   - 面板本身可展开 / 折叠（负 margin 滑出，状态持久化）；
 *   - 宽度可拖拽 / 键盘调整，有下限与「给对话区留位」的上限，并持久化；
 *   - 面板内是「可折叠分组」栈：方寸间（常驻展开）/ 周期计划 / 委派任务；
 *   - 委派任务分组默认折叠，汇总信息在折叠态就能读到；
 *   - 行宽不足 672 时面板自动收起（与手动折叠同一个滑出），顶栏开关跟着消失。
 */
const DISPATCH_EXPANDED_PREF = "piabyss.pixie.dispatchExpanded";

// jsdom 没有 pointer capture，手柄上要调它。
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);

// 待办 / 周期计划两块各自还有一道插件门（与侧栏入口同一道）；这里放行，
// 好把「面板能装下三块分组」这件事单独断言出来。
vi.mock("../plugin-library/plugin-gate", () => ({
  usePluginEnabled: () => true,
  usePluginCatalogData: () => ({ catalog: null, packages: null }),
}));

vi.mock("./pixie-session-jump", () => ({
  jumpToPixieSession: vi.fn(async () => true),
}));

function task(overrides: Partial<PixieTaskTreeTask> = {}): PixieTaskTreeTask {
  return {
    dispatchId: "d1",
    label: "定位串号根因并出补丁",
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
      workspaceLabel: "okxbot",
      sessions: [
        {
          sessionId: "s-1",
          label: "修复登录态串号",
          sessionPath: "/sessions/s-1.jsonl",
          liveness: "active",
          tasks,
        } satisfies PixieTaskTreeSession,
      ],
    },
  ];
}

/** 面板根节点（与 RightDock 同款：按 data 属性取，不给它挂 testid）。 */
function panelEl(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-pixie-side-panel]")!;
}

/** 立刻回调一次，模拟「元素尺寸已知」；jsdom 里量到的宽度是 0（= 窄容器）。 */
let fireResize: (() => void) | null = null;
class ResizeObserverStub {
  constructor(private readonly callback: () => void) {}
  observe() {
    this.callback();
    fireResize = this.callback;
  }
  disconnect() {
    fireResize = null;
  }
}

/**
 * 给面板与它所在那一行喂假宽度：Tauri 启动时窗口尺寸是**恢复到位之后**才量得到的，
 * 首帧常量到一个偏小的行宽。这里用它模拟「先窄后宽」。
 */
function stubLayout(rowWidth: number, panelWidth: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const width = this.hasAttribute("data-pixie-side-panel") ? panelWidth : rowWidth;
    return { width } as DOMRect;
  });
}

beforeEach(() => {
  useAppStore.setState({
    pixiePanelOpen: true,
    pixiePanelWide: true,
    // 侧栏默认「展开、宽度未知」：面板判断点时不扣欠账，各用例单独设自己的情形。
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
    sidebarWidth: 0,
    desktopSettings: {
      language: "en",
      theme: "system",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.localStorage?.clear();
});

describe("PixieSidePanel 宽度拖拽", () => {
  it("没拖过时用 CSS 的 clamp 默认宽度（不写 inline width）", () => {
    render(<PixieSidePanel groups={[]} />);

    expect(panelEl().style.width).toBe("");
    expect(panelEl().className).toContain("w-[clamp(300px,30%,404px)]");
    expect(globalThis.localStorage?.getItem(PANEL_WIDTH_KEY)).toBeNull();
  });

  it("拖左侧边缘改宽度并持久化：往左拖变宽、往右拖变窄", () => {
    render(<PixieSidePanel groups={[]} />);
    const handle = screen.getByTestId("pixie-panel-resize");

    // 起点 = 兜底宽度 360（jsdom 量不到真实宽度），往左拖 100px → 460。
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(panelEl().style.width).toBe("460px");

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1050 });
    expect(panelEl().style.width).toBe("310px");

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(globalThis.localStorage?.getItem(PANEL_WIDTH_KEY)).toBe("310");
  });

  it("宽度有下限：怎么拖都不会比最低宽度更窄", () => {
    render(<PixieSidePanel groups={[]} />);
    const handle = screen.getByTestId("pixie-panel-resize");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 4000 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(panelEl().style.width).toBe(`${MIN_PIXIE_PANEL_WIDTH}px`);
    expect(Number.parseFloat(handle.getAttribute("aria-valuenow") ?? "0")).toBe(
      MIN_PIXIE_PANEL_WIDTH,
    );
    expect(handle).toHaveAttribute("aria-valuemin", String(MIN_PIXIE_PANEL_WIDTH));
  });

  it("键盘也能调：左右方向键各 ±20px，并同步 aria-valuenow", () => {
    render(<PixieSidePanel groups={[]} />);
    const handle = screen.getByTestId("pixie-panel-resize");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panelEl().style.width).toBe("380px");
    expect(handle).toHaveAttribute("aria-valuenow", "380");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panelEl().style.width).toBe("360px");
  });

  it("折叠后手柄不渲染（滑出去的把手不该还能拖）", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PixiePanelToggleButton />
        <PixieSidePanel groups={[]} />
      </>,
    );

    await user.click(screen.getByTestId("pixie-panel-toggle"));
    expect(screen.queryByTestId("pixie-panel-resize")).toBeNull();
  });

  it("重挂载后沿用存下来的宽度", () => {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, "520");
    render(<PixieSidePanel groups={[]} />);

    expect(panelEl().style.width).toBe("520px");
  });

  it("启动时量到窄窗口只压显示，不把存下来的宽度写坏", () => {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, "520");
    // 首帧：行宽只有 700（窗口尺寸还没恢复到位）→ 显示上限 700−360=340。
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubLayout(700, 340);
    render(<PixieSidePanel groups={[]} />);

    expect(panelEl().style.width).toBe("340px");

    // 窗口恢复到位再量一次：原偏好要能回来，缓存也不许被这 340 覆盖掉。
    stubLayout(1400, 520);
    act(() => fireResize?.());

    expect(panelEl().style.width).toBe("520px");
    expect(globalThis.localStorage?.getItem(PANEL_WIDTH_KEY)).toBe("520");
  });
});

describe("clampPixiePanelWidth", () => {
  it("下限优先于任何上限", () => {
    expect(clampPixiePanelWidth(100, 800)).toBe(MIN_PIXIE_PANEL_WIDTH);
    expect(clampPixiePanelWidth(Number.NaN, 0)).toBe(MIN_PIXIE_PANEL_WIDTH);
  });

  it("上限取「640」与「可用宽度 − 对话区最小宽度」里更小的那个", () => {
    expect(clampPixiePanelWidth(2000, 2000)).toBe(MAX_PIXIE_PANEL_WIDTH);
    // 可用 900 → 最多 540，先保对话区。
    expect(clampPixiePanelWidth(2000, 900)).toBe(540);
    // 窄到只剩 672（@3xl 边界）→ 上限 312，但仍不低于下限。
    expect(clampPixiePanelWidth(2000, 672)).toBe(312);
  });

  it("区间内的宽度原样保留（四舍五入到整数）", () => {
    expect(clampPixiePanelWidth(421.4, 1400)).toBe(421);
  });
});

describe("PixieSidePanel 展开 / 折叠", () => {
  it("面板内是「方寸间 → 周期计划 → 委派任务」三块分组", () => {
    render(<PixieSidePanel groups={[]} />);

    const ids = Array.from(
      document.querySelectorAll<HTMLElement>("[data-pixie-side-panel] section"),
    ).map((el) => el.dataset.testid);
    expect(ids).toEqual(["pixie-todo-section", "pixie-schedule-section", "pixie-dispatch-section"]);

    // 待办常驻展开；周期计划与委派任务默认折叠。
    expect(screen.getByTestId("pixie-todo-section")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("pixie-schedule-section")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("pixie-dispatch-section")).toHaveAttribute("data-open", "false");
  });

  it("默认展开：不写任何偏好，面板滑到位（margin-right 0）", () => {
    render(<PixieSidePanel groups={[]} />);

    expect(panelEl()).toHaveAttribute("data-panel-open", "true");
    expect(panelEl().style.marginRight).toBe("0px");
    expect(panelEl()).not.toHaveAttribute("aria-hidden");
    // 面板始终留在流里：窄容器不再靠 display:none 摘掉，而是由组件按 672px 阈值
    // 收起（滑出才有中间态可动画）。
    expect(panelEl().className).not.toContain("hidden");
    expect(globalThis.localStorage?.getItem(PIXIE_PANEL_COLLAPSED_KEY)).toBeNull();
  });

  it("点顶栏开关后右栏折叠（负 margin 滑出），再点回来", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PixiePanelToggleButton />
        <PixieSidePanel groups={[]} />
      </>,
    );

    await user.click(screen.getByTestId("pixie-panel-toggle"));

    expect(panelEl()).toHaveAttribute("data-panel-open", "false");
    expect(panelEl()).toHaveAttribute("aria-hidden", "true");
    expect(panelEl()).toHaveAttribute("inert");
    expect(Number.parseFloat(panelEl().style.marginRight)).toBeLessThan(0);
    expect(globalThis.localStorage?.getItem(PIXIE_PANEL_COLLAPSED_KEY)).toBe("1");

    await user.click(screen.getByTestId("pixie-panel-toggle"));

    expect(panelEl()).toHaveAttribute("data-panel-open", "true");
    expect(panelEl().style.marginRight).toBe("0px");
    expect(panelEl()).not.toHaveAttribute("aria-hidden");
  });

  it("折叠状态持久化：重新加载 store 后仍然是折叠的", async () => {
    useAppStore.getState().setPixiePanelOpen(false);
    expect(globalThis.localStorage?.getItem(PIXIE_PANEL_COLLAPSED_KEY)).toBe("1");

    // 重进应用 = 模块重新求值：初始值应当从 localStorage 读回来。
    vi.resetModules();
    const fresh = await import("../../lib/stores/app-store");
    expect(fresh.useAppStore.getState().pixiePanelOpen).toBe(false);
  });

  it("行宽不足 672 时自动收起：开关消失，面板滑出到不占位", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubLayout(600, 300);
    render(
      <>
        <PixiePanelToggleButton />
        <PixieSidePanel groups={[]} />
      </>,
    );

    expect(useAppStore.getState().pixiePanelWide).toBe(false);
    expect(screen.queryByTestId("pixie-panel-toggle")).toBeNull();
    // 与手动折叠同一个滑出：负 margin = 自身宽度，不再靠 display:none。
    expect(panelEl()).toHaveAttribute("data-panel-open", "false");
    expect(panelEl().style.marginRight).toBe("-300px");
    expect(panelEl()).toHaveAttribute("aria-hidden");
    expect(panelEl().className).not.toContain("hidden");
  });

  it("跨断点：拖窗口边缘才有动画，一次性 resize 瞬变", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.useFakeTimers();
    stubLayout(1400, 404);
    render(<PixieSidePanel groups={[]} />);
    expect(panelEl()).toHaveAttribute("data-panel-open", "true");

    // 密集连发（每帧一次）里跨过阈值 = 用户在拖窗口边缘 → 让它动。
    for (const [row, panel] of [
      [1000, 404],
      [800, 404],
      [600, 300],
    ] as const) {
      stubLayout(row, panel);
      vi.advanceTimersByTime(16);
      act(() => fireResize?.());
    }
    expect(panelEl()).toHaveAttribute("data-panel-open", "false");
    expect(panelEl()).not.toHaveAttribute("data-panel-instant");

    // 一次孤立的 resize（贴边 / 托盘 / DPI）= 不是用户在驱动 → 瞬变。
    stubLayout(1400, 404);
    vi.advanceTimersByTime(1000);
    act(() => fireResize?.());
    expect(panelEl()).toHaveAttribute("data-panel-open", "true");
    expect(panelEl()).toHaveAttribute("data-panel-instant", "true");

    vi.useRealTimers();
  });

  it("侧栏迟早要弹回来占的那一格先扣掉，面板不在它弹回时被挤没", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    useAppStore.setState({
      sidebarCollapsed: true,
      sidebarAutoCollapsed: true,
      sidebarWidth: 268,
    });
    // 行宽 800 看着够 672，但侧栏是「窗口宽度自动规则」收起来的，再拉宽一点就会
    // 自己弹回来拿走 268 → 800−268=532，压根放不下，所以这一步就不该先展开。
    stubLayout(800, 404);
    render(
      <>
        <PixiePanelToggleButton />
        <PixieSidePanel groups={[]} />
      </>,
    );

    expect(panelEl()).toHaveAttribute("data-panel-open", "false");
    expect(screen.queryByTestId("pixie-panel-toggle")).toBeNull();

    // 侧栏真的弹回来了：行宽掉到 532、欠账归零，指标没变，状态也不许跟着翻。
    useAppStore.setState({ sidebarCollapsed: false, sidebarAutoCollapsed: false });
    stubLayout(532, 404);
    act(() => fireResize?.());

    expect(panelEl()).toHaveAttribute("data-panel-open", "false");
    expect(useAppStore.getState().pixiePanelWide).toBe(false);
  });

  it("侧栏弹回的那 200ms 里不提前放手预留：面板不会闪一下", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.useFakeTimers();
    useAppStore.setState({
      sidebarCollapsed: true,
      sidebarAutoCollapsed: true,
      sidebarWidth: 268,
    });
    stubLayout(900, 404);
    render(<PixieSidePanel groups={[]} />);
    expect(panelEl()).toHaveAttribute("data-panel-open", "false");

    // 侧栏开始弹回：store 的标志先翻，行宽要 200ms 才掉到位。途中量到 760 ——
    // 预留要是跟着标志一起放手，760 就够展开了，接着落位 632 又得收回去（闪一下）。
    useAppStore.setState({ sidebarCollapsed: false, sidebarAutoCollapsed: false });
    stubLayout(760, 404);
    act(() => fireResize?.());
    expect(panelEl()).toHaveAttribute("data-panel-open", "false");

    // 撑过侧栏的过渡期才放手；放手后行宽已经落到位，指标不再跳。
    act(() => vi.advanceTimersByTime(300));
    stubLayout(632, 404);
    act(() => fireResize?.());
    expect(panelEl()).toHaveAttribute("data-panel-open", "false");

    // 真放得下了才展开。
    stubLayout(700, 404);
    act(() => fireResize?.());
    expect(panelEl()).toHaveAttribute("data-panel-open", "true");

    vi.useRealTimers();
  });

  it("手动收起的侧栏不会被自动弹回，不给它预留宽度", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    useAppStore.setState({
      sidebarCollapsed: true,
      sidebarAutoCollapsed: false,
      sidebarWidth: 268,
    });
    stubLayout(800, 404);
    render(<PixieSidePanel groups={[]} />);

    expect(panelEl()).toHaveAttribute("data-panel-open", "true");
  });
});

describe("委派任务分组", () => {
  it("默认折叠：只占一行，任务树不渲染", () => {
    render(<PixieSidePanel groups={groups([task()])} />);

    expect(screen.getByTestId("pixie-dispatch-section")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("pixie-task-tree")).toBeNull();
    expect(screen.getByTestId("pixie-dispatch-section-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("点分组头后展开，渲染出原来的两层任务树；展开状态不写盘", async () => {
    const user = userEvent.setup();
    render(<PixieSidePanel groups={groups([task()])} />);

    await user.click(screen.getByTestId("pixie-dispatch-section-toggle"));

    expect(screen.getByTestId("pixie-dispatch-section")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("pixie-dispatch-section-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("pixie-task-tree")).toBeInTheDocument();
    expect(screen.getByText("okxbot · 修复登录态串号")).toBeInTheDocument();
    // 只活在本次挂载里：下次进小精灵仍是「方寸间展开、其余折叠」，不会被他某一次
    // 顺手点开的那块永久顶掉。
    expect(globalThis.localStorage?.getItem(DISPATCH_EXPANDED_PREF)).toBeNull();
  });

  it("折叠态就能读到汇总：1 进行中 · 1 等你回复", () => {
    render(
      <PixieSidePanel
        groups={groups([
          task(),
          task({ dispatchId: "d2", statusDetail: "awaiting_user", kind: "ask" }),
        ])}
      />,
    );

    expect(screen.getByText("1 running · 1 awaiting you")).toBeInTheDocument();
    // 计数徽章 = 总任务数（折叠态唯一的结构信息）。
    expect(screen.getByTestId("pixie-dispatch-section-toggle")).toHaveTextContent(
      "Delegated tasks2",
    );
  });

  it("没有活动委派时不给汇总 hint，只留计数徽章", () => {
    render(
      <PixieSidePanel groups={groups([task({ status: "done", statusDetail: "reported" })])} />,
    );

    expect(screen.queryByText("1 running")).toBeNull();
    expect(screen.queryByText(/awaiting you/)).toBeNull();
    expect(screen.getByTestId("pixie-dispatch-section-toggle")).toHaveTextContent(
      "Delegated tasks1",
    );
  });

  it("空树：计数为 0，展开后是空态文案", async () => {
    const user = userEvent.setup();
    render(<PixieSidePanel groups={[]} />);

    expect(screen.getByTestId("pixie-dispatch-section-toggle")).toHaveTextContent(
      "Delegated tasks0",
    );

    await user.click(screen.getByTestId("pixie-dispatch-section-toggle"));
    expect(screen.getByText("No delegated tasks yet")).toBeInTheDocument();
  });
});

describe("summarizePixieTasks", () => {
  it("等你回复从进行中里单列出来，两者互斥计数", () => {
    expect(
      summarizePixieTasks(
        groups([
          task(),
          task({ dispatchId: "d2", statusDetail: "awaiting_user" }),
          task({ dispatchId: "d3", status: "queued", statusDetail: "queued" }),
          task({ dispatchId: "d4", status: "done", statusDetail: "reported" }),
        ]),
      ),
    ).toEqual({ total: 4, running: 1, awaiting: 1 });
  });
});
