/**
 * 随行面板 ·「周期计划」分组（默认折叠）。
 *
 * 只读 + 开关：折叠时那一行就是全部信息（活跃计划数 + 下一次触发倒计时），展开是
 * 已有计划的列表与启用开关。**创建与修改都在对话里跟小精灵谈**——标题行的「＋」
 * 只把引导语塞进小精灵的输入框，用户补完描述后自己发出去。所以这里不引入
 * `ScheduleJobDialog`，也不碰 schedule 的智能创建会话（那是独立页面的事）。
 *
 * 数据与周期计划页同源（`schedule.status` / `schedule.listJobs` /
 * `schedule.setJobEnabled`），展示辅助复用 `schedule-model` 的纯函数。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import type { ScheduleJob } from "@piabyss/protocol";
import { Switch } from "../../components/Switch";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { useSchedulePluginEnabled } from "../schedule/schedule-plugin-gate";
import { formatCountdown, formatIntervalEvery, triggerSummary } from "../schedule/schedule-model";
import { PixiePanelSection, usePanelSection } from "./PixiePanelSection";

const SCHEDULE_EXPANDED_PREF = "piabyss.pixie.scheduleExpanded";
const LIST_TIMEOUT_MS = 15_000;
const NOW_TICK_MS = 30_000;

/** 活跃 = 还能自己触发（用户没停用、一次性任务也没跑过）。 */
function isActive(job: ScheduleJob): boolean {
  return job.enabled && job.terminated !== "once";
}

function jobOrder(a: ScheduleJob, b: ScheduleJob): number {
  const active = Number(isActive(b)) - Number(isActive(a));
  if (active !== 0) return active;
  return (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~");
}

export function PixieScheduleSection() {
  const t = useT();
  const scheduleEnabled = useSchedulePluginEnabled();
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const [open, toggle] = usePanelSection(SCHEDULE_EXPANDED_PREF, false);
  const [jobs, setJobs] = useState<ScheduleJob[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const host = useAppStore.getState().host;
    if (!host) return;
    try {
      const status = await hostClient.request("schedule.status", hostContext(host), null, 10_000);
      const ready = status.ok && status.result.available;
      setAvailable(ready);
      if (!ready) {
        setJobs([]);
        setError(null);
        return;
      }
      const response = await hostClient.request(
        "schedule.listJobs",
        hostContext(host),
        null,
        LIST_TIMEOUT_MS,
      );
      if (response.ok) {
        setJobs(response.result.jobs);
        setError(null);
      } else {
        setError(response.error?.message ?? null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!hostInstanceId || !scheduleEnabled) return;
    void refresh();
  }, [hostInstanceId, scheduleEnabled, refresh]);

  // 倒计时与列表只在展开时刷新：折叠态那行 hint 由 now 每 30s 重算即可。
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (open) void refresh();
    }, NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const ordered = useMemo(() => [...(jobs ?? [])].sort(jobOrder), [jobs]);
  const activeCount = useMemo(() => ordered.filter(isActive).length, [ordered]);
  const nextRunAt = useMemo(() => {
    const upcoming = ordered
      .filter((job) => isActive(job) && job.nextRunAt)
      .map((job) => job.nextRunAt as string)
      .sort();
    return upcoming[0] ?? null;
  }, [ordered]);

  const toggleJob = useCallback(
    async (job: ScheduleJob, enabled: boolean) => {
      const host = useAppStore.getState().host;
      if (!host || busyId) return;
      setBusyId(job.id);
      try {
        const response = await hostClient.request(
          "schedule.setJobEnabled",
          hostContext(host),
          { id: job.id, enabled },
          LIST_TIMEOUT_MS,
        );
        if (response.ok) {
          const updated = response.result.job;
          setJobs((current) =>
            current ? current.map((item) => (item.id === job.id ? updated : item)) : current,
          );
        } else if (response.error) {
          setError(response.error.message);
        }
      } catch {
        /* transient */
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  if (!scheduleEnabled) return null;

  const countdown = nextRunAt ? formatCountdown(nextRunAt, now) : null;
  const hint = !available
    ? ""
    : countdown === null
      ? ""
      : countdown === "due"
        ? t("scheduleDueNow")
        : t("pixieScheduleNextHint", { value: countdown });

  return (
    <PixiePanelSection
      testId="pixie-schedule-section"
      icon={CalendarClock}
      title={t("scheduleTitle")}
      count={activeCount}
      hint={hint}
      open={open}
      onToggle={toggle}
      action={
        <button
          type="button"
          data-testid="pixie-schedule-new"
          title={t("pixieScheduleNew")}
          aria-label={t("pixieScheduleNew")}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
          onClick={() => {
            if (!open) toggle();
            // 计划的创建走对话：只把引导语放进输入框，用户补完再发。
            requestComposerInsert(t("pixieScheduleNewPrompt"));
          }}
        >
          <Plus size={13} />
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {error ? <p className="px-1 text-[11px] text-danger">{error}</p> : null}
        {!available ? (
          <p className="px-1 py-2 text-[11px] leading-5 text-muted">{t("scheduleOfflineTitle")}</p>
        ) : ordered.length === 0 ? (
          <p className="px-1 py-2 text-center text-[11px] text-muted">{t("scheduleEmptyTitle")}</p>
        ) : (
          ordered.map((job) => (
            <ScheduleRow
              key={job.id}
              job={job}
              now={now}
              disabled={busyId !== null}
              onToggle={(enabled) => void toggleJob(job, enabled)}
            />
          ))
        )}
        <p className="px-1 pt-0.5 text-[11px] leading-5 text-muted">{t("pixieScheduleNote")}</p>
      </div>
    </PixiePanelSection>
  );
}

function ScheduleRow({
  job,
  now,
  disabled,
  onToggle,
}: {
  job: ScheduleJob;
  now: number;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useT();
  const active = isActive(job);
  const summary = triggerSummary(job.trigger);
  const countdown = active ? formatCountdown(job.nextRunAt, now) : null;

  const triggerLabel =
    summary.kind === "manual"
      ? t("scheduleTriggerManual")
      : summary.kind === "once"
        ? t("scheduleTriggerOnce")
        : summary.kind === "cron"
          ? (summary.value ?? t("scheduleTriggerCron"))
          : t("scheduleEveryValue", { value: formatIntervalEvery(summary.value ?? "") });

  return (
    <div
      data-testid="pixie-schedule-row"
      className="flex items-start gap-2 rounded-md border border-border p-2"
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${active ? "bg-accent" : "bg-muted/50"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-foreground/90">{job.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-accent">{triggerLabel}</span>
          {countdown ? (
            <span className="text-muted">
              {countdown === "due"
                ? t("scheduleDueNow")
                : t("pixieScheduleNextHint", { value: countdown })}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="truncate">{job.cwd.split(/[\\/]/).pop() || job.cwd}</span>
          {job.terminated ? <span>{t("scheduleTerminated")}</span> : null}
        </div>
      </div>
      <Switch checked={job.enabled} disabled={disabled} label={job.name} onChange={onToggle} />
    </div>
  );
}
