import { Search, Sparkles } from "lucide-react";
import { useAppStore } from "../lib/stores/app-store";
import { useT } from "../lib/i18n/use-t";
import { requestGlobalSearchOpen } from "../lib/commands/events";
import { NotificationCenter } from "./NotificationCenter";
import { DockToggleButton } from "./DockToggleButton";
import { AppUpdateButton } from "./AppUpdateButton";
import { WindowControls, resolveWindowControlsPlatform } from "./WindowControls";
import { SidebarBrandToggle } from "./Sidebar";
import { MemoSyncHeaderActions } from "../features/memo/MemoSyncHeaderActions";
import { usePluginEnabled } from "../features/plugin-library/plugin-gate";
import { MEMO_PLUGIN_ID, MEMO_PLUGIN_ID_LEGACY } from "../features/plugin-library/plugin-ids";
import { SubagentTitleMenu } from "../features/subagents/SubagentTitleMenu";
import { PixieBackToCurrentButton } from "../features/pixie/PixieBackToCurrentButton";
import { PixiePanelToggleButton } from "../features/pixie/PixiePanelToggleButton";
import { clampSessionTitleForDisplay } from "../lib/session-title-display";

/** Single full-width app-level top bar replacing the three independent header
 *  strips (sidebar brand / chat title / dock header).
 *
 *  Left: brand toggle + global search + notifications, with macOS traffic
 *  lights slotting in front. Center: chat session title. Right: right-panel
 *  toggle (chat only) + native window controls.
 *
 *  Height follows --theme-toolbar-height so each theme gets the same bar height
 *  it used per-strip; the whole row is a Tauri drag region. All children sit on
 *  the vertical center via items-center on each flex container. */
/** 顶栏右侧动作与标题状态点都跟着这个插件走（待办 · 速记已并入小精灵随行面板）。 */

export function AppTopBar({
  actionsSlotRef,
}: {
  actionsSlotRef: (el: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const memoPluginEnabled = usePluginEnabled(MEMO_PLUGIN_ID);
  const memoLegacyEnabled = usePluginEnabled(MEMO_PLUGIN_ID_LEGACY);
  const memoEnabled = memoPluginEnabled || memoLegacyEnabled;
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const session = useAppStore((s) => s.session);
  const sessionTreeNavigated = useAppStore((s) => s.sessionTreeNavigated);
  const host = useAppStore((s) => s.host);
  const activeSubagentNodeId = useAppStore((s) => s.activeSubagentNodeId);
  const setActiveSubagent = useAppStore((s) => s.setActiveSubagent);
  const platform = resolveWindowControlsPlatform();

  const isNewConversation = Boolean(
    session && session.messages.length === 0 && session.isIdle && !sessionTreeNavigated,
  );
  const sessionName = session?.name?.trim() || t("chatNewConversation");
  // Old sessions on disk can carry pre-cap titles; clamp only the visible text
  // so tooltips and the rename dialog still see the full name.
  const sessionNameDisplay = clampSessionTitleForDisplay(sessionName);
  const sessionActive = Boolean(session) && !isNewConversation;

  // Subagent conversation view: the breadcrumb title doubles as the back
  // button; the runtime status pill was removed from the header.
  const subagentActive = Boolean(activeSubagentNodeId);

  return (
    <header
      className="relative z-30 flex h-[var(--theme-toolbar-height)] shrink-0 items-stretch gap-2 text-foreground"
      data-app-topbar
      data-window-platform={platform}
      data-page={page}
      data-tauri-drag-region="deep"
    >
      {/* Left segment: brand + search + notifications (+ macOS traffic lights).
          Its min width tracks the live sidebar width so the center column above
          begins exactly where the content card below begins. */}
      <div
        className={`flex shrink-0 items-center ${
          sidebarCollapsed ? "gap-1.5 pl-4 pr-1.5" : "gap-3 px-4"
        }`}
        data-sidebar-header
        data-tauri-drag-region
        style={{ minWidth: "var(--sidebar-width, 0px)" }}
      >
        {platform === "macos" && <WindowControls platform="macos" />}
        <SidebarBrandToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        {!sidebarCollapsed && (
          <span className="text-[13px] font-semibold" data-sidebar-brand>
            Pi Abyss
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {!sidebarCollapsed && (
            <button
              type="button"
              title={t("commandGlobalSearch")}
              aria-label={t("commandGlobalSearch")}
              disabled={!host}
              className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
              onClick={requestGlobalSearchOpen}
            >
              <Search size={15} />
            </button>
          )}
          <NotificationCenter />
        </div>
      </div>

      {/* Center segment: chat session title (settings/pages keep an empty
          drag-region spacer). Left-aligned to the content-area start: its left
          edge lies at the sidebar-right edge (via the left segment's
          --sidebar-width min-width) plus the app shell gap, so the title
          begins where the content card below begins instead of floating
          centered apart from the search button on its left. The same base is
          shared by chat and settings pages so the section nav offset is
          intentionally not added here. */}
      <div
        className="flex min-w-0 flex-1 items-center justify-start gap-3 pr-2"
        style={{
          paddingLeft: sidebarCollapsed
            ? "calc(var(--app-content-gap, 8px) / 2)"
            : "var(--app-content-gap, 8px)",
        }}
      >
        {page === "chat" ? (
          <div
            className="flex min-w-0 flex-1 items-center gap-4"
            data-chat-header
            data-tauri-drag-region
          >
            <div className="pointer-events-none flex min-w-0 items-center justify-start gap-2">
              {sessionActive && (
                <>
                  {subagentActive ? (
                    <h1
                      className="pointer-events-none min-w-0 max-w-full text-base font-semibold leading-5"
                      title={sessionName}
                    >
                      <button
                        type="button"
                        data-tauri-drag-region="false"
                        data-back-to-main-session
                        className="pointer-events-auto -mx-1.5 block max-w-full truncate rounded-md px-1.5 py-1 text-left leading-none transition-colors hover:bg-surface-overlay"
                        title={t("chatBackToMainSession")}
                        aria-label={t("chatBackToMainSession")}
                        onClick={() => setActiveSubagent(null)}
                      >
                        {sessionNameDisplay}
                      </button>
                    </h1>
                  ) : (
                    <h1
                      /* Same leading-none + py/-my compensation as the
                         subagent-view back button so the title glyph stays
                         pixel-identical when the view switches. */
                      className="-my-1 truncate py-1 text-base font-semibold leading-none"
                      title={sessionName}
                    >
                      {sessionNameDisplay}
                    </h1>
                  )}
                  {/* Subagent view keeps the breadcrumb next to the main
                      title; the main view puts the bot entry behind the
                      title. */}
                  {subagentActive && <SubagentTitleMenu />}
                  {!subagentActive && <SubagentTitleMenu />}
                </>
              )}
            </div>
          </div>
        ) : page === "pixie" ? (
          <div
            className="pointer-events-none flex min-w-0 flex-1 items-center gap-2"
            data-tauri-drag-region
          >
            <Sparkles
              size={16}
              className="pointer-events-none shrink-0 text-accent"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {subagentActive ? (
                /* 子代理视图：标题降级为返回按钮（回小精灵主会话），
                 * 后接 SubagentTitleMenu 的 run 面包屑——与 chat 分支
                 * 同一套交互。 */
                <button
                  type="button"
                  data-tauri-drag-region="false"
                  data-back-to-main-session
                  className="pointer-events-auto -mx-1.5 block max-w-full truncate rounded-md px-1.5 py-1 text-left leading-none transition-colors hover:bg-surface-overlay"
                  title={t("chatBackToMainSession")}
                  aria-label={t("chatBackToMainSession")}
                  onClick={() => setActiveSubagent(null)}
                >
                  <span className="text-base font-semibold leading-5">{t("pixieTitle")}</span>
                </button>
              ) : (
                <h1 className="min-w-0 shrink-0 truncate text-base font-semibold leading-5">
                  {t("pixieTitle")}
                </h1>
              )}
              <SubagentTitleMenu />
            </div>
          </div>
        ) : page === "settings" || page === "packages" ? (
          <div
            className="pointer-events-none flex min-w-0 flex-1"
            data-settings-section-header
            data-tauri-drag-region
          />
        ) : null}
      </div>

      {/* Actions portal target (settings/packages). Renders section action
          buttons from SettingsTopBarActions via the Context provided in App. */}
      <div
        className="flex shrink-0 items-center gap-2"
        data-settings-header-actions
        ref={actionsSlotRef}
      >
        {page === "pixie" && (
          <>
            {/* 待办 · 速记的数据入口现在只有随行面板这一处，云同步入口跟着搬进小精灵页：
              一个图标，最近同步失败时它自己变红。原先顶栏那颗绿色状态点与「立即同步」
              按钮都撤了——两颗点并排读不出谁是谁，而同步动作在弹窗里做。它内部挂着
              30s 共享轮询，所以「同步落地 → 面板刷新」这条广播还在（没人挂轮询就停了）。
              插件停用时空档自然消失（面板那块也不渲染）。 */}
            {memoEnabled && <MemoSyncHeaderActions />}
            {/* 打开历史段时出现的「回到最新会话」入口；正开着活段时自隐藏。
               会话列表在侧边栏左下角，与普通工作区同款。 */}
            <PixieBackToCurrentButton />
          </>
        )}
      </div>

      {/* Right segment: download-and-update (while an update is available) +
          right-panel toggle (chat = workspace dock, pixie = side panel) +
          native window controls. */}
      <div className="flex shrink-0 items-center gap-1" data-app-topbar-right>
        <AppUpdateButton />
        {page === "chat" && <DockToggleButton />}
        {page === "pixie" && <PixiePanelToggleButton />}
        {platform === "windows" && <WindowControls platform="windows" />}
      </div>
    </header>
  );
}
