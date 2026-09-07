import { ChevronDown, LoaderCircle, RefreshCw, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type { TelegramSessionSummary } from "@piabyss/protocol";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { sidebarPref, setSidebarPref } from "../../lib/sidebar-prefs";
import { useT } from "../../lib/i18n/use-t";
import { useTelegramViewStore } from "./telegram-view-store";

/** Display title for a telegram-driven session row. */
export function telegramSessionTitle(session: TelegramSessionSummary): string {
  if (session.name?.trim()) return session.name.trim();
  const cwdName = session.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  if (cwdName) return cwdName;
  return session.sessionPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Telegram session";
}

/** Compact time label for the row (HH:MM today, M/D HH:MM otherwise). */
export function telegramSessionTime(updatedAt: number): string | null {
  if (!updatedAt) return null;
  const date = new Date(updatedAt);
  // Explicit 24-hour (h23) so the label is stable across en-US (AM/PM), zh-CN,
  // and CI locales; the compact row format is documented as HH:MM.
  const hhmm = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return hhmm;
  return `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

/**
 * Session-sidebar replacement for the telegram view: one row per Pi session
 * the plugin delivered telegram messages into (newest first), read-only.
 * Clicking a row opens the session as a read-only transcript in the main pane.
 */
export function TelegramSessionList() {
  const t = useT();
  const sessions = useTelegramViewStore((s) => s.sessions);
  const loading = useTelegramViewStore((s) => s.loading);
  const loaded = useTelegramViewStore((s) => s.loaded);
  const error = useTelegramViewStore((s) => s.error);
  const openSessionPath = useTelegramViewStore((s) => s.openSessionPath);
  const refresh = useTelegramViewStore((s) => s.refreshTelegramSessions);
  const openSession = useTelegramViewStore((s) => s.openTelegramSession);
  const [collapsed, setCollapsed] = useState(() =>
    sidebarPref("piabyss.sidebar.telegramSessionsCollapsed"),
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section>
      <div className="mb-1 flex h-7 items-center justify-between px-2">
        <button
          type="button"
          onClick={() => {
            setCollapsed((current) => {
              setSidebarPref("piabyss.sidebar.telegramSessionsCollapsed", !current);
              return !current;
            });
          }}
          aria-expanded={!collapsed}
          aria-controls="telegram-sessions-region"
          title={collapsed ? t("tgSessionsExpand") : t("tgSessionsCollapse")}
          className="group flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-foreground"
        >
          <Send size={13} className="shrink-0 text-accent" />
          <span>{t("tgSessionsTitle")}</span>
          <ChevronDown
            size={12}
            className={`opacity-0 transition-all group-hover:opacity-100 ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
          title={t("tgSessionsRefresh")}
          aria-label={t("tgSessionsRefresh")}
        >
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      <CollapsibleRegion open={!collapsed} id="telegram-sessions-region">
        {error ? (
          <div className="px-2.5 py-2 text-xs text-danger">
            <span className="block">{error}</span>
            <button
              type="button"
              className="mt-1 rounded border border-border px-2 py-0.5 hover:bg-surface-overlay"
              onClick={() => void refresh()}
            >
              {t("commonRetry")}
            </button>
          </div>
        ) : loaded && sessions.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-muted">{t("tgSessionsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const selected = session.sessionPath === openSessionPath;
              const preview = session.preview?.trim();
              return (
                <li key={session.sessionPath}>
                  <button
                    type="button"
                    data-tg-session-row={session.sessionPath}
                    onClick={() => void openSession(session.sessionPath)}
                    aria-current={selected ? "true" : undefined}
                    title={session.preview ?? telegramSessionTitle(session)}
                    className={`interface-density-nav-row flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left ${
                      selected ? "bg-surface-overlay" : "hover:bg-surface-overlay/70"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2 text-[12px]">
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          selected ? "text-foreground" : "text-foreground/80"
                        }`}
                      >
                        {telegramSessionTitle(session)}
                      </span>
                      <span className="shrink-0 rounded bg-accent/15 px-1 py-px text-[10px] text-accent">
                        {session.telegramMessageCount}
                      </span>
                      {telegramSessionTime(session.updatedAt) && (
                        <span className="shrink-0 text-[10px] text-muted">
                          {telegramSessionTime(session.updatedAt)}
                        </span>
                      )}
                    </span>
                    {preview && <span className="truncate text-[11px] text-muted">{preview}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleRegion>
    </section>
  );
}
