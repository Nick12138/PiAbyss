/**
 * 随行面板 ·「自动化」页签（三块横排的第二块）。
 *
 * 这一栏的职责是**查看、开关、进详情**；列表按「当前活跃 / 已失效」二级页签分桶
 * （与待办 · 速记同一形态，一次只看一桶），口径与独立页严格一致：停用的、或一次性
 * 已经跑过的都算失效。那一行页签同时是这一块的**工具条**——下次触发与 ＋ 都贴在
 * 它右端，不再单开一行。
 * 创建与修改走两条路，都归人管：
 *   - 点 ＋ 开 `AutomationJobDialog`（手动模式直接建；智能模式把引导语放进她的输入框，由用户发送）；
 *   - 对话里的草案卡由用户点「确认」才落库（`PixiePlanCard`），这一栏不负责写。
 * 点行打开详情弹窗（内容 + 执行历史与过程 + 编辑/立即执行/停止）。
 *
 * 数据与自动化页同源（`automation.status` / `automation.listJobs` / `automation.setJobEnabled`），
 * 展示辅助复用 `automation-model` 的纯函数。插件门在 `PixieSidePanel`（连页签一起消失），
 * 这里不再自判。
 *
 * 两处容易漏的接线：`activeJobIds` 决定「正在跑」的呼吸点（列表接口一并返回，别只用
 * `enabled` 猜）；顶栏那颗调度器状态灯原本只有独立页在喂，页签这边也必须喂，
 * 否则用户不打开独立页时它永远是灰的。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { AutomationJob } from "@piabyss/protocol";
import { Switch } from "../../components/Switch";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestComposerInsert } from "../../lib/composer-insert";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import {
  formatCountdown,
  formatIntervalEvery,
  triggerSummary,
} from "../automation/automation-model";
import { AutomationJobDialog } from "../automation/AutomationJobDialog";
import { PixieAutomationDetailDialog } from "./PixieAutomationDetailDialog";
import { PixiePanelBody } from "./PixiePanelTabs";

const LIST_TIMEOUT_MS = 15_000;
const NOW_TICK_MS = 30_000;

/** 活跃 = 还能自己触发（用户没停用、一次性任务也没跑过）。 */
function isActive(job: AutomationJob): boolean {
  return job.enabled && job.terminated !== "once";
}

function jobOrder(a: AutomationJob, b: AutomationJob): number {
  const active = Number(isActive(b)) - Number(isActive(a));
  if (active !== 0) return active;
  return (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~");
}

export function PixieAutomationSection({
  active,
  onCount,
}: {
  active: boolean;
  /** 活跃计划数报给随行面板的页签徽章（插件门也在那里）。 */
  onCount: (count: number) => void;
}) {
  const t = useT();
  const hostInstanceId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const revision = useAppStore((s) => s.automationRevision);
  const [jobs, setJobs] = useState<AutomationJob[] | null>(null);
  const [activeJobIds, setActiveJobIds] = useState<string[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const host = useAppStore.getState().host;
    if (!host) return;
    try {
      const status = await hostClient.request("automation.status", hostContext(host), null, 10_000);
      const ready = status.ok && status.result.available;
      setAvailable(ready);
      if (!ready) {
        setJobs([]);
        setActiveJobIds([]);
        setError(null);
        return;
      }
      const response = await hostClient.request(
        "automation.listJobs",
        hostContext(host),
        null,
        LIST_TIMEOUT_MS,
      );
      if (response.ok) {
        setJobs(response.result.jobs);
        setActiveJobIds(response.result.activeJobIds);
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
  }, [hostInstanceId, revision, refresh]);

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
  // 两桶口径与独立页严格一致：被停用的、以及一次性任务已经跑过的（插件会打
  // `terminated:"once"`）都归「已失效」；`maxRuns`/`missed` 的终止总是伴随停用，
  // 所以不必在这里重复判。
  const activeJobs = useMemo(() => ordered.filter(isActive), [ordered]);
  const expiredJobs = useMemo(() => ordered.filter((job) => !isActive(job)), [ordered]);
  const activeCount = activeJobs.length;
  useEffect(() => {
    onCount(activeCount);
  }, [activeCount, onCount]);
  /** 二级页签：与待办 · 速记同一形态（一次只看一桶），不是可折叠分组。 */
  const [bucket, setBucket] = useState<"active" | "expired">("active");
  const bucketJobs = bucket === "active" ? activeJobs : expiredJobs;
  const nextRunAt = useMemo(() => {
    const upcoming = ordered
      .filter((job) => isActive(job) && job.nextRunAt)
      .map((job) => job.nextRunAt as string)
      .sort();
    return upcoming[0] ?? null;
  }, [ordered]);

  const toggleJob = useCallback(
    async (job: AutomationJob, enabled: boolean) => {
      const host = useAppStore.getState().host;
      if (!host || busyId) return;
      setBusyId(job.id);
      try {
        const response = await hostClient.request(
          "automation.setJobEnabled",
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

  /**
   * 智能模式：**照「待办 · 速记」那条路走**——把引导语连同需求放进小精灵的输入框，
   * 由用户补完、自己按发送。不让程序替用户发一条机器味的长消息进对话：
   * 那既改不了也撤回不了，而计划契约本来就写在 `<pixie-context>` 里，不需要每条消息再念一遍。
   */
  const startSmart = useCallback(
    async (cwd: string, requirement: string) => {
      requestComposerInsert(
        t("pixieAutomationGuideNew", {
          requirement,
          cwd: cwd || useAppStore.getState().workspace?.canonicalCwd || "",
        }),
      );
      setCreating(false);
      return null;
    },
    [t],
  );

  const countdown = nextRunAt ? formatCountdown(nextRunAt, now) : null;
  const hint = !available
    ? ""
    : countdown === null
      ? ""
      : countdown === "due"
        ? t("automationDueNow")
        : t("pixieAutomationNextHint", { value: countdown });
  const detailJob = detailId ? ((jobs ?? []).find((job) => job.id === detailId) ?? null) : null;

  return (
    <PixiePanelBody tab="automation" active={active}>
      <div className="flex flex-col gap-1.5">
        {error ? <p className="px-1 text-[11px] text-danger">{error}</p> : null}
        {!available ? (
          <p className="px-1 py-2 text-[11px] leading-5 text-muted">
            {t("automationOfflineTitle")}
          </p>
        ) : (
          <>
            {/* 二级页签行同时是这一块的**工具条**（与待办 · 速记同一套）：两桶占满左边，
             * 下次触发贴右，再后面是 ＋。原来那条单独的 hint 行就此省掉——
             * 面板窄，能省一行就多出一行的列表。 */}
            <div className="flex items-center gap-1">
              {(["active", "expired"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  data-testid={`pixie-automation-tab-${candidate}`}
                  aria-pressed={bucket === candidate}
                  className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-[11px] transition-colors focus-visible:outline-none ${
                    bucket === candidate
                      ? "border-nav-active/50 bg-nav-active font-semibold text-nav-active-foreground"
                      : "border-border text-muted hover:bg-surface-overlay hover:text-foreground"
                  }`}
                  onClick={() => setBucket(candidate)}
                >
                  {candidate === "active"
                    ? t("automationSectionActive")
                    : t("automationSectionExpired")}
                  <span className="text-[10px] tabular-nums opacity-75">
                    {candidate === "active" ? activeJobs.length : expiredJobs.length}
                  </span>
                </button>
              ))}
              {hint ? (
                <span
                  data-testid="pixie-automation-hint"
                  className="min-w-0 shrink truncate text-right text-[10px] tabular-nums text-muted"
                >
                  {hint}
                </span>
              ) : null}
              <button
                type="button"
                data-testid="pixie-automation-new"
                title={t("pixieAutomationNew")}
                aria-label={t("pixieAutomationNew")}
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground focus-visible:outline-none"
                onClick={() => setCreating(true)}
              >
                <Plus size={13} />
              </button>
            </div>
            {ordered.length === 0 ? (
              <p className="px-1 py-2 text-center text-[11px] text-muted">
                {t("automationEmptyTitle")}
              </p>
            ) : bucketJobs.length === 0 ? (
              <p className="px-1 py-2 text-center text-[11px] text-muted">
                {bucket === "active"
                  ? t("automationSectionActiveEmpty")
                  : t("automationSectionExpiredEmpty")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {bucketJobs.map((job) => (
                  <AutomationRow
                    key={job.id}
                    job={job}
                    now={now}
                    running={activeJobIds.includes(job.id)}
                    disabled={busyId !== null}
                    onToggle={(enabled) => void toggleJob(job, enabled)}
                    onOpen={() => setDetailId(job.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {creating ? (
        <AutomationJobDialog
          job={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            useAppStore.getState().bumpAutomationRevision();
          }}
          onStartSmart={async (cwd, requirement) => startSmart(cwd, requirement)}
        />
      ) : null}

      {detailJob ? (
        <PixieAutomationDetailDialog
          job={detailJob}
          jobLive={activeJobIds.includes(detailJob.id)}
          onClose={() => setDetailId(null)}
          onChanged={() => useAppStore.getState().bumpAutomationRevision()}
        />
      ) : null}
    </PixiePanelBody>
  );
}
function AutomationRow({
  job,
  now,
  running,
  disabled,
  onToggle,
  onOpen,
}: {
  job: AutomationJob;
  now: number;
  /** 这一轮正在执行（`listJobs` 的 activeJobIds），与「启用中」是两回事。 */
  running: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}) {
  const t = useT();
  const act = isActive(job);
  const summary = triggerSummary(job.trigger);
  const countdown = act ? formatCountdown(job.nextRunAt, now) : null;

  const triggerLabel =
    summary.kind === "manual"
      ? t("automationTriggerManual")
      : summary.kind === "once"
        ? t("automationTriggerOnce")
        : summary.kind === "cron"
          ? (summary.value ?? t("automationTriggerCron"))
          : t("automationEveryValue", { value: formatIntervalEvery(summary.value ?? "") });

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="pixie-automation-row"
      aria-label={t("pixieAutomationOpenDetail")}
      className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 transition-colors hover:bg-surface-overlay"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
          running ? "animate-pulse bg-accent" : act ? "bg-accent" : "bg-muted/50"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-foreground/90">{job.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-accent">{triggerLabel}</span>
          {countdown ? (
            <span className="text-muted">
              {countdown === "due"
                ? t("automationDueNow")
                : t("pixieAutomationNextHint", { value: countdown })}
            </span>
          ) : null}
          {running ? <span className="text-accent">{t("automationRunning")}</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          <span className="truncate">{job.cwd.split(/[\\/]/).pop() || job.cwd}</span>
          {job.terminated ? <span>{t("automationTerminated")}</span> : null}
        </div>
      </div>
      {/* 开关不许带着整行一起打开详情。 */}
      <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <Switch checked={job.enabled} disabled={disabled} label={job.name} onChange={onToggle} />
      </span>
    </div>
  );
}
