/**
 * Periodic shell job snapshot push.
 *
 * pi's shelljob tool only mutates the on-disk job store; there is no event
 * channel, so a short-interval poll is the source of truth. The desktop's
 * status bar re-renders on the resulting `shelljobs.changed` event only when
 * the snapshot actually changed, so idle cost is one enqueued (deduplicated)
 * event per poll.
 *
 * Idle cost matters here: this timer runs from host start regardless of what
 * the user is doing, and a busy store (a few hundred job directories) made the
 * old "read every job.json/status.json, then compare" loop the single most
 * expensive thing the idle Host did. The poll now compares a stat-only
 * signature first and only touches file contents when something moved.
 */
import type { HostEventName } from "@piabyss/protocol";
import { readShellJobs, shelljobJobsRoot, shelljobStoreSignature } from "./shelljob-store.js";

const POLL_MS = 2_000;

export function startShellJobWatcher(
  emit: (event: HostEventName, payload: unknown) => void,
  options: { pollMs?: number; root?: string } = {},
): () => void {
  const root = options.root ?? shelljobJobsRoot();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSignature = "";
  let lastSnapshot = "";
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    let signature: string;
    try {
      signature = shelljobStoreSignature(root);
    } catch {
      return; // transient fs error — keep the previous snapshot
    }
    // Nothing moved on disk: skip the full read entirely.
    if (signature === lastSignature) return;
    let jobs;
    try {
      jobs = readShellJobs(root);
    } catch {
      // Leave lastSignature stale so the next tick retries this change.
      return;
    }
    lastSignature = signature;
    const snapshot = JSON.stringify(jobs);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    emit("shelljobs.changed", { jobs });
  };

  timer = setInterval(poll, options.pollMs ?? POLL_MS);
  // First snapshot goes out immediately so the bar hydrates without waiting.
  poll();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
