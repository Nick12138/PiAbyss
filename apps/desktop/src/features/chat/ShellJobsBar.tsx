import { useId, useLayoutEffect, useRef, useState, useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Square, Terminal } from "lucide-react";
import type { ShellJobStatus, ShellJobSummary } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext, workspaceContext } from "../../lib/bridge/host-context";
import { openSessionAcrossWorkspaces } from "../../lib/bridge/session-navigation";
import { useT } from "../../lib/i18n/use-t";

/**
 * Background shell job status above the composer.
 *
 * A compact pill (running count + first command) is the only persistent UI.
 * Clicking it opens a floating popover (portal, viewport-clamped) listing
 * every visible job grouped current-session-first. Jobs that finish stay
 * for a short grace window with their final status so the outcome is not
 * missed, and a running→failed transition raises an error notification.
 * Each row can open a live tail of the job's output.log.
 */

/** Finished jobs stay visible this long so their outcome is not missed. */
const RETAIN_FINISHED_MS = 10_000;
/** Poll cadence for the output panel of a running job. */
const OUTPUT_POLL_MS = 3_000;
const OUTPUT_LINE_LIMIT = 200;

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

const STATUS_CLASS: Record<ShellJobStatus, string> = {
  running: "bg-accent animate-pulse",
  completed: "bg-success",
  failed: "bg-danger",
  killed: "bg-muted",
  unknown: "bg-muted",
};

/** Re-renders once per second while any visible job is on screen. */
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

/** Short workspace badge for jobs owned by another session. */
function cwdBadge(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1] ?? cwd;
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

/** Live tail of one job's output.log; polls while the job is still running. */
function JobOutput({ job }: { job: ShellJobSummary }) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const [state, setState] = useState<{ lines: string[]; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const running = job.status === "running";

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await hostClient.request("shelljobs.output", hostContext(host), {
          jobId: job.id,
          limit: OUTPUT_LINE_LIMIT,
        });
        if (cancelled) return;
        if (res.ok) {
          setState({ lines: res.result.lines, truncated: res.result.truncated });
          setFailed(null);
        } else {
          setFailed(res.error.message);
        }
      } catch (error) {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    if (!running)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(() => void load(), OUTPUT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [host, job.id, running]);

  // Keep the tail pinned to the newest output.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state]);

  return (
    <div className="mt-1.5 rounded-md border border-border bg-surface px-2 py-1">
      <div
        ref={scrollRef}
        className="max-h-40 overflow-y-auto font-mono text-[11px] leading-4 break-all"
        data-testid={`shell-job-output-${job.id}`}
      >
        {failed ? (
          <span className="text-danger">
            {t("shellJobOutputFailed")}: {failed}
          </span>
        ) : !state || state.lines.length === 0 ? (
          <span className="text-muted">{t("shellJobOutputEmpty")}</span>
        ) : (
          <>
            {state.truncated && (
              <div className="mb-1 text-muted">
                … {t("shellJobOutputTruncated", { count: state.lines.length })}
              </div>
            )}
            {state.lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap">
                {line || "\u00A0"}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function JobRow({
  job,
  now,
  ownSession,
  stopping,
  confirmStop,
  outputOpen,
  onOpenSession,
  onRequestStop,
  onConfirmStop,
  onToggleOutput,
}: {
  job: ShellJobSummary;
  now: number;
  ownSession: boolean;
  stopping: boolean;
  confirmStop: boolean;
  outputOpen: boolean;
  onOpenSession: (job: ShellJobSummary) => void;
  onRequestStop: (job: ShellJobSummary) => void;
  onConfirmStop: (job: ShellJobSummary) => void;
  onToggleOutput: (job: ShellJobSummary) => void;
}) {
  const t = useT();
  const running = job.status === "running";
  const duration =
    job.startedAt === undefined
      ? undefined
      : formatJobDuration(job.startedAt, running ? now : (job.finishedAt ?? now));
  const label = job.title ?? job.command;
  return (
    <div className="rounded-md px-1.5 py-1.5 hover:bg-surface-overlay/50">
      <div className="flex items-center gap-2 text-xs">
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
          {!ownSession && (
            <span
              className="shrink-0 rounded bg-surface-overlay px-1 text-[10px] leading-4 text-muted"
              title={job.cwd}
            >
              {cwdBadge(job.cwd)}
            </span>
          )}
          {duration && <span className="shrink-0 tabular-nums text-muted">{duration}</span>}
        </button>
        <button
          type="button"
          className={`flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-overlay hover:text-foreground ${
            outputOpen ? "bg-surface-overlay text-foreground" : "text-muted"
          }`}
          title={t("shellJobOutput")}
          aria-label={t("shellJobOutput")}
          aria-pressed={outputOpen}
          onClick={() => onToggleOutput(job)}
        >
          <Terminal size={12} />
        </button>
        {running && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-surface-overlay hover:text-danger disabled:opacity-40"
            disabled={stopping}
            onClick={() => (confirmStop ? onConfirmStop(job) : onRequestStop(job))}
          >
            <Square size={10} />
            <span>{confirmStop ? t("shellJobStopConfirm") : t("shellJobStop")}</span>
          </button>
        )}
      </div>
      {outputOpen && <JobOutput job={job} />}
    </div>
  );
}

export function ShellJobsBar() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const session = useAppStore((s) => s.session);
  const jobs = useAppStore((s) => s.shellJobs);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [open, setOpen] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [outputJobId, setOutputJobId] = useState<string | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStatusRef = useRef<Map<string, ShellJobStatus>>(new Map());
  const currentSessionId = session?.sessionId ?? null;

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

  // A job we saw running that has now failed deserves an error notification.
  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const job of jobs) {
      if (prev.get(job.id) === "running" && job.status === "failed") {
        pushNotification(
          t("shellJobFailedNotification", { title: job.title ?? job.command }),
          "error",
        );
      }
    }
    prev.clear();
    for (const job of jobs) prev.set(job.id, job.status);
  }, [jobs, pushNotification, t]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  // Close the popover on outside pointer-down and on Escape (TodoPopover
  // uses the same lightweight no-overlay behavior).
  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pillRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Float the popover above the pill, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const pill = pillRef.current;
      if (!pill) return;
      const rect = pill.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const maxWidth = Math.min(480, Math.max(1, window.innerWidth - margin * 2));
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - maxWidth - margin),
      );
      const availableHeight = Math.max(1, rect.top - gap - margin);
      setPanelStyle({
        left,
        bottom: Math.max(margin, window.innerHeight - rect.top + gap),
        maxWidth,
        maxHeight: Math.min(384, availableHeight),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const running = jobs.filter((job) => job.status === "running");
  const wallNow = Date.now();
  // Grace window: finished jobs stay visible briefly with their final status.
  const recentByWall = jobs.filter(
    (job) =>
      job.status !== "running" &&
      job.finishedAt !== undefined &&
      job.finishedAt > 0 &&
      job.finishedAt <= wallNow &&
      wallNow - job.finishedAt < RETAIN_FINISHED_MS,
  );
  const now = useNowTicker(running.length > 0 || recentByWall.length > 0);
  const recent = recentByWall.filter(
    (job) => job.finishedAt !== undefined && now - job.finishedAt < RETAIN_FINISHED_MS,
  );
  const visible = [...running, ...recent];
  // Close the popover once nothing is left to show, so a future job starts
  // from the compact pill again.
  useEffect(() => {
    if (open && visible.length === 0) setOpen(false);
  }, [open, visible.length]);
  if (visible.length === 0) return null;

  const openSession = async (job: ShellJobSummary) => {
    const outcome = await openSessionAcrossWorkspaces(
      { cwd: job.cwd, sessionId: job.sessionId },
      {
        resolveSessionPath: async (sessionId) => {
          const current = useAppStore.getState();
          if (!current.host || !current.workspace) return null;
          const response = await hostClient.request(
            "session.list",
            workspaceContext(current.host, current.workspace),
            null,
            30_000,
          );
          if (!response.ok) return null;
          const item = response.result.items.find((entry) => entry.sessionId === sessionId);
          return item ? { sessionPath: item.sessionPath, archived: item.archived } : null;
        },
      },
    );
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
        pushNotification(`${t("shellJobStopFailed")}: ${res.error.message}`, "error");
        return;
      }
      // pi-shelljob owns status settlement and sends the sole Agent notification
      // through its triggerTurn notifier; do not inject a duplicate prompt here.
    } finally {
      setStoppingId(null);
    }
  };

  const toggleOutput = (job: ShellJobSummary) => {
    setOutputJobId((current) => (current === job.id ? null : job.id));
  };

  const bySession = (a: ShellJobSummary, b: ShellJobSummary) =>
    (a.sessionId === currentSessionId ? 0 : 1) - (b.sessionId === currentSessionId ? 0 : 1) ||
    b.createdAt - a.createdAt;
  const own = visible.filter((job) => job.sessionId === currentSessionId).sort(bySession);
  const others = visible.filter((job) => job.sessionId !== currentSessionId).sort(bySession);
  const failedRecent = recent.filter((job) => job.status === "failed");
  const headline = running[0]?.title ?? running[0]?.command;
  const title = t("shellJobsTitle", { count: running.length });

  const jobRows = (
    <>
      {own.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          ownSession
          stopping={stoppingId === job.id}
          confirmStop={confirmStopId === job.id}
          outputOpen={outputJobId === job.id}
          onOpenSession={(target) => void openSession(target)}
          onRequestStop={requestStop}
          onConfirmStop={(target) => void confirmStop(target)}
          onToggleOutput={toggleOutput}
        />
      ))}
      {others.length > 0 && (
        <div className="px-1.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          {t("shellJobsOtherSessions")}
        </div>
      )}
      {others.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          ownSession={false}
          stopping={stoppingId === job.id}
          confirmStop={confirmStopId === job.id}
          outputOpen={outputJobId === job.id}
          onOpenSession={(target) => void openSession(target)}
          onRequestStop={requestStop}
          onConfirmStop={(target) => void confirmStop(target)}
          onToggleOutput={toggleOutput}
        />
      ))}
    </>
  );

  const panel = open ? (
    <section
      ref={panelRef}
      id={panelId}
      className="theme-floating-surface fixed z-50 flex w-max min-w-80 max-w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
      style={panelStyle ?? { visibility: "hidden", left: 0, bottom: 0 }}
      aria-label={title}
      data-testid="shell-jobs-panel"
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        {running.length > 0 ? (
          <Loader2 size={15} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
        ) : (
          <span
            className={`size-2 shrink-0 rounded-full ${STATUS_CLASS[recent[0]?.status ?? "unknown"]}`}
            title={statusLabel(t, recent[0]?.status ?? "unknown")}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        {failedRecent.length > 0 && (
          <span className="shrink-0 text-danger">
            {t("shellJobsFailedSuffix", { count: failedRecent.length })}
          </span>
        )}
      </div>
      <div className="scrollbar-subtle min-h-0 overflow-y-auto p-1.5">{jobRows}</div>
    </section>
  ) : null;

  // The pill is the only persistent UI; the job list lives in the popover.
  return (
    <div
      className="conversation-content-width mx-auto mb-1.5 flex w-full justify-start"
      data-testid="shell-jobs-bar"
    >
      <button
        ref={pillRef}
        type="button"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs text-muted hover:bg-surface-overlay hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={title}
        title={title}
        data-testid="shell-jobs-toggle"
      >
        {running.length > 0 ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        ) : (
          <span
            className={`size-2 shrink-0 rounded-full ${STATUS_CLASS[recent[0]?.status ?? "unknown"]}`}
            title={statusLabel(t, recent[0]?.status ?? "unknown")}
          />
        )}
        <span className="shrink-0 rounded-full bg-accent/15 px-1.5 font-medium text-accent">
          {running.length}
        </span>
        {failedRecent.length > 0 && (
          <span className="shrink-0 text-danger">
            {t("shellJobsFailedSuffix", { count: failedRecent.length })}
          </span>
        )}
        {headline && <span className="min-w-0 max-w-56 truncate">{headline}</span>}
        {running.length > 1 && <span className="shrink-0 text-muted">+{running.length - 1}</span>}
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {typeof document === "undefined" || !panelStyle || !panel
        ? null
        : createPortal(panel, document.body)}
    </div>
  );
}
