/**
 * Schedule push notifications: incrementally consumes the plugin's
 * notify-queue (schedule.listNotifications) and delivers new entries as
 * system notifications for plans whose per-plan `notify` config is
 * "system". Runs at app level (mounted from App.tsx) so pushes fire while
 * the user is on any page, not just the schedule page. TG delivery will
 * join later as an additional per-plan mode. The plugin queues every
 * terminal state (ok/error/timeout/aborted).
 *
 * Delivery is event-driven: the Host watches the plugin's notify-queue file
 * and emits `schedule.notificationsChanged` on every append; this module
 * reacts immediately and falls back to a slow interval poll as a safety
 * net (e.g. missed events while the transport reconnects).
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import type { ScheduleNotification } from "@piabyss/protocol";

const POLL_INTERVAL_MS = 60_000;
/** Coalesce bursts of file-watch events into one pull. */
const EVENT_DEBOUNCE_MS = 500;
const LIST_TIMEOUT_MS = 10_000;
const CURSOR_KEY = "piabyss.schedule.pushCursor.v1";

function readCursor(): string | null {
  try {
    return globalThis.localStorage?.getItem(CURSOR_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeCursor(cursor: string): void {
  try {
    globalThis.localStorage?.setItem(CURSOR_KEY, cursor);
  } catch {
    /* unavailable */
  }
}

/** Entries are chronologically ordered by `at`; the cursor is the last
 *  delivered `${at}#${runId}`. Ties on `at` compare by runId — order within
 *  the same tick only affects delivery order, not loss. */
function entryCursor(entry: ScheduleNotification): string {
  return `${entry.at}#${entry.runId}`;
}

async function deliver(entry: ScheduleNotification): Promise<void> {
  try {
    // The stock @tauri-apps/plugin-notification JS wrapper is broken on
    // Windows (WebView2 reports permission "denied" unconditionally; see
    // system-notifications.ts / tauri-apps/plugins-workspace#3512), so
    // delivery goes through the app's own Rust command: on Windows it shows
    // a WinRT toast; other desktop platforms fall back to the plugin's
    // builder internally. No click-routing `extra`: a click just dismisses.
    await invoke("system_notify", {
      options: {
        title: entry.title,
        body: entry.message,
      },
    });
  } catch {
    /* notification delivery is best-effort */
  }
}

/** Per-plan notify config, refreshed each poll (jobId → notify mode). */
async function loadNotifyMap(host: NonNullable<ReturnType<typeof useAppStore.getState>["host"]>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const response = await hostClient.request(
      "schedule.listJobs",
      hostContext(host),
      null,
      LIST_TIMEOUT_MS,
    );
    if (response.ok) {
      for (const job of response.result.jobs) map.set(job.id, job.notify ?? "none");
    }
  } catch {
    /* fall back to an empty map: nothing gets delivered this tick */
  }
  return map;
}

async function poll(): Promise<void> {
  if (!isTauri()) return;
  const host = useAppStore.getState().host;
  if (!host) return;
  try {
    const response = await hostClient.request(
      "schedule.listNotifications",
      hostContext(host),
      { limit: 50 },
      LIST_TIMEOUT_MS,
    );
    if (!response.ok || response.result.entries.length === 0) return;
    const entries = response.result.entries;
    const notifyMap = await loadNotifyMap(host);
    const cursor = readCursor();
    // The plugin's notify-queue is ordered oldest→newest (file order); the
    // cursor must advance past the NEWEST entry or every poll re-delivers.
    // First run: adopt it without replaying history — only runs finishing
    // from now on should notify.
    const newest = entries.reduce(
      (acc, entry) => (entryCursor(entry) > acc ? entryCursor(entry) : acc),
      "",
    );
    if (cursor === null) {
      writeCursor(newest);
      return;
    }
    const fresh = entries
      .filter((entry) => entryCursor(entry) > cursor)
      .filter((entry) => (notifyMap.get(entry.jobId) ?? "none") === "system");
    if (fresh.length > 0) {
      for (const entry of fresh) await deliver(entry);
    }
    writeCursor(newest);
  } catch {
    /* transient transport failures retry on the next tick */
  }
}

let started = false;
let eventDebounce: ReturnType<typeof setTimeout> | null = null;
let unsubscribeEvents: (() => void) | null = null;

/** Immediate pull after a host-side queue change; debounced to coalesce bursts. */
function scheduleEventPoll(): void {
  if (eventDebounce) clearTimeout(eventDebounce);
  eventDebounce = setTimeout(() => {
    eventDebounce = null;
    void poll();
  }, EVENT_DEBOUNCE_MS);
}

/** Idempotent: mounts the event subscription + polling interval once per app lifetime. */
export function startSchedulePushPolling(): () => void {
  if (started) return () => undefined;
  started = true;
  // Real-time path: the Host emits schedule.notificationsChanged whenever the
  // plugin's notify-queue grows (file watch on the Host side).
  unsubscribeEvents = hostClient.onEvent((event) => {
    if (event.event === "schedule.notificationsChanged") scheduleEventPoll();
  });
  // Safety net: covers missed events (transport reconnect, watcher restart).
  const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
  return () => {
    clearInterval(interval);
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    if (eventDebounce) clearTimeout(eventDebounce);
    eventDebounce = null;
    started = false;
  };
}
