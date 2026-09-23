import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import type { ShellJobStatus, ShellJobSummary } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { activeSessionContext, hostContext } from "../../lib/bridge/host-context";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { useT } from "../../lib/i18n/use-t";

/**
 * Compact auto-scaling duration: 3.5s → 42s → 12m30s → 2h5m.
 * (ToolCard.formatDuration stays raw-seconds for its own contexts.)
 */
function formatJobDuration(startedAt: number, end: number): string {
  const elapsedMs = Math.max(0, end - startedAt);
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  if (totalSeconds < 10) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${totalSeconds}s`;
}

/**
 * Background shell job status bar above the composer. Shows only RUNNING
 * jobs with a live duration and a stop control; finished jobs disappear from
 * the bar (their results live in the conversation). Clicking a row opens the
 * session that submitted the job.
 */

const STATUS_CLASS: Record<ShellJobStatus, string> = {
  running: "bg-accent animate-pulse",
  completed: "bg-success",
  failed: "bg-danger",
  killed: "bg-muted",
  unknown: "bg-muted",
};

/** Re-renders once per second while running jobs are on screen. */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusLabel(t: ReturnType<typeof useT>, status: ShellJobStatus): string {
  switch (status) {
    case "running":
      return t("shellJobStatusRunning");
    case "completed":
      return t("shellJobStatusCompleted");
    case "failed":
      return t("shellJobStatusFailed");
    case "killed":
      return t("shellJobStatusKilled");
    default:
      return t("shellJobStatusUnknown");
  }
}

function JobRow({
  job,
  now,
  stopping,
  confirmStop,
  onOpenSession,
  onRequestStop,
  onConfirmStop,
}: {
  job: ShellJobSummary;
  now: number;
  stopping: boolean;
  confirmStop: boolean;
  onOpenSession: (job: ShellJobSummary) => void;
  onRequestStop: (job: ShellJobSummary) => void;
  onConfirmStop: (job: ShellJobSummary) => void;
}) {
  const t = useT();
  const duration = job.startedAt === undefined ? undefined : formatJobDuration(job.startedAt, now);
  const label = job.title ?? job.command;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs">
      <span
        className={`size-2 shrink-0 rounded-full ${STATUS_CLASS[job.status]}`}
        title={statusLabel(t, job.status)}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={t("shellJobOpenSessionTitle", { cwd: job.cwd })}
        onClick={() => onOpenSession(job)}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {duration && <span className="shrink-0 tabular-nums text-muted">{duration}</span>}
      </button>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-surface-overlay hover:text-danger disabled:opacity-40"
        disabled={stopping}
        onClick={() => (confirmStop ? onConfirmStop(job) : onRequestStop(job))}
      >
        <Square size={10} />
        <span>{confirmStop ? t("shellJobStopConfirm") : t("shellJobStop")}</span>
      </button>
    </div>
  );
}

export function ShellJobsBar() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const jobs = useAppStore((s) => s.shellJobs);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate the snapshot (the changed event only arrives on the next delta).
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    hostClient
      .request("shelljobs.list", hostContext(host), null)
      .then((res) => {
        if (!cancelled && res.ok && Array.isArray(res.result?.jobs)) {
          useAppStore.getState().setShellJobs(res.result.jobs);
        }
      })
      .catch(() => {
        /* transient — the watcher event heals the snapshot */
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const running = jobs.filter((job) => job.status === "running");
  const now = useNowTicker(running.length > 0);
  if (running.length === 0) return null;

  const openSession = async (job: ShellJobSummary) => {
    const outcome = await openSessionAcrossWorkspaces({ cwd: job.cwd, sessionId: job.sessionId });
    if (outcome.status === "archived" || outcome.status === "failed") {
      pushNotification(t("shellJobOpenSessionFailed"), "info");
    }
  };

  const requestStop = (job: ShellJobSummary) => {
    setConfirmStopId(job.id);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    // Two-click confirm: the second click within the window actually stops.
    confirmTimer.current = setTimeout(() => setConfirmStopId(null), 4_000);
  };

  const confirmStop = async (job: ShellJobSummary) => {
    if (!host) return;
    setStoppingId(job.id);
    setConfirmStopId(null);
    try {
      const res = await hostClient.request("shelljobs.stop", hostContext(host), { jobId: job.id });
      if (!res.ok) {
        pushNotification(t("shellJobStopFailed"), "error");
        return;
      }
      // Notify the owning agent (current session only — cross-session
      // injection is not possible from the desktop).
      const state = useAppStore.getState();
      const session = state.session;
      const workspace = state.workspace;
      if (session && workspace && job.sessionId === session.sessionId) {
        const text = t("shellJobStoppedNotifyAgent", {
          title: job.title ?? job.command,
          jobId: job.id,
        });
        await hostClient.request("agent.followUp", activeSessionContext(host, workspace, session), {
          text,
        });
      } else {
        pushNotification(t("shellJobStoppedOtherSession"), "info");
      }
    } finally {
      setStoppingId(null);
    }
  };

  return (
    <div
      className="conversation-content-width mx-auto mb-1.5 flex flex-col gap-1"
      data-testid="shell-jobs-bar"
    >
      {running.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          stopping={stoppingId === job.id}
          confirmStop={confirmStopId === job.id}
          onOpenSession={(target) => void openSession(target)}
          onRequestStop={requestStop}
          onConfirmStop={(target) => void confirmStop(target)}
        />
      ))}
    </div>
  );
}
