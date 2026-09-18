import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Loader2, Play, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";
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
import { Dialog, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";

import { ScheduleJobDialog } from "./ScheduleJobDialog";
import { ScheduleRuns } from "./ScheduleRuns";
import { startScheduleAgent, reopenScheduleAgent } from "./schedule-agent-flow";
import { listHandledAgentSessions, markAgentSessionHandled } from "./schedule-agent-store";
import {
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

  return (
    <div className="flex h-full min-w-0 flex-col" data-schedule-page>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <StatusPill status={status} />
        {status?.available && status.health && (
          <span className="text-xs text-muted">
            {t("scheduleActiveJobs", { count: activeCount })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {status?.available && jobs.length > 0 && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted">{t("scheduleFilterWorkspace")}</span>
                <Select
                  value={workspaceFilter}
                  onChange={setWorkspaceFilter}
                  ariaLabel={t("scheduleFilterWorkspace")}
                  options={[
                    { value: "__all__", label: t("scheduleFilterAllWorkspaces") },
                    ...workspaceOptions.map((cwd) => ({
                      value: cwd,
                      label: workspaceFilterLabel(cwd),
                    })),
                  ]}
                />
              </div>
              {tagOptions.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted">{t("scheduleFilterTag")}</span>
                  <Select
                    value={tagFilter}
                    onChange={setTagFilter}
                    ariaLabel={t("scheduleFilterTag")}
                    options={[
                      { value: "__all__", label: t("scheduleFilterAllTags") },
                      ...tagOptions.map((tag) => ({ value: tag, label: tag })),
                    ]}
                  />
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              void refreshStatusAndJobs();
              void refreshRuns();
            }}
          >
            <RefreshCw size={13} />
            {t("scheduleRefresh")}
          </button>
          <button
            type="button"
            className="interface-density-control inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
            className={`mt-1 ${secondaryButton}`}
            onClick={() => setDialog({ mode: "create" })}
          >
            <Plus size={13} />
            {t("scheduleNewJob")}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Job list */}
          <div className="scrollbar-subtle w-80 shrink-0 overflow-y-auto border-r border-border p-2">
            {agentSessions.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 px-1 text-xs font-medium text-muted">
                  {t("scheduleAgentPendingTitle")}
                </div>
                {agentSessions.map((entry) => (
                  <div
                    key={entry.sessionId}
                    className="mb-1 rounded-md border border-dashed border-border px-2.5 py-2"
                  >
                    <div className="truncate text-[13px] font-medium">⏳ {entry.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => void handleReopenPending(entry)}
                      >
                        {t("scheduleAgentPendingReopen")}
                      </button>
                      <button
                        type="button"
                        className="text-danger hover:underline"
                        onClick={() => handleRemovePending(entry)}
                      >
                        {t("scheduleAgentPendingRemove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {jobs.length === 0 && (
              <p className="px-1 py-3 text-xs text-muted">{t("scheduleEmptyTitle")}</p>
            )}
            {filteredJobs.length === 0 && (
              <p className="px-1 py-3 text-xs text-muted">{t("scheduleFilterNoMatch")}</p>
            )}
            {filteredJobs.map((job) => (
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

          {/* Detail */}
          <div className="scrollbar-subtle min-w-0 flex-1 overflow-y-auto p-4">
            {selectedJob ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">{selectedJob.name}</h2>
                    <p className="mt-0.5 text-xs text-muted" title={selectedJob.cwd}>
                      {selectedJob.cwd}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={secondaryButton}
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
                  <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
                    {loadError}
                  </p>
                )}

                <JobDetail job={selectedJob} />

                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <h3 className="text-sm font-medium">{t("scheduleRunsTitle")}</h3>
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
  const trimmed = cwd.replace(/[\/]+$/, "");
  const base = trimmed.split(/[\/]/).pop() ?? trimmed;
  return base.length > 0 ? base : cwd;
}

function StatusPill({ status }: { status: StatusState | null }) {
  const t = useT();
  const online = status?.available === true;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs">
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
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      data-selected={selected ? "true" : "false"}
      className={`mb-1.5 cursor-pointer rounded-md border px-2.5 py-2 transition-colors ${
        selected ? "border-accent bg-accent/10" : "border-border hover:bg-surface-overlay"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            running ? "bg-accent" : job.enabled ? "bg-success" : "bg-border"
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {job.command ? "⚙ " : ""}
          {job.name || t("scheduleUntitledJob")}
        </span>
        <div onClick={(event) => event.stopPropagation()}>
          <Switch checked={job.enabled} onChange={onToggle} label={t("scheduleFormEnabled")} />
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-3.5 text-[11px] text-muted">
        <span title={job.cwd}>📁 {workspaceFilterLabel(job.cwd)}</span>
        <span>
          {summary.kind === "manual"
            ? t("scheduleTriggerManual")
            : summary.kind === "interval"
              ? t("scheduleEveryValue", { value: formatIntervalEvery(summary.value ?? "") })
              : summary.value}
        </span>
        {countdown && countdown !== "due" && (
          <span>· {t("scheduleCountdownIn", { value: countdown })}</span>
        )}
        {countdown === "due" && <span>· {t("scheduleDueNow")}</span>}
        {job.terminated && <span className="text-warning">· {t("scheduleTerminated")}</span>}
        {job.lastStatus && (
          <span
            className={
              job.lastStatus === "ok"
                ? "text-success"
                : job.lastStatus === "running"
                  ? "text-accent"
                  : "text-danger"
            }
          >
            · {job.lastStatus}
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

function JobDetail({ job }: { job: ScheduleJob }) {
  const t = useT();
  const summary = triggerSummary(job.trigger);
  return (
    <div className="rounded-md border border-border p-3 text-xs">
      {job.command ? (
        <div className="mb-2">
          <span className="text-muted">{t("scheduleFormCommand")}: </span>
          <code className="break-all font-mono">{job.command}</code>
        </div>
      ) : (
        <pre className="mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface-overlay p-2 font-sans">
          {job.prompt}
        </pre>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{t("scheduleFormTrigger")}</dt>
        <dd>
          {summary.kind === "manual"
            ? t("scheduleTriggerManual")
            : summary.kind === "interval"
              ? `${t("scheduleTriggerInterval")} · ${formatIntervalEvery(summary.value ?? "")}`
              : summary.kind === "cron"
                ? `${t("scheduleTriggerCron")} · ${summary.value}`
                : formatDateTime(summary.value)}
        </dd>
        {job.command ? null : (
          <>
            <dt className="text-muted">{t("scheduleFormPermission")}</dt>
            <dd>{t(PERMISSION_LABEL[job.permission])}</dd>
            <dt className="text-muted">{t("scheduleFormModel")}</dt>
            <dd>
              {job.model
                ? `${job.model.provider} · ${job.model.id}`
                : t("scheduleModelDefaultPlain")}
            </dd>
          </>
        )}
        <dt className="text-muted">{t("scheduleDetailNextRun")}</dt>
        <dd>{formatDateTime(job.nextRunAt)}</dd>
        <dt className="text-muted">{t("scheduleDetailLastRun")}</dt>
        <dd>
          {formatDateTime(job.lastRunAt)}
          {job.lastStatus ? ` · ${job.lastStatus}` : ""}
        </dd>
        <dt className="text-muted">{t("scheduleDetailRunCount")}</dt>
        <dd>
          {job.runCount}
          {job.maxRuns !== null ? ` / ${job.maxRuns}` : ""}
        </dd>
        <dt className="text-muted">{t("scheduleFormTimeoutMinutes")}</dt>
        <dd>{Math.round(job.timeoutMs / 60_000)} min</dd>
        <dt className="text-muted">{t("scheduleFormMissedWindow")}</dt>
        <dd>
          {t(`scheduleMissedWindow${job.missedWindow === "catch_up_one" ? "CatchUp" : "Skip"}`)}
        </dd>
        {job.tags.length > 0 && (
          <>
            <dt className="text-muted">{t("scheduleFormTags")}</dt>
            <dd>{job.tags.join(", ")}</dd>
          </>
        )}
        {job.terminated && (
          <>
            <dt className="text-muted">{t("scheduleTerminated")}</dt>
            <dd>{job.terminated}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
