import {
  MessageCirclePlus,
  CalendarClock,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, type NavPage } from "../lib/stores/app-store";
import { SessionList } from "../features/sessions/SessionList";
import { useT } from "../lib/i18n/use-t";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker";
import { TelegramSessionList } from "../features/telegram/TelegramSessionList";
import { useTelegramWorkspaceActive } from "../features/telegram/telegram-view-store";
import { PiMark } from "./PiMark";
import { sidebarPref, setSidebarPref } from "../lib/sidebar-prefs";
import { evaluateSidebarAutoAction, sidebarFloorWindowWidth } from "../lib/sidebar-auto-collapse";
import { subscribeSessionReveal } from "../lib/session-reveal";
import { useSchedulePluginEnabled } from "../features/schedule/schedule-plugin-gate";
import { usePluginEnabled } from "../features/plugin-library/plugin-gate";

/** The plugin-library entries backing the Pixie and Memo pages. */
const PIXIE_PLUGIN_ID = "pi-pixie";
const MEMO_PLUGIN_ID = "piabyss-memo";
import { resolveConversationMinWidth } from "../features/chat/conversation-layout";
import {
  createNewSession,
  isCreateSessionPending,
  subscribeCreateSessionPending,
} from "../lib/commands/actions";

const SIDEBAR_WIDTH_KEY = "piabyss.sidebar.width.v1";
const DEFAULT_SIDEBAR_WIDTH = 268;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

/** Native window minimum height, kept in lockstep with the `minHeight`
 *  declared in tauri.conf.json. The width is driven dynamically by the
 *  conversation-area min width (see effect below);
 *  `setSizeConstraints` replaces the whole constraint set, so the height must
 *  be re-asserted on every update to avoid dropping it. */
const NATIVE_WINDOW_MIN_HEIGHT = 600;

/** True when running inside the Tauri desktop shell (so the native window
 *  constraint APIs are available). Mirrors the check used in App.tsx. */
const nativeWindowAvailable = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Sidebar collapse toggle rendered in the app-level AppTopBar. Shows the Pi
 *  mark by default and reveals the PanelLeft close/open arrow on hover/focus,
 *  so the same control drives both brand identity and collapse state. */
export function SidebarBrandToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const label = collapsed ? t("sidebarExpand") : t("sidebarCollapse");
  const PanelIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      data-sidebar-brand-toggle
      className="group relative flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      onClick={onToggle}
    >
      <PiMark className="mac-sidebar-brand-mark size-6 transition-opacity group-hover:opacity-0 group-focus:opacity-0" />
      <PanelIcon
        size={15}
        className="absolute text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      />
    </button>
  );
}

function clampSidebarWidth(width: number, viewportWidth = 1280): number {
  const responsiveMax = Math.max(
    DEFAULT_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - 360),
  );
  if (!Number.isFinite(width)) return Math.min(DEFAULT_SIDEBAR_WIDTH, responsiveMax);
  return Math.min(responsiveMax, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function initialSidebarWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  try {
    const stored = Number(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY));
    return clampSidebarWidth(stored || DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  }
}

function NewSessionButton() {
  const t = useT();
  const workspace = useAppStore((s) => s.workspace);
  const [pending, setPending] = useState(isCreateSessionPending);
  useEffect(() => subscribeCreateSessionPending(setPending), []);

  return (
    <button
      type="button"
      onClick={() => {
        // Creating a session from Settings/Packages should land on the chat page.
        if (useAppStore.getState().page !== "chat") useAppStore.getState().setPage("chat");
        void createNewSession();
      }}
      disabled={!workspace?.servicesReady || pending}
      className="theme-sidebar-primary interface-density-primary-row flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
    >
      <MessageCirclePlus size={18} className="shrink-0" />
      <span>{pending ? t("sidebarCreating") : t("sidebarNewConversation")}</span>
    </button>
  );
}

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);

  return <SidebarLayout page={page} setPage={setPage} />;
}

export function SidebarLayout({
  page,
  setPage,
}: {
  page: NavPage;
  setPage: (page: NavPage) => void;
}) {
  const t = useT();
  const scheduleEnabled = useSchedulePluginEnabled();
  const memoEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const pixieEnabled = usePluginEnabled(PIXIE_PLUGIN_ID);
  const hostReady = Boolean(useAppStore((s) => s.host?.hostInstanceId));
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarAutoCollapsed = useAppStore((s) => s.sidebarAutoCollapsed);
  const telegramViewActive = useTelegramWorkspaceActive();
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    sidebarPref("piabyss.sidebar.sessionsCollapsed"),
  );
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const theme = useAppStore((s) => s.desktopSettings?.theme);
  const themeFamily = useAppStore((s) => s.desktopSettings?.themeFamily);
  const conversationMinWidth = useAppStore((s) => s.desktopSettings?.conversationMinWidth);

  // Expose the live sidebar width as a root CSS var so sibling chrome (the top
  // bar's title column) can align its start to the content-area's left edge.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--sidebar-width", `${sidebarCollapsed ? 0 : sidebarWidth}px`);
    return () => {
      root.style.removeProperty("--sidebar-width");
    };
  }, [sidebarWidth, sidebarCollapsed]);

  // Drive the OS-level window minimum width from the conversation-area min
  // width setting, scoped to the conversation column rather than acting as
  // a flat global floor:
  //
  //   minWidth = conversation min width + frame insets
  //
  // The floor deliberately does NOT include the expanded sidebar's width,
  // for two reasons:
  //
  //   1. The auto-collapse watcher below protects the conversation column
  //      reactively — and instantly, within the same resize event (the
  //      auto-collapse skips the width animation) — so a raised
  //      expanded-sidebar floor is no longer needed to keep the column
  //      readable while shrinking.
  //   2. Decisive: the OS reads window size constraints once, when a resize
  //      drag STARTS. A `setSizeConstraints` call issued mid-drag (e.g.
  //      right after the auto-collapse lowers the floor) does not take
  //      effect until the user releases the edge and grabs it again. An
  //      expanded-sidebar floor therefore made the shrink feel
  //      two-staged: the drag stalled at the old wall exactly where the
  //      sidebar had just collapsed, and only a re-grab let it continue.
  //      A sidebar-independent floor means a single continuous drag glides
  //      all the way down: sidebar open → collapse at the threshold →
  //      floor already low enough → keep dragging.
  //
  // The conversation area sits inside `[data-content-frame]`, which carries a
  // left/right design margin (--app-content-gap, per theme). Those insets
  // always get space when the window hugs the minimum — otherwise the chat
  // page's own min-width overflows its frame at minimum size and the
  // conversation area gets CLIPPED on the right side (read as the composer
  // looking off-center / right padding missing), while the left padding
  // stays intact. At minimum width, the conversation area ends up exactly
  // the configured min width, symmetric and fully visible.
  // `setSizeConstraints` replaces the whole constraint set, so re-assert the
  // height floor (matches `minHeight` in tauri.conf.json) on every update to
  // avoid dropping it.
  useEffect(() => {
    if (!nativeWindowAvailable) return;
    const conversationMin = resolveConversationMinWidth(conversationMinWidth);
    let cancelled = false;
    void (async () => {
      try {
        // Content frame's left/right design margin: read the computed style
        // instead of hard-coding, since --app-content-gap can vary per theme.
        const contentFrameEl = document.querySelector("[data-content-frame]");
        const frameStyle = contentFrameEl ? getComputedStyle(contentFrameEl) : null;
        const frameMarginH =
          (parseFloat(frameStyle?.marginLeft || "0") || 0) +
          (parseFloat(frameStyle?.marginRight || "0") || 0);
        // Sidebar width pinned to 0: the floor stays at the collapsed level
        // (see the comment above for why it must not track the sidebar).
        const baseMinWidth = sidebarFloorWindowWidth(conversationMin, 0, frameMarginH);

        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const appWindow = getCurrentWindow();
        // The window is borderless (`decorations: false`) but still renders a
        // DWM drop shadow, which tao treats as an invisible resize/shadow
        // margin wrapping the visible client. tao enforces our `minWidth`
        // against the OUTER window rect (GetWindowRect) in WM_GETMINMAXINFO,
        // so the visible client (GetClientRect == `window.innerWidth`) ends
        // up narrower than the value we set by exactly that invisible margin
        // (~14px = a hairline each side). Measure the live outer↔inner gap
        // and add it back, so the floor we pass becomes the floor the user
        // sees in the content area. Same fix applies to the height floor.
        const [inner, outer, scaleFactor] = await Promise.all([
          appWindow.innerSize(),
          appWindow.outerSize(),
          appWindow.scaleFactor(),
        ]);
        if (cancelled) return;
        const scale = scaleFactor || 1;
        const chromeW = Math.max(0, (outer.width - inner.width) / scale);
        const chromeH = Math.max(0, (outer.height - inner.height) / scale);
        await appWindow.setSizeConstraints({
          minWidth: baseMinWidth + chromeW,
          minHeight: NATIVE_WINDOW_MIN_HEIGHT + chromeH,
        });
      } catch {
        /* best-effort: the constraint update is non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationMinWidth, theme, themeFamily]);

  // Window-width auto collapse/expand (policy: lib/sidebar-auto-collapse.ts).
  //
  // The OS floor above deliberately sits at the collapsed level, so a
  // shrinking window never stalls against an expanded-sidebar wall
  // mid-drag. This watcher is what protects the conversation column
  // instead:
  //
  //   • shrinking to the expanded floor (conversation min + sidebar +
  //     insets — the window width at which the column would hit its
  //     minimum) → the sidebar auto-collapses. The collapse skips the
  //     width animation (see the aside below) and commits inside the
  //     same resize event, so the column never visibly dips below its
  //     minimum and the drag continues into the freed space.
  //   • widening past the floor + hysteresis → an auto-collapsed sidebar
  //     springs back open (animated). A manually collapsed sidebar
  //     never does — the store's `sidebarAutoCollapsed` flag is what
  //     authorizes the expand, and every manual toggle clears it.
  //
  // The first evaluation covers a window restored smaller than the expanded
  // floor; the effect also re-runs when the floor inputs move without a
  // window resize (conversation min-width setting, theme-driven insets),
  // which — with the window width unchanged — can only ever auto-EXPAND
  // (e.g. lowering the conversation minimum while auto-collapsed).
  const lastAutoWindowWidthRef = useRef<number | null>(null);
  const evaluateSidebarAuto = useCallback((): void => {
    if (typeof window === "undefined") return;
    const state = useAppStore.getState();
    const contentFrameEl = document.querySelector("[data-content-frame]");
    const frameStyle = contentFrameEl ? getComputedStyle(contentFrameEl) : null;
    const frameMarginH =
      (parseFloat(frameStyle?.marginLeft || "0") || 0) +
      (parseFloat(frameStyle?.marginRight || "0") || 0);
    const expandedFloor = sidebarFloorWindowWidth(
      resolveConversationMinWidth(state.desktopSettings?.conversationMinWidth),
      sidebarWidthRef.current,
      frameMarginH,
    );
    const action = evaluateSidebarAutoAction({
      windowWidth: window.innerWidth,
      expandedFloorWidth: expandedFloor,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarAutoCollapsed: state.sidebarAutoCollapsed,
      previousWindowWidth: lastAutoWindowWidthRef.current,
    });
    lastAutoWindowWidthRef.current = window.innerWidth;
    if (action === "collapse") state.autoCollapseSidebar();
    else if (action === "expand") state.autoExpandSidebar();
  }, []);

  useEffect(() => {
    evaluateSidebarAuto();
    window.addEventListener("resize", evaluateSidebarAuto);
    return () => window.removeEventListener("resize", evaluateSidebarAuto);
  }, [conversationMinWidth, theme, themeFamily, evaluateSidebarAuto]);

  function finishResize(target: HTMLDivElement, pointerId: number) {
    if (resizeStart.current?.pointerId !== pointerId) return;
    resizeStart.current = null;
    setResizing(false);
    try {
      globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
    } catch {
      /* ignore unavailable localStorage */
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }

  function resizeSidebar(width: number) {
    const next = clampSidebarWidth(width, window.innerWidth);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
  }

  function toggleSessionsCollapsed() {
    setSessionsCollapsed((current) => {
      setSidebarPref("piabyss.sidebar.sessionsCollapsed", !current);
      return !current;
    });
  }

  // 定位请求（归档会话打不开，只能带到它在列表里的位置，见 lib/session-reveal）：
  // 侧边栏或「最近会话」分区折叠时列表根本不在树上，先展开再让 SessionList 接手定位，
  // 否则用户看不到被定位的那一条。
  useEffect(() => {
    return subscribeSessionReveal(() => {
      if (useAppStore.getState().sidebarCollapsed) {
        useAppStore.getState().setSidebarCollapsed(false);
      }
      setSessionsCollapsed((current) => {
        if (!current) return current;
        setSidebarPref("piabyss.sidebar.sessionsCollapsed", false);
        return false;
      });
    });
  }, []);

  return (
    <Fragment>
      {/* Auto-collapses skip the 200ms width animation: the collapse fires
          inside the window's resize event and committing it in the same
          frame keeps the conversation column from ever painting below its
          minimum mid-drag (and avoids a transient double-layout while the
          user is still dragging). Manual toggles and auto-expands keep the
          animation. */}
      <aside
        style={{
          width: sidebarCollapsed ? 0 : sidebarWidth,
        }}
        data-sidebar
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
        className={`sidebar-edge-shadow relative flex shrink-0 flex-col overflow-hidden bg-sidebar ${
          resizing || (sidebarCollapsed && sidebarAutoCollapsed)
            ? "transition-none"
            : "transition-[width] duration-200 ease-out"
        }`}
      >
        {!sidebarCollapsed && (
          <div
            role="separator"
            tabIndex={0}
            data-sidebar-resizer
            aria-label={t("sidebarResize")}
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            className="absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize touch-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              resizeStart.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                width: sidebarWidth,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              const start = resizeStart.current;
              if (!start || start.pointerId !== event.pointerId) return;
              // sidebar is on the left edge: dragging right (clientX grows) widens it
              resizeSidebar(start.width + (event.clientX - start.x));
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
              const next = clampSidebarWidth(
                sidebarWidth + (event.key === "ArrowRight" ? 20 : -20),
                window.innerWidth,
              );
              sidebarWidthRef.current = next;
              setSidebarWidth(next);
              try {
                globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(next));
              } catch {
                /* ignore unavailable localStorage */
              }
            }}
          />
        )}

        {sidebarCollapsed ? null : (
          <>
            {!telegramViewActive && (
              <div className="px-2 pb-2 pt-[10px]">
                <NewSessionButton />
              </div>
            )}

            {pixieEnabled && (
              <div className="px-2 pb-2">
                <button
                  type="button"
                  disabled={!hostReady}
                  onClick={() => setPage(page === "pixie" ? "chat" : "pixie")}
                  data-ui="nav-item"
                  data-testid="sidebar-pixie-entry"
                  data-state={page === "pixie" ? "active" : "inactive"}
                  title={hostReady ? t("pixieTitle") : `${t("pixieTitle")} · host not ready`}
                  aria-label={t("pixieTitle")}
                  aria-pressed={page === "pixie"}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors ${
                    page === "pixie"
                      ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                      : "text-foreground hover:bg-surface-overlay"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <Sparkles size={18} className="shrink-0" />
                  <span>{t("pixieTitle")}</span>
                </button>
              </div>
            )}

            {scheduleEnabled && (
              <div className="px-2 pb-2">
                <button
                  type="button"
                  onClick={() => setPage(page === "schedule" ? "chat" : "schedule")}
                  data-ui="nav-item"
                  data-testid="sidebar-schedule-entry"
                  data-state={page === "schedule" ? "active" : "inactive"}
                  title={t("scheduleTitle")}
                  aria-label={t("scheduleTitle")}
                  aria-pressed={page === "schedule"}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors ${
                    page === "schedule"
                      ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                      : "text-foreground hover:bg-surface-overlay"
                  }`}
                >
                  <CalendarClock size={18} className="shrink-0" />
                  <span>{t("scheduleTitle")}</span>
                </button>
              </div>
            )}

            {memoEnabled && (
              <div className="px-2 pb-2">
                <button
                  type="button"
                  disabled={!hostReady}
                  onClick={() => setPage(page === "memo" ? "chat" : "memo")}
                  data-ui="nav-item"
                  data-testid="sidebar-memo-entry"
                  data-state={page === "memo" ? "active" : "inactive"}
                  title={hostReady ? t("memoTitle") : `${t("memoTitle")} · host not ready`}
                  aria-label={t("memoTitle")}
                  aria-pressed={page === "memo"}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors ${
                    page === "memo"
                      ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                      : "text-foreground hover:bg-surface-overlay"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <ListTodo size={18} className="shrink-0" />
                  <span>{t("memoTitle")}</span>
                </button>
              </div>
            )}

            <div className="px-2 pb-2">
              <button
                type="button"
                onClick={() =>
                  setPage(page === "settings" || page === "packages" ? "chat" : "settings")
                }
                data-ui="nav-item"
                data-state={page === "settings" || page === "packages" ? "active" : "inactive"}
                title={t("settingsTitle")}
                aria-label={t("settingsTitle")}
                aria-pressed={page === "settings" || page === "packages"}
                className={`flex h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors ${
                  page === "settings" || page === "packages"
                    ? "theme-nav-active bg-nav-active text-nav-active-foreground"
                    : "text-foreground hover:bg-surface-overlay"
                }`}
              >
                <Settings size={18} className="shrink-0" />
                <span>{t("settingsTitle")}</span>
              </button>
            </div>

            <div className="border-t border-border px-2 py-3">
              <WorkspacePicker />
            </div>

            {/* Collapsed or not, the header row stays in place below Workspaces. */}
            <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {telegramViewActive ? (
                <TelegramSessionList />
              ) : (
                <SessionList
                  showCreateAction={false}
                  collapsed={sessionsCollapsed}
                  onToggleCollapsed={toggleSessionsCollapsed}
                />
              )}
            </div>
          </>
        )}
      </aside>
    </Fragment>
  );
}
