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
 *   1. 待办 · 速记        —— `PixieTodoSection`
 *   2. 自动化      —— `PixieAutomationSection`
 *   3. 委派任务      —— 本文件，数据由 `PixiePage` 轮询后传入
 * 一次只看一块，导航就是顶栏那 `h-10`（35px；面板标题「随行面板」随之删掉，名字留给 `aria-label`）。
 * 三块都留在 DOM 里、未选中的只摘显示，所以每块自己拉的数据一直活着、页签上的计数不会停更。
 * 再加分组只要往 `tabs` 里插一项 + 插一个 section（外壳 `PixiePanelTabs` 已经统一）。
 *
 * 插件门在这里，不在各块里：被禁用的那块**连页签都不该有**，所以 `usePluginEnabled` /
 * `useAutomationPluginEnabled` 由面板判，块本身不再各自 return null。
 *
 * 内容区**不留内缩**（面板已有 `border-l`，各块自己 `px-3`）；曾经这里是 `p-3` +
 * 每块一圈圆角边框，左右各白吃 ~10px、上下各多 24px，窄面板里不值。
 *
 * 断点：扣完侧栏欠账的行宽不足 `PIXIE_PANEL_BREAKPOINT_PX` 时面板**自动收起**（不是
 * `display:none`，见下），够宽时是否展开才由手动开关决定。窄容器下它换成**整页覆盖抽屉**
 * （`pixiePanelDrawerOpen`，样式在 index.css 的 `[data-panel-overlay]` 一组）——把整个消息
 * 界面盖住（`inset: 0`，宽度也吃满、不写 inline width），只有顶栏留着给开关：
 * 待办 · 速记只有面板这一处入口，开关不能再消失，否则窗口一窄就什么都能看不到。两种形态各记
 * 一份开合——并排展开的记忆不该在拖窄那一下自己压到对话上，跨越断点一律从关着开始。
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
 * 宽度：默认 460px、下限 350px、上限 720px，并给对话区至少留 360px——**与普通会话的
 * 右侧 dock（`RightDock` 的 460 / 350 / 720 / 360）逐项同口径**，展开时读起来才是同一
 * 栏（原先的 rail 口径 `clamp(300px,30%,404px)` 比 dock 窄一截）。宽度**始终**以显式像素
 * 写在 inline style 上，与 dock 一致；拖左侧边缘（或聚焦后按左右方向键）改宽度并持久化。
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
import { MEMO_PLUGIN_ID, MEMO_PLUGIN_ID_LEGACY } from "../plugin-library/plugin-ids";
import { useAutomationPluginEnabled } from "../automation/automation-plugin-gate";
import {
  PixiePanelBody,
  PixiePanelTabBar,
  type PixiePanelTab,
  type PixiePanelTabId,
} from "./PixiePanelTabs";
import { PixieAutomationSection } from "./PixieAutomationSection";
import { PixieTaskTree } from "./PixieTaskTree";
import { PixieTodoSection } from "./PixieTodoSection";

/** 用户拖出来的面板宽度（localStorage）；没拖过就用默认宽度（见 `readStoredPanelWidth`）。
 *  v1 存的是 rail 口径（300~404 那档）的偏好，宽度口径与 dock 对齐后直接作废——
 *  沿用旧值会让老用户永远停在那条比 dock 窄一截的栏上。 */
export const PANEL_WIDTH_KEY = "piabyss.pixie.panelWidth.v2";

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

/** 面板默认宽度：与右侧 dock 的 `DEFAULT_DOCK_WIDTH` 同口径。 */
export const DEFAULT_PIXIE_PANEL_WIDTH = 460;
/** 面板宽度下限：与 dock 的 `MIN_DOCK_WIDTH` 同口径。 */
export const MIN_PIXIE_PANEL_WIDTH = 350;
/** 面板宽度上限：与 dock 的 `MAX_DOCK_WIDTH` 同口径。 */
export const MAX_PIXIE_PANEL_WIDTH = 720;
/** 面板再宽也要给对话区留出的宽度（dock 同款 360）。 */
const MIN_CONVERSATION_WIDTH = 360;
/** 键盘调整的步长（左右方向键），与右侧 dock 同口径。 */
const PANEL_RESIZE_STEP = 20;

/**
 * 面板宽度的钳制（与 `RightDock.clampDockWidth` 逐项同口径）：上限取「720」与
 * 「可用宽度 − 对话区最小宽度」里更小的那个，但**不低于默认宽度 460**——窄窗口里的
 * 面板更该是一个能用的宽度（收纳式浮层尤其如此），压到三百出头没有意义，dock 当年
 * 也是选的下限优先。
 */
export function clampPixiePanelWidth(width: number, availableWidth: number): number {
  const responsiveMax = Math.max(
    DEFAULT_PIXIE_PANEL_WIDTH,
    Math.min(MAX_PIXIE_PANEL_WIDTH, Math.round(availableWidth) - MIN_CONVERSATION_WIDTH),
  );
  if (!Number.isFinite(width)) return Math.min(DEFAULT_PIXIE_PANEL_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_PIXIE_PANEL_WIDTH, Math.round(width)));
}

/**
 * 读回用户拖出来的宽度；没拖过 / 存坏了都返回 null（= 没偏好，显示走默认宽度）。
 * 刻意不把默认值写进 localStorage：偏好只记「用户真的拖过的那一次」，否则以后改默认
 * 宽度，老用户会被自己那条谁也没拖过的记录钉在旧值上。
 */
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
  const drawerOpen = useAppStore((state) => state.pixiePanelDrawerOpen);
  const setPixiePanelDrawerOpen = useAppStore((state) => state.setPixiePanelDrawerOpen);
  const setPixiePanelWide = useAppStore((state) => state.setPixiePanelWide);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const sidebarAutoCollapsed = useAppStore((state) => state.sidebarAutoCollapsed);
  const navSidebarWidth = useAppStore((state) => state.sidebarWidth);
  const memoPluginEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const memoLegacyEnabled = usePluginEnabled(MEMO_PLUGIN_ID_LEGACY);
  const memoEnabled = memoPluginEnabled || memoLegacyEnabled;
  const automationEnabled = useAutomationPluginEnabled();
  const asideRef = useRef<HTMLElement>(null);
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
    automation: 0,
    dispatch: 0,
  });
  const onCount = useMemo<Record<PixiePanelTabId, (count: number) => void>>(
    () => ({
      // 同值直接返回原对象：否则子组件的 effect 会被父组件的重渲染再喂一轮。
      todo: (count) => setCounts((c) => (c.todo === count ? c : { ...c, todo: count })),
      automation: (count) =>
        setCounts((c) => (c.automation === count ? c : { ...c, automation: count })),
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
   * 宽度只量**行宽**（面板自己是显式像素宽，不再回头量它）：记下行宽、记下落点是不是
   * 密集连发（= 用户在拖窗口边缘，见 `lib/layout-motion.ts`）。断点判定在下面的
   * `wide` 那条 Effect 里。
   */
  useLayoutEffect(() => {
    const el = asideRef.current;
    // 量不到布局的环境保持 store 默认值（开关可见），显隐交给下面的行宽判定。
    if (!el || typeof ResizeObserver === "undefined") return;
    const parent = el.parentElement;
    const read = () => {
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

  /** 手动开关动的是 `open`（窄容器下是抽屉），永远该有动画：先把「程序性跨越」这个标记擦掉。 */
  useLayoutEffect(() => {
    setProgrammatic(false);
  }, [open, drawerOpen]);

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
    // 跨越断点一律从「关着」开始：并排展开的记忆不该在窗口拖窄那一下变成压住对话的
    // 浮层，反过来浮层也不该在拉宽时自动占掉一栏。
    setPixiePanelDrawerOpen(false);
  }, [roomyWidth, rowWidth, wide, setPixiePanelDrawerOpen]);

  useEffect(() => {
    setPixiePanelWide(wide);
  }, [wide, setPixiePanelWide]);

  /** 离开小精灵页 = 面板整个卸载。抽屉状态必须跟着清掉：它是浮层，留着下次进来会直接
   *  撞上一张遮罩（并排那一栏有 localStorage 偏好，本来就是「该展开就展开」）。 */
  useEffect(() => () => setPixiePanelDrawerOpen(false), [setPixiePanelDrawerOpen]);

  /**
   * 显示宽度 = 偏好按当前可用宽度收敛后的值，**始终是一个数字**（宽度每次都写在
   * inline style 上，与右侧 dock 同一口径——dock 也不挂 CSS 宽度类）。**只收敛显示，
   * 不回写偏好**：以前这里直接把收敛结果存回 localStorage，于是「窗口变窄→变宽」一次
   * （= 面板被断点自动收起再放出来）就把 520 削成下限并写死，回来时再也长不回去。
   * 量不到行宽（jsdom / 首帧）时原样用偏好值。
   */
  const preferredWidth = customWidth ?? DEFAULT_PIXIE_PANEL_WIDTH;
  const panelWidth = rowWidth > 0 ? clampPixiePanelWidth(preferredWidth, rowWidth) : preferredWidth;

  // 只有「用户拖 / 按方向键」会落到这里，一处持久化。
  useEffect(() => {
    if (customWidth === null) return;
    try {
      globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(customWidth));
    } catch {
      /* ignore unavailable localStorage */
    }
  }, [customWidth]);

  /** 展开态 = 手动展开 **且** 行宽够；窄容器下换成手动开的整页覆盖抽屉自己说了算。
   *  侧栏自动收起与手动折叠走同一个滑出，抽屉共用 `data-panel-open`，只是方向由
   *  CSS 换成 translateX（见 index.css 的 `[data-panel-overlay]` 一组）。 */
  const overlay = !wide;
  const shown = overlay ? drawerOpen : open;

  /**
   * 抽屉是浮层：Esc 与遮罩都关得掉。但Esc 要先给弹窗——新建 / 编辑弹窗（以及总结、
   * 删除确认）都挂在 body 上，用户在抽屉里开着弹窗按 Esc，退的是弹窗，不该连带把
   * 整个抽屉也撤掉。
   */
  useEffect(() => {
    if (!overlay || !shown) return;
    const onKey = (event: DocumentEventMap["keydown"]) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      setPixiePanelDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlay, shown, setPixiePanelDrawerOpen]);
  /** 拖宽度途中（要跟手）与跨越断点那次不是用户拖出来的（启动 / 托盘 / 贴边 / DPI）
   *  都不许有过渡。 */
  const instant = resizing || programmatic;
  /** 收起时的滑出距离 = 面板宽度本身（宽度始终显式，不需要再兜底量一次）。 */
  const currentWidth = panelWidth;

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
    if (automationEnabled) {
      list.push({
        id: "automation",
        icon: CalendarClock,
        title: t("automationTitle"),
        count: counts.automation,
      });
    }
    list.push({
      id: "dispatch",
      icon: Crosshair,
      title: t("pixieDispatchPanelTitle"),
      count: counts.dispatch,
    });
    return list;
  }, [memoEnabled, automationEnabled, counts, t]);

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
    <>
      {/* 窄容器里面板是**整页覆盖**（`inset: 0`，宽度也不写 inline——见 index.css 的
        `[data-panel-overlay]`）：把整个消息界面盖满，不并排、不留缝。遮罩还在，负责
        「点外面就关」；它从顶栏下沿开始，顶栏那颗开关始终点得到，抽屉退得出来。 */}
      {overlay && shown ? (
        <div
          data-pixie-panel-backdrop
          data-testid="pixie-panel-backdrop"
          aria-hidden="true"
          onClick={() => setPixiePanelDrawerOpen(false)}
          className="absolute inset-0 z-40 bg-black/30"
        />
      ) : null}
      <aside
        ref={asideRef}
        id="pixie-side-panel"
        data-pixie-side-panel
        data-panel-overlay={overlay ? "true" : undefined}
        data-panel-open={shown ? "true" : "false"}
        data-panel-instant={instant ? "true" : undefined}
        aria-label={t("pixiePanelTitle")}
        aria-hidden={shown ? undefined : true}
        inert={shown ? undefined : true}
        style={{
          width: overlay ? undefined : panelWidth,
          marginRight: overlay || shown ? 0 : -currentWidth,
        }}
        className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface"
      >
        {shown && !overlay && (
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
          {automationEnabled && (
            <PixieAutomationSection
              active={activeTab === "automation"}
              onCount={onCount.automation}
            />
          )}
          <PixieDispatchSection
            groups={groups}
            active={activeTab === "dispatch"}
            onCount={onCount.dispatch}
          />
        </div>
      </aside>
    </>
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
