/**
 * 随行面板「周期计划」的**详情弹窗**：计划全貌 + 执行历史 + 过程 + 动作。
 *
 * 独立页的右栏换成弹窗是给小精灵页让路的形态（面板只有 350–720px，详情必须有自己的
 * 宽度，所以弹窗居中偏大、内部滚动）。动作里唯一新长出来的是**停止**：
 * 中止的是这一轮，任务与排期都不动（`aborted` 在插件侧不消耗投递配额）。
 *
 * 执行过程走 `schedule.runMessages`——Host 直接读 run 的会话文件，保留思考块与工具
 * 调用，渲染复用共享转写（`TranscriptRowView`）。命令型任务没有过程会话，
 * `found=false` 是如实结果，不是加载失败。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, Pencil, Play, Square, Trash2 } from "lucide-react";
import type { ScheduleJob, ScheduleRunSummary } from "@piabyss/protocol";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { CollapsibleRegion } from "../../components/CollapsibleRegion";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { draftTargetFor } from "../../lib/draft-target";
import { TranscriptRowView } from "../chat/Transcript";
import { buildRunRows } from "../schedule/schedule-transcript";
import { ScheduleJobDetail } from "../schedule/ScheduleJobDetail";
import { injectScheduleJobReference } from "../schedule/schedule-reference";
import { ScheduleJobDialog } from "../schedule/ScheduleJobDialog";
import {
  SCHEDULE_STATUS_LABEL,
  formatDateTime,
  formatDurationMs,
} from "../schedule/schedule-model";

const LIST_TIMEOUT_MS = 15_000;
/** 立即执行等的是整轮跑完，给足余量（同独立页口径）。 */
const RUN_NOW_TIMEOUT_MS = 31 * 60 * 1000;
/** 进行中那一轮的过程轮询：比列表勤，比流式懒——后台任务不值得更激进了。 */
const PROCESS_POLL_MS = 1_500;
const RUNS_LIMIT = 50;

/**
 * 这一轮是怎么被触发的。口径与独立页一致：手动与追问不标——那是用户当下做的事，
 * 不是计划的来源；只有排期自己触发的那几种才值得写出来。
 */
const RUN_TRIGGER_LABEL: Record<string, MessageKey> = {
  once: "scheduleTriggerOnce",
  interval: "scheduleTriggerInterval",
  cron: "scheduleTriggerCron",
};

export function PixieScheduleDetailDialog({
  job: initialJob,
  jobLive,
  onClose,
  onChanged,
}: {
  job: ScheduleJob;
  /**
   * 这条计划**此刻**是否在调度器里真跑着（来自 `listJobs.activeJobIds`）。
   * run 记录自己的 `status:"running"` 不能单独信：宿主重启或被强杀时来不及回写终态，
   * 文件会永远停在 `running`，那是一条僵尸记录，不是一轮正在执行的活。
   */
  jobLive: boolean;
  onClose: () => void;
  /** 列表要跟着变（复制出新任务、删除、立即执行后状态刷新）。 */
  onChanged: () => void;
}) {
  const t = useT();
  const [job, setJob] = useState(initialJob);
  const [runs, setRuns] = useState<ScheduleRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [rowsByRun, setRowsByRun] = useState<Record<string, ReturnType<typeof buildRunRows>>>({});
  const [noProcessRunIds, setNoProcessRunIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runPermission, setRunPermission] = useState(job.permission);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);

  const refreshRuns = useCallback(async () => {
    if (!host) return;
    try {
      const response = await hostClient.request(
        "schedule.listRuns",
        hostContext(host),
        { jobId: job.id, limit: RUNS_LIMIT },
        LIST_TIMEOUT_MS,
      );
      if (!mountedRef.current || !response.ok) return;
      const ordered = [...response.result.runs].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      );
      setRuns(ordered);
    } catch {
      /* 保留上一次的历史，别为一次抖动作废整屏 */
    }
  }, [host, job.id]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  // 僵尸记录不该把弹窗拖进 5s 轮询：它永远不会自己变成终态。
  const running = useMemo(
    () => jobLive && runs.some((run) => run.status === "running"),
    [jobLive, runs],
  );
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refreshRuns(), 5_000);
    return () => clearInterval(timer);
  }, [running, refreshRuns]);

  /**
   * 展开某一轮 → 读过程。正在跑的那轮持续轮询直到终态；
   * 终态后进程中的 `running` 会把定时器停掉，避免留下永远转的尾巴。
   */
  const loadProcess = useCallback(
    async (run: ScheduleRunSummary) => {
      if (!host) return;
      let alive = true;
      // 这一轮在插件侧是否还在跑（越出 try 作用域也要知道，僵尸记录不必无限轮询）。
      let stillRunning = false;
      const tick = async () => {
        try {
          const response = await hostClient.request(
            "schedule.runMessages",
            hostContext(host),
            { runId: run.runId },
            LIST_TIMEOUT_MS,
          );
          if (!alive || !response.ok) return;
          const result = response.result;
          if (!result.found) {
            setNoProcessRunIds((current) =>
              current.includes(run.runId) ? current : [...current, run.runId],
            );
            return;
          }
          setRowsByRun((current) => ({
            ...current,
            [run.runId]: buildRunRows(result.messages, result.running),
          }));
          stillRunning = result.running;
          if (!result.running) return;
        } catch {
          /* 单次失败下一轮再来 */
        }
        // 僵尸记录（`running` 但调度器里没有这一条）不会自己变终态：
        // 只用 jobLive 挡一下，否则这个弹窗会替一条死掉的轮次无限轮询。
        if (alive && stillRunning && jobLive) setTimeout(() => void tick(), PROCESS_POLL_MS);
      };
      await tick();
      return () => {
        alive = false;
      };
    },
    [host, jobLive],
  );

  // 展开态变了就把上一轮的轮询关掉：卸载/收起后不许留后台定时器。
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    if (!expandedRunId) return;
    const run = runs.find((item) => item.runId === expandedRunId);
    if (!run) return;
    let cancelled = false;
    void loadProcess(run).then((dispose) => {
      if (cancelled) dispose?.();
      else cancelRef.current = dispose ?? null;
    });
    return () => {
      cancelled = true;
    };
  }, [expandedRunId, loadProcess, runs]);

  const applyJob = useCallback(
    (updated: ScheduleJob) => {
      setJob(updated);
      onChanged();
    },
    [onChanged],
  );

  const runNow = useCallback(async () => {
    if (!host || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "schedule.runJobNow",
        hostContext(host),
        { id: job.id, permission: runPermission },
        RUN_NOW_TIMEOUT_MS,
      );
      if (!response.ok) {
        setError(response.error?.message ?? t("pixieScheduleRunFailed"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      useAppStore.getState().bumpScheduleRevision();
      void refreshRuns();
      onChanged();
    }
  }, [busy, host, job.id, onChanged, refreshRuns, runPermission, t]);

  const stop = useCallback(
    async (runId: string) => {
      if (!host) return;
      try {
        const response = await hostClient.request(
          "schedule.abortRun",
          hostContext(host),
          { runId },
          LIST_TIMEOUT_MS,
        );
        // 409（这一轮已不在执行中）不是错误：它刚好跑完了，或者本来就是一条僵尸记录。
        // 把插件那句原文当错误弹出来只会吓人——刷新一次让状态自己说话。
        if (!response.ok && response.error?.code !== "AGENT_BUSY") {
          setError(response.error.message);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      void refreshRuns();
      onChanged();
    },
    [host, onChanged, refreshRuns],
  );

  const duplicate = useCallback(async () => {
    if (!host || busy) return;
    setBusy(true);
    try {
      // 逐字段照抄再改名停用（同独立页口径）：`jobToForm` 会把超时换算成分钟，
      // 复制出来的任务会在取整上与原任务差几秒，不该让「副本」不是副本。
      const response = await hostClient.request(
        "schedule.createJob",
        hostContext(host),
        {
          name: t("scheduleCopyName", { name: job.name }),
          prompt: job.prompt,
          command: job.command,
          cwd: job.cwd,
          trigger: job.trigger,
          permission: job.permission,
          model: job.model,
          missedWindow: job.missedWindow,
          timeoutMs: job.timeoutMs,
          maxRuns: job.maxRuns,
          loadExtensions: job.loadExtensions,
          tags: job.tags,
          notify: job.notify,
          enabled: false,
        },
        LIST_TIMEOUT_MS,
      );
      if (!response.ok) setError(response.error?.message ?? null);
      else onChanged();
    } finally {
      setBusy(false);
    }
  }, [busy, host, job, onChanged, t]);

  const remove = useCallback(async () => {
    if (!host) return;
    setConfirmDelete(false);
    const response = await hostClient.request(
      "schedule.deleteJob",
      hostContext(host),
      { id: job.id },
      LIST_TIMEOUT_MS,
    );
    if (!response.ok) setError(response.error?.message ?? null);
    else {
      onChanged();
      onClose();
    }
  }, [host, job.id, onClose, onChanged]);

  return (
    <Dialog
      title={job.name || t("scheduleUntitledJob")}
      confirmLabel={t("commonClose")}
      showCloseIcon
      hideActions
      maxWidthClass="max-w-3xl"
      maxHeightClass="max-h-[min(860px,92vh)]"
      /* 关闭只有右上角的 ❌（`showCloseIcon` + `hideActions`：底部不再排一个「关闭」）。
       * 正文自己滚、动作条钉在正文之下——不加 `fillBody` 的话，历史一展开就得
       * 先把「立即执行」滚出来才点得到。`confirmLabel` 是 Dialog 的必填项，
       * `hideActions` 之下它不会显示。 */
      fillBody
      onCancel={onClose}
      onConfirm={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {error ? (
            <p className="rounded-md bg-danger/10 px-2.5 py-2 text-xs text-danger">{error}</p>
          ) : null}

          <ScheduleJobDetail job={job} />

          <div className="flex flex-col gap-2">
            <h3 className="text-[13px] font-medium">{t("scheduleRunsTitle")}</h3>
            {runs.length === 0 ? (
              <p className="py-2 text-xs text-muted">{t("pixieScheduleRunsEmpty")}</p>
            ) : (
              runs.map((run) => {
                const expanded = expandedRunId === run.runId;
                const noProcess = noProcessRunIds.includes(run.runId);
                const triggerKey = RUN_TRIGGER_LABEL[run.trigger];
                const triggerLabel = triggerKey ? t(triggerKey) : null;
                return (
                  <div key={run.runId} className="rounded-lg border border-border">
                    <button
                      type="button"
                      data-testid="pixie-detail-run-row"
                      aria-expanded={expanded}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-overlay"
                      onClick={() => setExpandedRunId(expanded ? null : run.runId)}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          run.status === "running" && jobLive
                            ? "animate-pulse bg-accent"
                            : run.status === "running"
                              ? "bg-warning"
                              : run.status === "ok"
                                ? "bg-success"
                                : "bg-danger"
                        }`}
                      />
                      <span className="shrink-0 tabular-nums text-muted">
                        {formatDateTime(run.startedAt)}
                      </span>
                      <span
                        className={`shrink-0 ${
                          run.status === "running" && !jobLive ? "text-warning" : ""
                        }`}
                        title={
                          run.status === "running" && !jobLive
                            ? t("pixieScheduleStaleRunHint")
                            : undefined
                        }
                      >
                        {run.status === "running" && !jobLive
                          ? t("pixieScheduleStaleRun")
                          : t(SCHEDULE_STATUS_LABEL[run.status])}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted">
                        {run.summary || run.error || "—"}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted">
                        {formatDurationMs(run.durationMs)}
                      </span>
                      {run.status === "running" && jobLive ? (
                        <span
                          role="button"
                          tabIndex={0}
                          data-testid="pixie-detail-stop"
                          aria-label={t("pixieScheduleStop")}
                          title={t("pixieScheduleStopHint")}
                          className="flex size-6 items-center justify-center rounded-md border border-border text-danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            void stop(run.runId);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            void stop(run.runId);
                          }}
                        >
                          <Square size={11} aria-hidden="true" />
                        </span>
                      ) : null}
                    </button>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-1.5 text-[10px] text-muted">
                      {triggerLabel ? <span>{triggerLabel}</span> : null}
                      {run.usage ? (
                        <span
                          className="tabular-nums"
                          title={`${run.usage.input} in · ${run.usage.output} out`}
                        >
                          {run.usage.total.toLocaleString()} tok
                        </span>
                      ) : null}
                      {run.forkOf ? <span>fork</span> : null}
                      <span>
                        {t("pixieScheduleToolsLabel")}: {run.tools.join(" ") || "—"}
                      </span>
                      {run.command ? <span>· {t("pixieScheduleCommandRun")}</span> : null}
                      {run.toolCalls > 0 ? (
                        <span>· {t("pixieScheduleToolCalls", { count: run.toolCalls })}</span>
                      ) : null}
                    </div>
                    <CollapsibleRegion open={expanded}>
                      <div data-testid="pixie-detail-run-process" className="px-3 pb-3">
                        {noProcess ? (
                          <p className="text-xs text-muted">{t("pixieScheduleNoProcess")}</p>
                        ) : rowsByRun[run.runId]?.length ? (
                          <div className="flex flex-col gap-2">
                            {rowsByRun[run.runId].map((row, index, all) => (
                              <TranscriptRowView
                                key={row.key}
                                row={row}
                                /* 只有仍在跑的那一轮、且是最后一行才走流式：
                                 * 前面的行早就定了型，再挂光标会闪。 */
                                mode={
                                  run.status === "running" && index === all.length - 1
                                    ? "streaming"
                                    : "static"
                                }
                                showCaret={false}
                                working={false}
                                retryableTurn={undefined}
                                retryVisible={false}
                                goOnVisible={false}
                                onRetry={async () => undefined}
                                readOnly
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="flex items-center gap-1.5 text-xs text-muted">
                            <Loader2 size={12} className="animate-spin" />
                            {t("pixieScheduleProcessLoading")}
                          </p>
                        )}
                      </div>
                    </CollapsibleRegion>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
          <button
            type="button"
            data-testid="pixie-detail-run-now"
            disabled={busy}
            className={secondaryButton}
            onClick={() => void runNow()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {t("scheduleRunNow")}
          </button>
          <Select
            value={runPermission}
            onChange={(value) => setRunPermission(value as ScheduleJob["permission"])}
            ariaLabel={t("pixieScheduleRunPermission")}
            options={[
              { value: "read_only", label: t("schedulePermissionReadOnly") },
              { value: "write", label: t("schedulePermissionWrite") },
              { value: "full", label: t("schedulePermissionFull") },
            ]}
          />
          <button
            type="button"
            data-testid="pixie-detail-edit"
            className={secondaryButton}
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} />
            {t("scheduleEdit")}
          </button>
          <button
            type="button"
            data-testid="pixie-detail-copy"
            className={secondaryButton}
            onClick={() => void duplicate()}
          >
            <Copy size={13} />
            {t("scheduleCopy")}
          </button>
          <button
            type="button"
            data-testid="pixie-detail-delete"
            className={secondaryButton}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={13} />
            {t("scheduleDelete")}
          </button>
        </div>
      </div>

      {confirmDelete ? (
        <Dialog
          title={t("scheduleDeleteTitle")}
          confirmLabel={t("scheduleDelete")}
          tone="danger"
          icon={Trash2}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        >
          <p className="text-sm">{t("scheduleDeleteBody", { name: job.name })}</p>
        </Dialog>
      ) : null}

      {editing ? (
        <ScheduleJobDialog
          job={job}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            applyJob(updated);
          }}
          /* 「让精灵改」照备忘录那条路：注入 `@周期计划` 引用胶囊，配置正文折在
           * payload 里发送时才展开——输入框保持干净，标题/搜索/复制也不会看见那坨 JSON。 */
          onOptimize={async (target) => {
            const state = useAppStore.getState();
            const draftTarget = draftTargetFor(state.workspace, state.session);
            if (!draftTarget) {
              setEditing(false);
              pushNotification(t("memoAgentNoWorkspace"), "warning");
              return null;
            }
            injectScheduleJobReference(draftTarget, target);
            setEditing(false);
            onClose();
            return null;
          }}
        />
      ) : null}
    </Dialog>
  );
}
