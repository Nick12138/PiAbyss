/**
 * 随行面板 ·「周期计划」页签（三块横排的第二块）。
 *
 * 只读 + 开关：列表直接摊开（原来折叠态那一行说的「活跃数 + 下次触发倒计时」，现在
 * 活跃数在页签徽章上、倒计时在这一块顶上的工具条里）。**创建与修改都在对话里跟小精灵
 * 谈**——工具条尾部的「＋」只把引导语塞进小精灵的输入框，用户补完描述后自己发出去。
 * 所以这里不引入 `ScheduleJobDialog`，也不碰 schedule 的智能创建会话（那是独立页面的事）。
 *
 * 数据与周期计划页同源（`schedule.status` / `schedule.listJobs` /
 * `schedule.setJobEnabled`），展示辅助复用 `schedule-model` 的纯函数。插件门在
 * `PixieSidePanel`（连页签一起消失），这里不再自判。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { ScheduleJob } from "@piabyss/protocol";
import { Switch } from "../../components/Switch";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { formatCountdown, formatIntervalEvery, triggerSummary } from "../schedule/schedule-model";
import { PixiePanelBody } from "./PixiePanelTabs";

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

export function PixieScheduleSection({
  active,
  onCount,
}: {
  active: boolean;
  /** 活跃计划数报给随行面板的页签徽章（插件门也在那里）。 */
  onCount: (count: number) => void;
}) {
  const t = useT();
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
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
    if (!hostInstanceId) return;
    void refresh();
  }, [hostInstanceId, refresh]);

  // 30s 滴答同时喂倒计时与列表：列表只在**这一页签可见时**才刷 RPC，隐藏时只重算倒计时
  // （页签上的计数是活跃数，不跟着分钟走）。
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (active) void refresh();
    }, NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const ordered = useMemo(() => [...(jobs ?? [])].sort(jobOrder), [jobs]);
  const activeCount = useMemo(() => ordered.filter(isActive).length, [ordered]);
  useEffect(() => {
    onCount(activeCount);
  }, [activeCount, onCount]);
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

  const countdown = nextRunAt ? formatCountdown(nextRunAt, now) : null;
  const hint = !available
    ? ""
    : countdown === null
      ? ""
      : countdown === "due"
        ? t("scheduleDueNow")
        : t("pixieScheduleNextHint", { value: countdown });

  return (
    <PixiePanelBody
      tab="schedule"
      active={active}
      hint={hint}
      action={
        <button
          type="button"
          data-testid="pixie-schedule-new"
          title={t("pixieScheduleNew")}
          aria-label={t("pixieScheduleNew")}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none"
          onClick={() => {
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
    </PixiePanelBody>
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
