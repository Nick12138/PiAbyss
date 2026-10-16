/**
 * 小精灵页右侧「随行面板」——可展开 / 折叠，与对话同屏、不切页。
 *
 * 折叠机制照抄普通会话的右侧 dock（`components/RightDock.tsx`）：不卸载，靠
 * **负 margin 滑出**（宽度保留），父级 `[data-piabyss-app]` 的 overflow-hidden
 * 负责裁掉滑出去的那部分。开关在顶栏（`AppTopBar`），所以展开状态放在 app-store
 * （`pixiePanelOpen`），与 `dockOpen` 并排。
 *
 * 开合动效不在这里的 className 上，而在 `styles/index.css` 的 `[data-pixie-side-panel]`
 * 一组规则里：外层平移 + 内层（`[data-pixie-panel-content]`）淡出让位，收起快、展开慢。
 * 不该动的场合挂 `data-panel-instant="true"` 把过渡整体压掉——正在拖宽度（要跟手）、
 * 以及一次性 resize 跨断点（见下面的 `layout-motion` 口径）。
 *
 * 面板内容是**横排的三块页签**（设计稿 `pixie-merge-C.html` 的三块，竖排折叠已改成这个）：
 *   1. 方寸间        —— `PixieTodoSection`
 *   2. 周期计划      —— `PixieScheduleSection`
 *   3. 委派任务      —— 本文件，数据由 `PixiePage` 轮询后传入
 * 一次只看一块，导航就是顶栏那 32px（面板标题「随行面板」随之删掉，名字留给 `aria-label`）。
 * 三块都留在 DOM 里、未选中的只摘显示，所以每块自己拉的数据一直活着、页签上的计数不会停更。
 * 再加分组只要往 `tabs` 里插一项 + 插一个 section（外壳 `PixiePanelTabs` 已经统一）。
 *
 * 插件门在这里，不在各块里：被禁用的那块**连页签都不该有**，所以 `usePluginEnabled` /
 * `useSchedulePluginEnabled` 由面板判，块本身不再各自 return null。
 *
 * 内容区**不留内缩**（面板已有 `border-l`，各块自己 `px-3`）；曾经这里是 `p-3` +
 * 每块一圈圆角边框，左右各白吃 ~10px、上下各多 24px，窄面板里不值。
 *
 * 断点：扣完侧栏欠账的行宽不足 `PIXIE_PANEL_BREAKPOINT_PX` 时面板**自动收起**（不是
 * `display:none`，见下），够宽时是否展开才由手动开关决定。手动开关在窄容器下没有意义，
 * 所以 `pixiePanelWide` 一并由这条阈值驱动，为 false 时顶栏开关消失。
 *
 * 为什么断点从 CSS 挪到 JS：`display:none` 没有中间态，跨断点那一下必然是硬切。挪进来
 * 之后自动收起与手动折叠走**同一个滑出**，拖窗口边缘过断点就有动画；而启动 / 托盘 /
 * 贴边 / DPI 这类一次性 resize 不属于「用户在驱动」，按 `lib/layout-motion.ts` 的口径
 * 一步到位（`data-panel-instant`），免得界面看着像自己在动。
 *
 * 为什么判的是「扣完侧栏欠账的行宽」：左导航栏也有一条窗口宽度自动规则，拉宽到某个点
 * 它会自己弹回来、从内容区拿走一整个侧栏宽度。面板若按**当前**行宽判定，就会先在侧栏
 * 弹回之前展开、紧接着被挤没、再拉宽又展开——同一次拉宽里翻三次烙饼。扣掉这笔迟早要还
 * 的宽度之后，指标在侧栏切换的那一瞬间是连续的，面板只在自己该动的时候动。
 *
 * 宽度：默认 `w-[clamp(300px,30%,404px)]`（设计稿 rail 的口径——跟着容器走但有上下
 * 限）；拖左侧边缘（或聚焦后按左右方向键）可改成显式像素宽度，带下限 300px、上限
 * 640px（且至少给对话区留 360px），并持久化。手柄与钳制口径照抄 `RightDock`。
 * 持久化的是**偏好**，窄窗口只收敛显示、不回写偏好，否则一次「变窄再变宽」就把
 * 缓存削到下限（见 `panelWidth`）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Crosshair, ListTodo } from "lucide-react";
import type { PixieTaskTreeWorkspace } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { classifyDragResize } from "../../lib/layout-motion";
import { usePluginEnabled } from "../plugin-library/plugin-gate";
import { useSchedulePluginEnabled } from "../schedule/schedule-plugin-gate";
import {
  PixiePanelBody,
  PixiePanelTabBar,
  type PixiePanelTab,
  type PixiePanelTabId,
} from "./PixiePanelTabs";
import { PixieScheduleSection } from "./PixieScheduleSection";
import { PixieTaskTree } from "./PixieTaskTree";
import { PixieTodoSection } from "./PixieTodoSection";

const MEMO_PLUGIN_ID = "piabyss-memo";

/** 用户拖出来的面板宽度（localStorage）；没拖过就用 CSS 的 `clamp(...)`。 */
export const PANEL_WIDTH_KEY = "piabyss.pixie.panelWidth.v1";

/**
 * 面板**收起**阈值（行宽，已扣掉侧栏欠账，见 `sidebarDebt`）。取 672 是为了和
 * `use-container-wide.ts` 的双栏阈值严格一致（index.css 把 `--container-2xl` 覆盖成
 * 672px 就是为了这个数）。原来这条阈值只活在 CSS 容器查询里（`@3xl` = 48rem，本应用
 * `:root` 14px → 672px）；现在断点归 JS 管，别在样式里再留一份 `@3xl` 显隐，会打架。
 */
export const PIXIE_PANEL_BREAKPOINT_PX = 672;

/**
 * 展开阈值要比收起阈值多让出这一截：窗口停在阈值上 1px 来回（缓慢拖边缘、DPI 取整）
 * 时，面板不该反复开合。口径同 `lib/sidebar-auto-collapse.ts` 的
 * `SIDEBAR_AUTO_EXPAND_HYSTERESIS`（那条是 120，因为侧栏一挡就是两百多 px）。
 */
export const PIXIE_PANEL_EXPAND_HYSTERESIS_PX = 24;
export const PIXIE_PANEL_EXPAND_WIDTH_PX =
  PIXIE_PANEL_BREAKPOINT_PX + PIXIE_PANEL_EXPAND_HYSTERESIS_PX;

/**
 * 侧栏弹回后，预留还要再撑这么久才放手。`Sidebar` 的宽度过渡是 200ms，这里多留
 * 一帧的余量；期间行宽还在往下掉，提前放手游标就虚高，面板会闪一下再被挤没。
 */
const SIDEBAR_SETTLE_MS = 240;

/** 面板宽度下限：比设计稿 rail 的窄屏档（310）再留一点余量。 */
export const MIN_PIXIE_PANEL_WIDTH = 300;
/** 面板宽度上限：拖拽时允许比默认更宽，但仍要给对话留主位。 */
export const MAX_PIXIE_PANEL_WIDTH = 640;
/** 面板再宽也要给对话区留出的宽度。 */
const MIN_CONVERSATION_WIDTH = 360;
/** 键盘调整的步长（左右方向键），与右侧 dock 同口径。 */
const PANEL_RESIZE_STEP = 20;

/**
 * 量不到面板宽度时的滑出距离兜底：无布局引擎的环境（jsdom）与首帧。真机上
 * useLayoutEffect 在首次绘制前就量到了真实宽度，用不到这个值。
 */
const FALLBACK_PANEL_WIDTH = 360;

/**
 * 面板宽度的钳制（同 `RightDock.clampDockWidth` 的思路）：下限固定，上限取
 * 「640px」与「可用宽度 − 对话区最小宽度」里更小的那个——窄窗口下先保对话区，
 * 宽度不够时下限优先。
 */
export function clampPixiePanelWidth(width: number, availableWidth: number): number {
  const responsiveMax = Math.max(
    MIN_PIXIE_PANEL_WIDTH,
    Math.min(MAX_PIXIE_PANEL_WIDTH, Math.round(availableWidth) - MIN_CONVERSATION_WIDTH),
  );
  if (!Number.isFinite(width)) return Math.min(MIN_PIXIE_PANEL_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_PIXIE_PANEL_WIDTH, Math.round(width)));
}

/** 读回用户拖出来的宽度；没存过 / 存坏了都返回 null（= 用 CSS 默认宽度）。 */
function readStoredPanelWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_WIDTH_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export type PixieDispatchSummary = {
  total: number;
  running: number;
  awaiting: number;
};

/**
 * 折叠态那一行要说的全部信息：总数（徽章）+ 进行中 / 等你回复（汇总 hint）。
 * 「等你回复」是「进行中」里的一个特例（四态不带这个信息），所以两者互斥计数。
 */
export function summarizePixieTasks(groups: PixieTaskTreeWorkspace[]): PixieDispatchSummary {
  const summary: PixieDispatchSummary = { total: 0, running: 0, awaiting: 0 };
  for (const group of groups) {
    for (const session of group.sessions) {
      for (const task of session.tasks) {
        summary.total += 1;
        if (task.statusDetail === "awaiting_user") summary.awaiting += 1;
        else if (task.status === "running") summary.running += 1;
      }
    }
  }
  return summary;
}

export function PixieSidePanel({ groups }: { groups: PixieTaskTreeWorkspace[] }) {
  const t = useT();
  const open = useAppStore((state) => state.pixiePanelOpen);
  const setPixiePanelWide = useAppStore((state) => state.setPixiePanelWide);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const sidebarAutoCollapsed = useAppStore((state) => state.sidebarAutoCollapsed);
  const navSidebarWidth = useAppStore((state) => state.sidebarWidth);
  const memoEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const scheduleEnabled = useSchedulePluginEnabled();
  const asideRef = useRef<HTMLElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [customWidth, setCustomWidth] = useState<number | null>(readStoredPanelWidth);
  const [rowWidth, setRowWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [wide, setWide] = useState(true);
  const [programmatic, setProgrammatic] = useState(false);
  const [tab, setTab] = useState<PixiePanelTabId>("todo");
  /**
   * 三块的计数住在各块里（数据也在那里），页签只是把报上来的数字画出来。
   * 未选中的那块仍然挂载（见 `PixiePanelBody`），所以页签上的计数一直跟着数据走。
   */
  const [counts, setCounts] = useState<Record<PixiePanelTabId, number>>({
    todo: 0,
    schedule: 0,
    dispatch: 0,
  });
  const onCount = useMemo<Record<PixiePanelTabId, (count: number) => void>>(
    () => ({
      // 同值直接返回原对象：否则子组件的 effect 会被父组件的重渲染再喂一轮。
      todo: (count) => setCounts((c) => (c.todo === count ? c : { ...c, todo: count })),
      schedule: (count) => setCounts((c) => (c.schedule === count ? c : { ...c, schedule: count })),
      dispatch: (count) => setCounts((c) => (c.dispatch === count ? c : { ...c, dispatch: count })),
    }),
    [],
  );
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  /** 行宽读数与「这次变化是不是用户在拖窗口边缘」：断点判定与动画门都靠它。 */
  const layoutRead = useRef({ at: 0, count: 0, rowWidth: 0, isDrag: false });

  /**
   * 侧栏欠下的宽度。它现在是收起的、而且收的原因是**窗口宽度自动规则**（只有这种
   * 会在继续拉宽时自己弹回来），那么这一格迟早要从行宽里扣掉。先扣再判，面板看的
   * 就是「侧栏弹回来之后还剩多少」：侧栏状态切换那一瞬间行宽会跳一个
   * `sidebarWidth`，扣完的指标却不动，于是面板不会跟着翻脸（先展开、被挤没、再展开
   * ——就是拉宽窗口时看到的那次抖动）。用户手动收起的侧栏不会被自动弹回，不预留。
   *
   * 预留**撑到侧栏抢完宽度才放手**：侧栏弹回是一段 200ms 的宽度过渡，store 的标志先翻、
   * 行宽后掉，中间这段如果按「欠账已归零」判，指标会虚高一整个侧栏宽度，面板就在
   * 这儿展开一下、等侧栏落位又被挤没（一次闪烁）。
   */
  const liveSidebarDebt = sidebarCollapsed && sidebarAutoCollapsed ? navSidebarWidth : 0;
  const [sidebarDebt, setSidebarDebt] = useState(liveSidebarDebt);
  useLayoutEffect(() => {
    if (liveSidebarDebt > 0) {
      // 侧栏收起：立刻预留。用 layout effect 是为了这一格和后面的判定同一帧落地，
      // 否则第一帧会按「没有欠账」画出一个展开的面板再收回去。
      setSidebarDebt(liveSidebarDebt);
      return;
    }
    if (sidebarDebt === 0) return;
    const settle = setTimeout(() => setSidebarDebt(0), SIDEBAR_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [liveSidebarDebt, sidebarDebt]);

  const roomyWidth = rowWidth > 0 ? Math.max(0, rowWidth - sidebarDebt) : 0;

  /**
   * 面板宽度 = 默认 `w-[clamp(300px,30%,404px)]`（设计稿的 rail 口径：跟着
   * 容器走但有上下限），用户拖过之后换成显式像素宽度。
   *
   * 这里只量、不判定：记下行宽、记下滑出距离、记下落点是不是密集连发（= 用户在拖
   * 窗口边缘，见 `lib/layout-motion.ts`）。断点判定在下面的 `wide` 那条Effect里。
   */
  useLayoutEffect(() => {
    const el = asideRef.current;
    // 量不到布局的环境保持 store 默认值（开关可见），显隐交给下面的行宽判定。
    if (!el || typeof ResizeObserver === "undefined") return;
    const parent = el.parentElement;
    const read = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setMeasuredWidth(width);
      const available = parent?.getBoundingClientRect().width ?? 0;
      const last = layoutRead.current;
      if (available <= 0 || available === last.rowWidth) return;
      // 行宽真变了才记账：观察面板自己也会被「拖宽度」的回调打进来。
      const burst = classifyDragResize(last.at, last.count, Date.now());
      layoutRead.current = {
        at: burst.at,
        count: burst.count,
        rowWidth: available,
        isDrag: burst.isDrag,
      };
      setRowWidth(available);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  /** 手动开关动的是 `open`，永远该有动画：先把「程序性跨越」这个标记擦掉。 */
  useLayoutEffect(() => {
    setProgrammatic(false);
  }, [open]);

  /**
   * 断点判定。展开与收起差一条回差带（`PIXIE_PANEL_EXPAND_HYSTERESIS_PX`）：窗口
   * 停在阈值上 1px 来回（缓慢拖边缘、DPI 取整）不该让面板反复开合——侧栏那条自动
   * 规则用的是同一个思路。跨越时是不是动画，取决于这次行宽变化有没有密集连发：
   * 启动 / 托盘 / 贴边 / DPI 都是一两次孤立事件，一步到位。
   */
  useLayoutEffect(() => {
    if (rowWidth <= 0) return;
    const next =
      roomyWidth >= PIXIE_PANEL_EXPAND_WIDTH_PX
        ? true
        : roomyWidth < PIXIE_PANEL_BREAKPOINT_PX
          ? false
          : null;
    if (next === null || next === wide) return;
    setWide(next);
    setProgrammatic(!layoutRead.current.isDrag);
  }, [roomyWidth, rowWidth, wide]);

  useEffect(() => {
    setPixiePanelWide(wide);
  }, [wide, setPixiePanelWide]);

  /**
   * 显示宽度 = 用户偏好按当前可用宽度收敛后的值。**只收敛显示，不回写偏好**：
   * 以前这里直接把收敛结果存回 localStorage，于是「窗口变窄→变宽」一次（= 面板被
   * 断点自动收起再放出来）就把 520 削成下限并写死，回来时再也长不回去。
   * 量不到行宽（jsdom / 首帧）时原样用偏好值。
   */
  const panelWidth =
    customWidth === null
      ? undefined
      : rowWidth > 0
        ? clampPixiePanelWidth(customWidth, rowWidth)
        : customWidth;

  // 只有「用户拖 / 按方向键」会落到这里，一处持久化。
  useEffect(() => {
    if (customWidth === null) return;
    try {
      globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(customWidth));
    } catch {
      /* ignore unavailable localStorage */
    }
  }, [customWidth]);

  /** 展开态 = 手动展开 **且** 行宽够。侧栏自动收起与手动折叠走同一个滑出。 */
  const shown = open && wide;
  /** 拖宽度途中（要跟手）与跨越断点那次不是用户拖出来的（启动 / 托盘 / 贴边 / DPI）
   *  都不许有过渡。 */
  const instant = resizing || programmatic;
  const slideOffset = panelWidth ?? (measuredWidth || FALLBACK_PANEL_WIDTH);
  const currentWidth = slideOffset;

  /** 可用宽度 = 面板所在那一行的宽度（量不到时退回窗口宽度）。 */
  const availableWidth = (): number =>
    asideRef.current?.parentElement?.getBoundingClientRect().width || window.innerWidth;

  const tabs = useMemo<PixiePanelTab[]>(() => {
    const list: PixiePanelTab[] = [];
    if (memoEnabled) {
      list.push({
        id: "todo",
        icon: ListTodo,
        title: t("pixieTodoSectionTitle"),
        count: counts.todo,
      });
    }
    if (scheduleEnabled) {
      list.push({
        id: "schedule",
        icon: CalendarClock,
        title: t("scheduleTitle"),
        count: counts.schedule,
      });
    }
    list.push({
      id: "dispatch",
      icon: Crosshair,
      title: t("pixieDispatchPanelTitle"),
      count: counts.dispatch,
    });
    return list;
  }, [memoEnabled, scheduleEnabled, counts, t]);

  /** 记住用户停在哪个页签；被禁用的那块不许留下一个点不开的空页签，退回第一块。 */
  const activeTab: PixiePanelTabId = tabs.some((item) => item.id === tab)
    ? tab
    : (tabs[0]?.id ?? "dispatch");

  const applyWidth = (next: number): void => {
    setCustomWidth(clampPixiePanelWidth(next, availableWidth()));
  };

  const finishResize = (target: HTMLElement, pointerId: number): void => {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  };

  return (
    <aside
      ref={asideRef}
      id="pixie-side-panel"
      data-pixie-side-panel
      data-panel-open={shown ? "true" : "false"}
      data-panel-instant={instant ? "true" : undefined}
      aria-label={t("pixiePanelTitle")}
      aria-hidden={shown ? undefined : true}
      inert={shown ? undefined : true}
      style={{ width: panelWidth, marginRight: shown ? 0 : -slideOffset }}
      className="relative flex min-h-0 w-[clamp(300px,30%,404px)] shrink-0 flex-col border-l border-border bg-surface"
    >
      {shown && (
        <div
          role="separator"
          tabIndex={0}
          data-testid="pixie-panel-resize"
          aria-label={t("pixiePanelResize")}
          aria-orientation="vertical"
          aria-valuemin={MIN_PIXIE_PANEL_WIDTH}
          aria-valuemax={MAX_PIXIE_PANEL_WIDTH}
          aria-valuenow={Math.round(currentWidth)}
          className="absolute left-0 top-0 z-30 h-full w-2 cursor-col-resize touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizeStart.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              width: currentWidth,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start || start.pointerId !== event.pointerId) return;
            applyWidth(start.width + start.x - event.clientX);
          }}
          onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
          onLostPointerCapture={() => {
            resizeStart.current = null;
            setResizing(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            applyWidth(
              currentWidth + (event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : -PANEL_RESIZE_STEP),
            );
          }}
        />
      )}

      <PixiePanelTabBar tabs={tabs} active={activeTab} onSelect={setTab} />
      <div
        data-pixie-panel-content
        className="scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
      >
        {memoEnabled && <PixieTodoSection active={activeTab === "todo"} onCount={onCount.todo} />}
        {scheduleEnabled && (
          <PixieScheduleSection active={activeTab === "schedule"} onCount={onCount.schedule} />
        )}
        <PixieDispatchSection
          groups={groups}
          active={activeTab === "dispatch"}
          onCount={onCount.dispatch}
        />
      </div>
    </aside>
  );
}

/**
 * 「委派任务」页签：任务树本身归 `PixieTaskTree`，这里只把汇总（进行中 / 等你回复）
 * 报给页签计数、并在树上面留一行 hint——折叠态那行曾经是唯一能同时看到三块状态的
 * 地方，横排成页签之后，每块的汇总只在自己那块里说。
 */
function PixieDispatchSection({
  groups,
  active,
  onCount,
}: {
  groups: PixieTaskTreeWorkspace[];
  active: boolean;
  onCount: (count: number) => void;
}) {
  const t = useT();
  const summary = useMemo(() => summarizePixieTasks(groups), [groups]);

  useEffect(() => {
    onCount(summary.total);
  }, [summary.total, onCount]);

  const hint = useMemo(() => {
    const parts: string[] = [];
    if (summary.running > 0) {
      parts.push(t("pixieDispatchSummaryRunning", { running: summary.running }));
    }
    if (summary.awaiting > 0) {
      parts.push(t("pixieDispatchSummaryAwaiting", { awaiting: summary.awaiting }));
    }
    // 两者都为 0：不显示 hint，只留页签上的计数。
    return parts.join(" · ");
  }, [summary.running, summary.awaiting, t]);

  return (
    <PixiePanelBody tab="dispatch" active={active} hint={hint}>
      <PixieTaskTree groups={groups} />
    </PixiePanelBody>
  );
}
