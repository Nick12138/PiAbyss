/**
 * Periodic shell job snapshot push.
 *
 * pi's shelljob tool only mutates the on-disk job store; there is no event
 * channel, so a short-interval poll (cheap: a readdir + a handful of tiny
 * JSON reads) is the source of truth. The desktop's status bar re-renders on
 * the resulting `shelljobs.changed` event only when the snapshot actually
 * changed, so idle cost is one enqueued (deduplicated) event per poll.
 */
import type { HostEventName } from "@piabyss/protocol";
import { readShellJobs, shelljobJobsRoot } from "./shelljob-store.js";

const POLL_MS = 2_000;

export function startShellJobWatcher(
  emit: (event: HostEventName, payload: unknown) => void,
  options: { pollMs?: number; root?: string } = {},
): () => void {
  const root = options.root ?? shelljobJobsRoot();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSnapshot = "";
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    let jobs;
    try {
      jobs = readShellJobs(root);
    } catch {
      return; // transient fs error — keep the previous snapshot
    }
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
