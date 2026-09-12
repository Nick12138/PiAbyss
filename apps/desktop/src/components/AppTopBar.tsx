import { GitBranch, Search } from "lucide-react";
import { useAppStore } from "../lib/stores/app-store";
import { useT } from "../lib/i18n/use-t";
import { requestGlobalSearchOpen } from "../lib/commands/events";
import { requestTreeOverlay } from "../lib/tree-overlay";
import { NotificationCenter } from "./NotificationCenter";
import { DockToggleButton } from "./DockToggleButton";
import { WindowControls, resolveWindowControlsPlatform } from "./WindowControls";
import { SidebarBrandToggle } from "./Sidebar";
import { SETTINGS_SECTION_META } from "../features/settings/settings-top-bar";

/** Single full-width app-level top bar replacing the three independent header
 *  strips (sidebar brand / chat title / dock header).
 *
 *  Left: brand toggle + global search + notifications, with macOS traffic
 *  lights slotting in front. Center: chat session title, or the active settings
 *  section title. Right: right-panel toggle (chat only) + native window controls.
 *
 *  Height follows --theme-toolbar-height so each theme gets the same bar height
 *  it used per-strip; the whole row is a Tauri drag region. All children sit on
 *  the vertical center via items-center on each flex container. */
export function AppTopBar({
  actionsSlotRef,
}: {
  actionsSlotRef: (el: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const session = useAppStore((s) => s.session);
  const sessionTreeNavigated = useAppStore((s) => s.sessionTreeNavigated);
  const host = useAppStore((s) => s.host);
  const platform = resolveWindowControlsPlatform();

  const section = settingsSection ?? "general";
  const meta = SETTINGS_SECTION_META[section];
  const SettingsHeaderIcon = meta.icon;

  const isNewConversation = Boolean(
    session && session.messages.length === 0 && session.isIdle && !sessionTreeNavigated,
  );
  const sessionName = session?.name?.trim() || t("chatNewConversation");
  const runtimeLabel = session?.isStreaming
    ? t("chatStatusStreaming")
    : session?.isCompacting
      ? t("chatStatusCompacting")
      : session?.isRetrying
        ? t("chatStatusRetrying")
        : session?.isIdle
          ? t("chatStatusReady")
          : t("chatStatusWorking");
  const sessionActive = Boolean(session) && !isNewConversation;

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
        className="flex shrink-0 items-center gap-3 px-4"
        data-sidebar-header
        data-tauri-drag-region
        style={{ minWidth: "var(--sidebar-width, 0px)" }}
      >
        {platform === "macos" && <WindowControls platform="macos" />}
        <SidebarBrandToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        {!sidebarCollapsed && (
          <span className="text-[13px] font-semibold" data-sidebar-brand>
            Pi Agent
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

      {/* Center segment: chat session title, or active settings section title.
          Left-aligned to the content-area start: its left edge lies at the
          sidebar-right edge (via the left segment's --sidebar-width min-width)
          plus the app shell gap, so the title begins where the content card
          below begins instead of floating centered apart from the search
          button on its left. The same base is shared by chat and settings pages
          so the section nav offset is intentionally not added here. */}
      <div
        className="flex min-w-0 flex-1 items-center justify-start gap-3 pr-2"
        style={{ paddingLeft: "var(--app-content-gap, 8px)" }}
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
                  <h1 className="truncate text-base font-semibold leading-5" title={sessionName}>
                    {sessionName}
                  </h1>
                  <span
                    className="flex shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted"
                    data-chat-status
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        session?.isStreaming || (session && !session.isIdle)
                          ? "bg-success"
                          : "bg-muted"
                      }`}
                      title={session ? runtimeLabel : t("chatNoActiveSession")}
                    />
                    <span>{runtimeLabel}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        ) : page === "settings" || page === "packages" ? (
          <div
            className="pointer-events-none flex min-w-0 flex-1 items-center gap-2"
            data-settings-section-header
            data-tauri-drag-region
          >
            <SettingsHeaderIcon
              size={16}
              className="pointer-events-none shrink-0 text-muted"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 truncate">
              <h1 className="truncate text-base font-semibold leading-5">{t(meta.title)}</h1>
              {meta.subtitle && <p className="truncate text-xs text-muted">{t(meta.subtitle)}</p>}
            </div>
          </div>
        ) : null}
      </div>

      {/* Actions portal target (settings/packages). Renders section action
          buttons from SettingsTopBarActions via the Context provided in App. */}
      <div
        className="flex shrink-0 items-center gap-2"
        data-settings-header-actions
        ref={actionsSlotRef}
      />

      {/* Right segment: session tree + right-panel toggle (chat only) + native
          window controls. The session tree left the dock, so its entry lives
          here next to the other chat-level actions. */}
      <div className="flex shrink-0 items-center gap-1" data-app-topbar-right>
        {page === "chat" && (
          <button
            type="button"
            title={t("commandOpenTree")}
            aria-label={t("commandOpenTree")}
            disabled={!session}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
            onClick={requestTreeOverlay}
          >
            <GitBranch size={15} />
          </button>
        )}
        {page === "chat" && <DockToggleButton />}
        {platform === "windows" && <WindowControls platform="windows" />}
      </div>
    </header>
  );
}
