/**
 * Schedule push notifications: incrementally consumes the plugin's
 * notify-queue (schedule.listNotifications) and delivers new entries as
 * system notifications for plans whose per-plan `notify` config is
 * "system". Runs at app level (mounted from App.tsx) so pushes fire while
 * the user is on any page, not just the schedule page. TG delivery will
 * join later as an additional per-plan mode. The plugin queues every
 * terminal state (ok/error/timeout/aborted).
 */
import { isTauri } from "@tauri-apps/api/core";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import type { ScheduleNotification } from "@piabyss/protocol";

const POLL_INTERVAL_MS = 60_000;
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
    const api = await import("@tauri-apps/plugin-notification");
    if (await api.isPermissionGranted()) {
      api.sendNotification({
        title: entry.title,
        body: entry.message,
      });
    }
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
    // First run: adopt the newest entry as the cursor without replaying
    // history — only runs finishing from now on should notify.
    const newest = entryCursor(entries[0]);
    if (cursor === null) {
      writeCursor(newest);
      return;
    }
    const fresh = entries
      .filter((entry) => entryCursor(entry) > cursor)
      .filter((entry) => (notifyMap.get(entry.jobId) ?? "none") === "system");
    if (fresh.length > 0) {
      for (const entry of fresh.reverse()) await deliver(entry);
    }
    writeCursor(newest);
  } catch {
    /* transient transport failures retry on the next tick */
  }
}

let started = false;

/** Idempotent: mounts the polling interval once per app lifetime. */
export function startSchedulePushPolling(): void {
  if (started) return;
  started = true;
  setInterval(() => void poll(), POLL_INTERVAL_MS);
}
