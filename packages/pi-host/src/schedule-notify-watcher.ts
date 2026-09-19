/**
 * Real-time schedule notification signal.
 *
 * The pi-schedule plugin appends every terminal run state to
 * `<scheduleRoot>/notify-queue.jsonl`. This watcher watches that file and
 * emits `schedule.notificationsChanged` so the desktop panel can deliver
 * system notifications immediately instead of waiting for its 60s polling
 * fallback.
 *
 * The watch target is the FILE, not the plugin: the queue lives in a shared
 * data dir, and in dev two Host processes may share it — the plugin that
 * writes entries is whichever process owns the control-plane port, so a
 * file-level watch is the correct boundary.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEventName } from "@piabyss/protocol";
import { scheduleRoot } from "./schedule-api.js";

const DEBOUNCE_MS = 400;
/** Root may not exist yet at Host start (plugin creates it lazily) — re-arm. */
const RETRY_MS = 15_000;
const QUEUE_FILENAME = "notify-queue.jsonl";

export function startScheduleNotifyWatcher(
  emit: (event: HostEventName, payload: unknown) => void,
): () => void {
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const queueFile = () => join(scheduleRoot(), QUEUE_FILENAME);

  const emitChange = () => {
    if (closed) return;
    let total = 0;
    try {
      total = readFileSync(queueFile(), "utf8").split("\n").filter((line) => line.trim()).length;
    } catch {
      /* file missing → total 0 */
    }
    emit("schedule.notificationsChanged", { total });
  };

  const scheduleChange = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      emitChange();
    }, DEBOUNCE_MS);
  };

  const ensureWatch = () => {
    if (closed || watcher) return;
    try {
      watcher = watch(scheduleRoot(), { persistent: false }, (_event, filename) => {
        // filename can be null on some platforms; treat it as a queue hint.
        if (filename === null || filename === QUEUE_FILENAME) scheduleChange();
      });
      watcher.on("error", () => {
        try {
          watcher?.close();
        } catch {
          /* already closed */
        }
        watcher = null;
        if (!closed) retry = setTimeout(ensureWatch, RETRY_MS);
      });
    } catch {
      watcher = null;
      if (!closed) retry = setTimeout(ensureWatch, RETRY_MS);
    }
  };

  ensureWatch();

  return () => {
    closed = true;
    if (debounce) clearTimeout(debounce);
    if (retry) clearTimeout(retry);
    debounce = null;
    retry = null;
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
  };
}
