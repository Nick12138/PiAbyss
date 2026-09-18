import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowRight,
  CalendarClock,
  ChevronRight,
  Folder,
  Hourglass,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type {
  ScheduleAgentSessionSummary,
  ScheduleHealth,
  ScheduleJob,
  ScheduleRunSummary,
} from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { setSidebarPref, sidebarPref } from "../../lib/sidebar-prefs";

import { ScheduleJobDialog } from "./ScheduleJobDialog";
import { ScheduleRuns } from "./ScheduleRuns";
import { startScheduleAgent, reopenScheduleAgent } from "./schedule-agent-flow";
import { listHandledAgentSessions, markAgentSessionHandled } from "./schedule-agent-store";
import {
  SCHEDULE_STATUS_LABEL,
  formatCountdown,
  formatDateTime,
  formatIntervalEvery,
  triggerSummary,
} from "./schedule-model";

const LIST_TIMEOUT_MS = 15_000;
const RUN_NOW_TIMEOUT_MS = 31 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;
const RUNS_LIMIT = 50;

type StatusState = {
  available: boolean;
  health: ScheduleHealth | null;
  error: string | null;
};

/** 全屏「周期计划」页：左侧任务列表，右侧详情 + 执行历史。 */
export function SchedulePage() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const setPage = useAppStore((s) => s.setPage);
  const [status, setStatus] = useState<StatusState | null>(null);
  const [jobs, setJobs] = useState<ScheduleJob[]>([]);
  const [activeJobIds, setActiveJobIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; job: ScheduleJob } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleJob | null>(null);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestIdRef = useRef(0);
  const runsRequestIdRef = useRef(0);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );

  const refreshStatusAndJobs = useCallback(async () => {
    if (!host) return;
    const request = ++requestIdRef.current;
    try {
      const statusResponse = await hostClient.request(
        "schedule.status",
        hostContext(host),
        null,
        10_000,
      );
      if (request !== requestIdRef.current) return;
      if (statusResponse.ok) {
        setStatus(statusResponse.result);
      } else {
        setStatus({ available: false, health: null, error: statusResponse.error?.message ?? null });
      }
      if (statusResponse.ok && statusResponse.result.available) {
        const jobsResponse = await hostClient.request(
          "schedule.listJobs",
          hostContext(host),
          null,
          LIST_TIMEOUT_MS,
        );
        if (request !== requestIdRef.current) return;
        if (jobsResponse.ok) {
          setJobs(jobsResponse.result.jobs);
          setActiveJobIds(jobsResponse.result.activeJobIds);
          setLoadError(null);
        } else {
          setLoadError(jobsResponse.error?.message ?? null);
        }
      } else {
        setJobs([]);
        setActiveJobIds([]);
      }
    } catch (error) {
      if (request === requestIdRef.current) {
        setLoadError(error instanceof Error ? error.message : null);
      }
    } finally {
      if (request === requestIdRef.current) setLoading(false);
    }
  }, [host]);

  const refreshRuns = useCallback(async () => {
    if (!host || !selectedJobId) return;
    const request = ++runsRequestIdRef.current;
    setRunsLoading(true);
    try {
      const response = await hostClient.request(
        "schedule.listRuns",
        hostContext(host),
        { jobId: selectedJobId, limit: RUNS_LIMIT },
        LIST_TIMEOUT_MS,
      );
      if (request !== runsRequestIdRef.current) return;
      if (response.ok) setRuns(response.result.runs);
    } catch {
      // keep the previous runs on transient failures
    } finally {
      if (request === runsRequestIdRef.current) setRunsLoading(false);
    }
  }, [host, selectedJobId]);

  // Unfinished smart-creation sessions, enumerated by the Host from the
  // agent-sessions directory; sessions the user already handled (confirmed or
  // dismissed) are filtered out here.
  const [agentSessions, setAgentSessions] = useState<ScheduleAgentSessionSummary[]>([]);

  const refreshAgentSessions = useCallback(async () => {
    if (!host) return;
    try {
      const response = await hostClient.request(
        "schedule.agentList",
        hostContext(host),
        null,
        LIST_TIMEOUT_MS,
      );
      const handled = new Set(listHandledAgentSessions());
      if (response.ok) {
        setAgentSessions(
          response.result.sessions.filter((session) => !handled.has(session.sessionPath)),
        );
      }
    } catch {
      /* transient */
    }
  }, [host]);

  useEffect(() => {
    void refreshStatusAndJobs();
    void refreshAgentSessions();
  }, [refreshStatusAndJobs, refreshAgentSessions]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshStatusAndJobs();
      void refreshRuns();
      void refreshAgentSessions();
      setNow(Date.now());
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshStatusAndJobs, refreshRuns, refreshAgentSessions]);

  useEffect(() => {
    setRuns([]);
    void refreshRuns();
  }, [refreshRuns]);

  async function toggleJob(job: ScheduleJob, enabled: boolean) {
    if (!host) return;
    try {
      const response = await hostClient.request(
        "schedule.setJobEnabled",
        hostContext(host),
        { id: job.id, enabled },
        LIST_TIMEOUT_MS,
      );
      if (response.ok) {
        setJobs((current) =>
          current.map((item) => (item.id === job.id ? response.result.job : item)),
        );
      } else if (response.error) {
        setLoadError(response.error.message);
      }
    } catch {
      /* transient */
    }
  }

  async function runNow(job: ScheduleJob) {
    if (!host || runningJobId) return;
    setRunningJobId(job.id);
    try {
      const response = await hostClient.request(
        "schedule.runJobNow",
        hostContext(host),
        { id: job.id },
        RUN_NOW_TIMEOUT_MS,
      );
      if (!response.ok && response.error) {
        setLoadError(response.error.message);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : null);
    } finally {
      setRunningJobId(null);
      void refreshStatusAndJobs();
      void refreshRuns();
    }
  }

  async function confirmDelete() {
    if (!host || !deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const response = await hostClient.request(
        "schedule.deleteJob",
        hostContext(host),
        { id: target.id },
        LIST_TIMEOUT_MS,
      );
      if (response.ok) {
        if (selectedJobId === target.id) setSelectedJobId(null);
        void refreshStatusAndJobs();
      } else if (response.error) {
        setLoadError(response.error.message);
      }
    } catch {
      /* transient */
    }
  }

  const activeCount = activeJobIds.length;

  function handleReopenPending(entry: ScheduleAgentSessionSummary) {
    const result = reopenScheduleAgent(entry);
    if (result.ok) setPage("schedule-agent");
    else setLoadError(result.error);
  }

  function handleRemovePending(entry: ScheduleAgentSessionSummary) {
    markAgentSessionHandled(entry.sessionPath);
    setAgentSessions((current) =>
      current.filter((session) => session.sessionPath !== entry.sessionPath),
    );
  }

  const [workspaceFilter, setWorkspaceFilter] = useState<string>("__all__");
  const [tagFilter, setTagFilter] = useState<string>("__all__");

  // Filter options derive from the loaded plans; the plan list is global
  // (all workspaces) by default.
  const workspaceOptions = useMemo(
    () => Array.from(new Set(jobs.map((job) => job.cwd))).sort(),
    [jobs],
  );
  const tagOptions = useMemo(
    () => Array.from(new Set(jobs.flatMap((job) => job.tags))).sort(),
    [jobs],
  );
  const filteredJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          (workspaceFilter === "__all__" || job.cwd === workspaceFilter) &&
          (tagFilter === "__all__" || job.tags.includes(tagFilter)),
      ),
    [jobs, workspaceFilter, tagFilter],
  );

  // Two buckets the plan list splits into. A plan is "inactive" once it can no
  // longer fire on its own: the user disabled it, or a one-shot already ran
  // (the plugin terminates it with `terminated: "once"` after the first run).
  // maxRuns/missed terminations stay active — the plugin only sets those next
  // to a disabled job, which the `!job.enabled` branch already catches.
  const activeJobs = useMemo(
    () => filteredJobs.filter((job) => job.enabled && job.terminated !== "once"),
    [filteredJobs],
  );
  const expiredJobs = useMemo(
    () => filteredJobs.filter((job) => !job.enabled || job.terminated === "once"),
    [filteredJobs],
  );

  // Per-section collapse state, remembered across restarts.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => ({
    pending: sidebarPref("piabyss.schedule.pendingCollapsed"),
    active: sidebarPref("piabyss.schedule.activeCollapsed"),
    expired: sidebarPref("piabyss.schedule.expiredCollapsed"),
  }));
  const toggleSection = useCallback((id: string) => {
    setCollapsedSections((current) => {
      const next = { ...current, [id]: !current[id] };
      setSidebarPref(`piabyss.schedule.${id}Collapsed`, next[id]);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col" data-schedule-page>
      {/* Toolbar — three zones: status | filters | actions. */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusPill status={status} />
          {status?.available && status.health && activeCount > 0 && (
            <span className="shrink-0 text-xs text-muted tabular-nums">
              {t("scheduleActiveJobs", { count: activeCount })}
            </span>
          )}
        </div>

        {status?.available && jobs.length > 0 && (
          <div className="flex min-w-0 items-center gap-2">
            <Select
              value={workspaceFilter}
              onChange={setWorkspaceFilter}
              ariaLabel={t("scheduleFilterWorkspace")}
              triggerClassName="w-40"
              options={[
                { value: "__all__", label: t("scheduleFilterAllWorkspaces") },
                ...workspaceOptions.map((cwd) => ({
                  value: cwd,
                  label: workspaceFilterLabel(cwd),
                })),
              ]}
            />
            {tagOptions.length > 0 && (
              <Select
                value={tagFilter}
                onChange={setTagFilter}
                ariaLabel={t("scheduleFilterTag")}
                triggerClassName="w-32"
                options={[
                  { value: "__all__", label: t("scheduleFilterAllTags") },
                  ...tagOptions.map((tag) => ({ value: tag, label: tag })),
                ]}
              />
            )}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
            title={t("scheduleRefresh")}
            aria-label={t("scheduleRefresh")}
            onClick={() => {
              void refreshStatusAndJobs();
              void refreshRuns();
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!status?.available}
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus size={14} />
            {t("scheduleNewJob")}
          </button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 className="animate-spin" size={18} />
        </div>
      ) : !status?.available ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <CalendarClock size={28} className="text-muted" />
          <p className="text-sm font-medium">{t("scheduleOfflineTitle")}</p>
          <p className="max-w-md text-xs text-muted">{status?.error ?? t("scheduleOfflineBody")}</p>
          <p className="max-w-md text-xs text-muted">{t("scheduleOfflineHint")}</p>
        </div>
      ) : jobs.length === 0 && agentSessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <CalendarClock size={28} className="text-muted" />
          <p className="text-sm font-medium">{t("scheduleEmptyTitle")}</p>
          <p className="max-w-md text-xs text-muted">{t("scheduleEmptyBody")}</p>
          <button
            type="button"
            className={`mt-2 ${primaryButton}`}
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus size={14} />
            {t("scheduleNewJob")}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Job list */}
          <div className="scrollbar-subtle flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface-inset/40 p-3">
            <section className="flex flex-col gap-2">
              <SectionHeading
                icon={Hourglass}
                title={t("scheduleAgentPendingTitle")}
                count={agentSessions.length}
                collapsed={collapsedSections.pending === true}
                onToggle={() => toggleSection("pending")}
              />
              {agentSessions.length === 0 ? (
                <EmptyHint text={t("scheduleSectionPendingEmpty")} />
              ) : (
                <CollapsibleRegion open={collapsedSections.pending !== true}>
                  <div className="flex flex-col gap-2">
                    {agentSessions.map((entry) => (
                      <PendingCard
                        key={entry.sessionId}
                        entry={entry}
                        onReopen={() => handleReopenPending(entry)}
                        onRemove={() => handleRemovePending(entry)}
                      />
                    ))}
                  </div>
                </CollapsibleRegion>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <SectionHeading
                icon={ListChecks}
                title={t("scheduleSectionActive")}
                count={activeJobs.length}
                collapsed={collapsedSections.active === true}
                onToggle={() => toggleSection("active")}
              />
              {activeJobs.length === 0 ? (
                <EmptyHint
                  text={
                    jobs.length === 0
                      ? t("scheduleEmptyTitle")
                      : filteredJobs.length === 0
                        ? t("scheduleFilterNoMatch")
                        : t("scheduleSectionActiveEmpty")
                  }
                />
              ) : (
                <CollapsibleRegion open={collapsedSections.active !== true}>
                  <div className="flex flex-col gap-2">
                    {activeJobs.map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        running={activeJobIds.includes(job.id) || runningJobId === job.id}
                        selected={job.id === selectedJobId}
                        now={now}
                        onSelect={() => setSelectedJobId(job.id)}
                        onToggle={(enabled) => void toggleJob(job, enabled)}
                      />
                    ))}
                  </div>
                </CollapsibleRegion>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <SectionHeading
                icon={Archive}
                title={t("scheduleSectionExpired")}
                count={expiredJobs.length}
                collapsed={collapsedSections.expired === true}
                onToggle={() => toggleSection("expired")}
              />
              {expiredJobs.length === 0 ? (
                <EmptyHint text={t("scheduleSectionExpiredEmpty")} />
              ) : (
                <CollapsibleRegion open={collapsedSections.expired !== true}>
                  <div className="flex flex-col gap-2">
                    {expiredJobs.map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        running={activeJobIds.includes(job.id) || runningJobId === job.id}
                        selected={job.id === selectedJobId}
                        now={now}
                        onSelect={() => setSelectedJobId(job.id)}
                        onToggle={(enabled) => void toggleJob(job, enabled)}
                      />
                    ))}
                  </div>
                </CollapsibleRegion>
              )}
            </section>
          </div>

          {/* Detail */}
          <div className="scrollbar-subtle min-w-0 flex-1 overflow-y-auto">
            {selectedJob ? (
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-semibold">{selectedJob.name}</h2>
                    <p
                      className="mt-1 truncate font-mono text-xs text-muted"
                      title={selectedJob.cwd}
                    >
                      {selectedJob.cwd}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={runningJobId !== null}
                      onClick={() => void runNow(selectedJob)}
                    >
                      {runningJobId === selectedJob.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Play size={13} />
                      )}
                      {runningJobId === selectedJob.id ? t("scheduleRunning") : t("scheduleRunNow")}
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setDialog({ mode: "edit", job: selectedJob })}
                    >
                      <Pencil size={13} />
                      {t("scheduleEdit")}
                    </button>
                    <button
                      type="button"
                      className={`${secondaryButton} text-danger`}
                      onClick={() => setDeleteTarget(selectedJob)}
                    >
                      <Trash2 size={13} />
                      {t("scheduleDelete")}
                    </button>
                  </div>
                </div>

                {loadError && (
                  <p className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger">
                    {loadError}
                  </p>
                )}

                <JobDetail job={selectedJob} />

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-medium">{t("scheduleRunsTitle")}</h3>
                    {runsLoading && <Loader2 size={12} className="animate-spin text-muted" />}
                  </div>
                  <ScheduleRuns
                    runs={runs}
                    onRunsChanged={() => {
                      void refreshRuns();
                      void refreshStatusAndJobs();
                    }}
                    onError={setLoadError}
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                {t("scheduleSelectJob")}
              </div>
            )}
          </div>
        </div>
      )}

      {dialog && (
        <ScheduleJobDialog
          job={dialog.mode === "edit" ? dialog.job : null}
          onClose={() => setDialog(null)}
          onSaved={(job) => {
            setDialog(null);
            setSelectedJobId(job.id);
            void refreshStatusAndJobs();
          }}
          onStartSmart={async (cwd, requirement) => {
            const result = await startScheduleAgent(requirement, cwd);
            if (result.ok) {
              setDialog(null);
              setPage("schedule-agent");
              return null;
            }
            return result.error;
          }}
        />
      )}

      {deleteTarget && (
        <Dialog
          title={t("scheduleDeleteTitle")}
          confirmLabel={t("scheduleDelete")}
          tone="danger"
          icon={Trash2}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        >
          <p className="text-sm">{t("scheduleDeleteBody", { name: deleteTarget.name })}</p>
        </Dialog>
      )}
    </div>
  );
}

/** Short label for a workspace path: its base directory name. */
function workspaceFilterLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.length > 0 ? base : cwd;
}

/** Left-column group heading: a collapse toggle, an icon, a label and a count. */
function SectionHeading({
  icon: Icon,
  title,
  count,
  collapsed,
  onToggle,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left transition-colors hover:text-foreground"
    >
      <ChevronRight
        size={12}
        className={`shrink-0 text-muted transition-transform duration-150 ${
          collapsed ? "" : "rotate-90"
        }`}
        aria-hidden="true"
      />
      <Icon size={12} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</span>
      <span className="rounded bg-surface-overlay px-1 text-[10px] tabular-nums text-muted">
        {count}
      </span>
    </button>
  );
}

/** Muted one-liner used for the per-section empty states. */
function EmptyHint({ text }: { text: string }) {
  return <p className="px-0.5 py-1 text-xs leading-5 text-muted">{text}</p>;
}

function StatusPill({ status }: { status: StatusState | null }) {
  const t = useT();
  const online = status?.available === true;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs">
      <span
        className={`size-1.5 rounded-full ${
          status === null ? "bg-muted" : online ? "bg-success" : "bg-danger"
        }`}
      />
      {status === null
        ? t("scheduleStatusUnknown")
        : online
          ? t("scheduleStatusOnline")
          : t("scheduleStatusOffline")}
    </span>
  );
}

/** Backlog entry for an unfinished smart-creation session. */
function PendingCard({
  entry,
  onReopen,
  onRemove,
}: {
  entry: ScheduleAgentSessionSummary;
  onReopen: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-surface/60 py-2 pl-3 pr-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.title}>
        {entry.title}
      </span>
      {/* Actions sit on the title row so the card stays one line tall. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-accent transition-colors hover:bg-accent/15"
          title={t("scheduleAgentPendingReopen")}
          onClick={onReopen}
        >
          <ArrowRight size={12} />
          {t("scheduleAgentPendingReopen")}
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/15 hover:text-danger"
          title={t("scheduleAgentPendingRemove")}
          aria-label={t("scheduleAgentPendingRemove")}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

/** Three stacked rows per plan: identity, trigger, metadata. */
function JobCard({
  job,
  running,
  selected,
  now,
  onSelect,
  onToggle,
}: {
  job: ScheduleJob;
  running: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useT();
  const summary = triggerSummary(job.trigger);
  const countdown = job.enabled ? formatCountdown(job.nextRunAt, now) : null;
  const statusLabel = job.lastStatus ? t(SCHEDULE_STATUS_LABEL[job.lastStatus]) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      data-selected={selected ? "true" : "false"}
      className={`relative cursor-pointer rounded-lg border py-2.5 pl-3 pr-2.5 transition-colors ${
        selected
          ? "border-accent/60 bg-accent/10"
          : "border-border bg-surface/60 hover:bg-surface-overlay"
      }`}
    >
      {/* Selection marker: a 2px accent bar hugging the card's left edge. */}
      {selected && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" aria-hidden />
      )}

      {/* Row 1: name + enable switch (no leading glyph). */}
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            running ? "animate-pulse bg-accent" : job.enabled ? "bg-success" : "bg-border"
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
          {job.name || t("scheduleUntitledJob")}
        </span>
        <div onClick={(event) => event.stopPropagation()}>
          <Switch checked={job.enabled} onChange={onToggle} label={t("scheduleFormEnabled")} />
        </div>
      </div>

      {/* Row 2: trigger summary — the most useful line after the name. */}
      <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-xs text-accent">
        <span className="truncate">
          {summary.kind === "manual"
            ? t("scheduleTriggerManual")
            : summary.kind === "interval"
              ? t("scheduleEveryValue", { value: formatIntervalEvery(summary.value ?? "") })
              : summary.value}
        </span>
        {countdown && countdown !== "due" && (
          <span className="shrink-0 text-muted">
            · {t("scheduleCountdownIn", { value: countdown })}
          </span>
        )}
        {countdown === "due" && (
          <span className="shrink-0 text-muted">· {t("scheduleDueNow")}</span>
        )}
      </div>

      {/* Row 3: workspace + last status. */}
      <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-xs text-muted">
        <Folder size={11} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title={job.cwd}>
          {workspaceFilterLabel(job.cwd)}
        </span>
        {job.terminated && (
          <span className="shrink-0 text-warning">· {t("scheduleTerminated")}</span>
        )}
        {statusLabel && (
          <span
            className={`shrink-0 ${
              job.lastStatus === "ok"
                ? "text-success"
                : job.lastStatus === "running"
                  ? "text-accent"
                  : "text-danger"
            }`}
          >
            · {statusLabel}
          </span>
        )}
      </div>
    </div>
  );
}

const PERMISSION_LABEL: Record<string, MessageKey> = {
  read_only: "schedulePermissionReadOnly",
  write: "schedulePermissionWrite",
  full: "schedulePermissionFull",
};

/** One row of the detail definition list. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <dt className="w-24 shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px] leading-5">{children}</dd>
    </div>
  );
}

/** Grouped definition list: one card per semantic cluster. */
function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface/60 px-3.5 py-2.5">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
      <dl className="divide-y divide-border-subtle">{children}</dl>
    </section>
  );
}

function JobDetail({ job }: { job: ScheduleJob }) {
  const t = useT();
  const summary = triggerSummary(job.trigger);
  const isCommand = Boolean(job.command);
  return (
    <div className="flex flex-col gap-3">
      {/* Payload: the plan prompt or the shell command. */}
      <section className="rounded-lg border border-border bg-surface/60 p-3.5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          {isCommand ? <Terminal size={12} /> : <ListChecks size={12} />}
          {isCommand ? t("scheduleFormCommand") : t("scheduleFormPrompt")}
        </div>
        {isCommand ? (
          <code className="block break-all font-mono text-xs leading-5">{job.command}</code>
        ) : (
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-5">
            {job.prompt}
          </pre>
        )}
      </section>

      {/* Trigger */}
      <DetailGroup title={t("scheduleDetailGroupTrigger")}>
        <DetailRow label={t("scheduleFormTrigger")}>
          {summary.kind === "manual"
            ? t("scheduleTriggerManual")
            : summary.kind === "interval"
              ? `${t("scheduleTriggerInterval")} · ${formatIntervalEvery(summary.value ?? "")}`
              : summary.kind === "cron"
                ? `${t("scheduleTriggerCron")} · ${summary.value}`
                : formatDateTime(summary.value)}
        </DetailRow>
        <DetailRow label={t("scheduleDetailNextRun")}>{formatDateTime(job.nextRunAt)}</DetailRow>
        <DetailRow label={t("scheduleFormMissedWindow")}>
          {t(`scheduleMissedWindow${job.missedWindow === "catch_up_one" ? "CatchUp" : "Skip"}`)}
        </DetailRow>
      </DetailGroup>

      {/* Execution */}
      <DetailGroup title={t("scheduleDetailGroupExecution")}>
        {!isCommand && (
          <>
            <DetailRow label={t("scheduleFormPermission")}>
              {t(PERMISSION_LABEL[job.permission])}
            </DetailRow>
            <DetailRow label={t("scheduleFormModel")}>
              {job.model
                ? `${job.model.provider} · ${job.model.id}`
                : t("scheduleModelDefaultPlain")}
            </DetailRow>
          </>
        )}
        <DetailRow label={t("scheduleDetailLastRun")}>
          {formatDateTime(job.lastRunAt)}
          {job.lastStatus ? ` · ${t(SCHEDULE_STATUS_LABEL[job.lastStatus])}` : ""}
        </DetailRow>
        <DetailRow label={t("scheduleDetailRunCount")}>
          {job.runCount}
          {job.maxRuns !== null ? ` / ${job.maxRuns}` : ""}
        </DetailRow>
        <DetailRow label={t("scheduleFormTimeoutMinutes")}>
          {Math.round(job.timeoutMs / 60_000)} min
        </DetailRow>
      </DetailGroup>

      {(job.tags.length > 0 || job.terminated) && (
        <DetailGroup title={t("scheduleDetailGroupMeta")}>
          {job.tags.length > 0 && (
            <DetailRow label={t("scheduleFormTags")}>
              <span className="flex flex-wrap gap-1">
                {job.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-surface-overlay px-1.5 py-0.5 text-xs text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            </DetailRow>
          )}
          {job.terminated && (
            <DetailRow label={t("scheduleTerminated")}>
              <span className="text-warning">{job.terminated}</span>
            </DetailRow>
          )}
        </DetailGroup>
      )}
    </div>
  );
}
