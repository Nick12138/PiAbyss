/**
 * PixieSessionsButton — 小精灵页自己的会话列表入口（顶栏 pixie 动作区）。
 *
 * 会话列表不再出现在侧边栏底部（那里会和顶栏 pixie 入口的选中态叠出
 * “双选中”的怪异感）：入口收进小精灵页顶栏。**点击**按钮才在按钮正下方
 * 浮出列表——不是占满屏幕的模态弹窗：无遮罩、不抢焦点；再点一次按钮、
 * 点面板外、或按 Esc 即收起。不做悬停展开（鼠标扫过顶栏不会误弹）。
 *
 * 面板内嵌标准 SessionList（当前工作区就是 pixie 工作区，keepPage 留在
 * pixie 页完成选择与切换），选中一条会话后面板自动收起。列表不带“最近会话”
 * 标题行（hideHeader），也不提供新建会话入口（showCreateAction=false）——
 * 新建会话仍走侧边栏“＋”或命令面板。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MessagesSquare } from "lucide-react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { SessionList } from "../sessions/SessionList";

/** 面板宽度上限（同时夹进视口，窄窗口下自动收窄）。 */
const PANEL_MAX_WIDTH = 320;
/** 面板与视口边缘 / 按钮底边的间距。 */
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export function PixieSessionsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const hostReady = useAppStore((s) => s.host !== null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = () => setOpen(false);

  // 面板挂在按钮正下方、右边缘与按钮对齐，并整体夹进视口。
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const maxWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(1, window.innerWidth - VIEWPORT_MARGIN * 2),
      );
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, rect.right - maxWidth),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - maxWidth - VIEWPORT_MARGIN),
      );
      setPanelStyle({ left, top: Math.round(rect.bottom + ANCHOR_GAP), maxWidth });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  // 无遮罩的轻量浮层（同 ShellJobsBar 的任务面板）：点外部 / Esc 收起。
  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const panel = open ? (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={t("pixieSessionsTitle")}
      data-testid="pixie-sessions-panel"
      className="theme-floating-surface fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
      style={panelStyle ?? { visibility: "hidden", left: 0, top: 0, maxWidth: PANEL_MAX_WIDTH }}
    >
      <div className="scrollbar-subtle max-h-[60vh] min-h-0 overflow-y-auto p-1.5">
        <SessionList
          keepPage
          flatByDate
          hideHeader
          showCreateAction={false}
          onSessionOpened={close}
        />
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        data-testid="pixie-sessions-button"
        className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!hostReady}
        title={t("pixieSessionsTitle")}
        aria-label={t("pixieSessionsTitle")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <MessagesSquare size={11} />
        {t("pixieSessionsButton")}
      </button>
      {typeof document === "undefined" || !panel ? null : createPortal(panel, document.body)}
    </>
  );
}
