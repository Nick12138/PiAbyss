/**
 * 小精灵页右侧「随行面板」——可展开 / 折叠，与对话同屏、不切页。
 *
 * 折叠机制照抄普通会话的右侧 dock（`components/RightDock.tsx`）：不卸载，靠
 * **负 margin 滑出**（宽度保留，200ms 过渡），父级 `[data-piabyss-app]` 的
 * overflow-hidden 负责裁掉滑出去的那部分。开关在顶栏（`AppTopBar`），所以展开
 * 状态放在 app-store（`pixiePanelOpen`），与 `dockOpen` 并排。
 *
 * 面板内容是「可折叠分组」栈，顺序同设计稿 `pixie-merge-C.html`：
 *   1. 方寸间（常驻展开）        —— `PixieTodoSection`
 *   2. 周期计划（默认折叠）      —— `PixieScheduleSection`
 *   3. 委派任务（默认折叠）      —— 本文件，数据由 `PixiePage` 轮询后传入
 * 三块共用 `PixiePanelSection` 的视觉外壳；再加分组只要往这个栈里插一个 section。
 * 栈本身**不留内缩**（面板已有 `border-l` + 分组各自的 `px-3`），分组之间只画一条
 * `divide-y` 细线——曾经这里是 `p-3` + 每块一圈圆角边框，左右各白吃 ~10px、上下各
 * 多 24px，窄面板里不值。
 *
 * 断点：窄于 `@3xl` 时整块 `display:none`（不占位），手动开关只决定「够宽时是否
 * 展开」。面板自己的宽度就是这条断点的探针：被 CSS 藏掉时量到 0，据此让顶栏开关
 * 一起消失（`pixiePanelWide`）。
 *
 * 宽度：默认 `clamp(300px, 30%, 404px)`（设计稿 rail 的口径——跟着容器走但有上下
 * 限）；拖左侧边缘（或聚焦后按左右方向键）可改成显式像素宽度，带下限 300px、上限
 * 640px（且至少给对话区留 360px），并持久化。手柄与钳制口径照抄 `RightDock`。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Crosshair, PanelRight } from "lucide-react";
import type { PixieTaskTreeWorkspace } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { PixiePanelSection, usePanelSection } from "./PixiePanelSection";
import { PixieScheduleSection } from "./PixieScheduleSection";
import { PixieTaskTree } from "./PixieTaskTree";
import { PixieTodoSection } from "./PixieTodoSection";

/** 用户拖出来的面板宽度（localStorage）；没拖过就用 CSS 的 `clamp(...)`。 */
export const PANEL_WIDTH_KEY = "piabyss.pixie.panelWidth.v1";

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
  const asideRef = useRef<HTMLElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [customWidth, setCustomWidth] = useState<number | null>(readStoredPanelWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  /**
   * 面板宽度 = 默认 `@3xl:w-[clamp(300px,30%,404px)]`（设计稿的 rail 口径：跟着
   * 容器走但有上下限），用户拖过之后换成显式像素宽度。
   *
   * 同一次读取里顺带做三件事：把「容器够不够宽」镜像给顶栏开关、记下滑出距离、
   * 以及窗口变窄时把用户设定的宽度重新钳回可用范围（否则窄窗口下面板会挤没对话）。
   */
  useLayoutEffect(() => {
    const el = asideRef.current;
    // 量不到布局的环境保持 store 默认值（开关可见），显隐交给 CSS 断点。
    if (!el || typeof ResizeObserver === "undefined") return;
    const parent = el.parentElement;
    const read = () => {
      const width = el.getBoundingClientRect().width;
      setPixiePanelWide(width > 0);
      if (width > 0) setMeasuredWidth(width);
      const available = parent?.getBoundingClientRect().width ?? 0;
      if (available > 0) {
        setCustomWidth((current) =>
          current === null ? current : clampPixiePanelWidth(current, available),
        );
      }
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, [setPixiePanelWide]);

  // 拖动与「窗口变窄后重新钳制」都会落到这里，一处持久化。
  useEffect(() => {
    if (customWidth === null) return;
    try {
      globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(customWidth));
    } catch {
      /* ignore unavailable localStorage */
    }
  }, [customWidth]);

  const slideOffset = measuredWidth || FALLBACK_PANEL_WIDTH;
  const currentWidth = customWidth ?? (measuredWidth || FALLBACK_PANEL_WIDTH);

  /** 可用宽度 = 面板所在那一行的宽度（量不到时退回窗口宽度）。 */
  const availableWidth = (): number =>
    asideRef.current?.parentElement?.getBoundingClientRect().width || window.innerWidth;

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
      data-panel-open={open ? "true" : "false"}
      aria-label={t("pixiePanelTitle")}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      style={{ width: customWidth ?? undefined, marginRight: open ? 0 : -slideOffset }}
      className={`relative hidden min-h-0 shrink-0 flex-col border-l border-border bg-surface @3xl:flex @3xl:w-[clamp(300px,30%,404px)] ${
        resizing ? "transition-none" : "transition-[margin-right] duration-200 ease-out"
      }`}
    >
      {open && (
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

      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-muted">
        <PanelRight size={13} className="shrink-0" aria-hidden="true" />
        <span>{t("pixiePanelTitle")}</span>
      </div>
      <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto pb-2">
        <PixieTodoSection />
        <PixieScheduleSection />
        <PixieDispatchSection groups={groups} />
      </div>
    </aside>
  );
}

/**
 * 「委派任务」分组：折叠态只有一行（箭头 + 图标 + 标题 + 计数 + 汇总），展开才是
 * 原来的两层任务树。汇总必须在折叠态可读——它是折叠时唯一的状态信息。
 */
function PixieDispatchSection({ groups }: { groups: PixieTaskTreeWorkspace[] }) {
  const t = useT();
  const [open, toggle] = usePanelSection(false);
  const summary = useMemo(() => summarizePixieTasks(groups), [groups]);

  const hint = useMemo(() => {
    const parts: string[] = [];
    if (summary.running > 0) {
      parts.push(t("pixieDispatchSummaryRunning", { running: summary.running }));
    }
    if (summary.awaiting > 0) {
      parts.push(t("pixieDispatchSummaryAwaiting", { awaiting: summary.awaiting }));
    }
    // 两者都为 0：不显示 hint，只留计数徽章。
    return parts.join(" · ");
  }, [summary.running, summary.awaiting, t]);

  return (
    <PixiePanelSection
      testId="pixie-dispatch-section"
      icon={Crosshair}
      title={t("pixieDispatchPanelTitle")}
      count={summary.total}
      hint={hint}
      open={open}
      onToggle={toggle}
    >
      <PixieTaskTree groups={groups} />
    </PixiePanelSection>
  );
}
