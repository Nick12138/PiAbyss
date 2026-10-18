/**
 * 自动化的**详情视图**（分组定义列表）：独立页的右栏与小精灵的详情弹窗共用这一份。
 *
 * 抽出来不是为了少写几行——是为了口径只有一套：权限档位怎么念、`runCount / maxRuns`
 * 怎么显示、错过窗口怎么翻译，两边不能各说一套。
 */
import type { ReactNode } from "react";
import { ListChecks, Terminal } from "lucide-react";
import type { AutomationJob } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { AUTOMATION_STATUS_LABEL, formatDateTime, workspaceBaseLabel } from "./automation-model";

const PERMISSION_LABEL: Record<string, MessageKey> = {
  read_only: "automationPermissionReadOnly",
  write: "automationPermissionWrite",
  full: "automationPermissionFull",
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

export function AutomationJobDetail({ job }: { job: AutomationJob }) {
  const t = useT();
  const isCommand = Boolean(job.command);
  const triggerText = (() => {
    const trigger = job.trigger;
    switch (trigger.type) {
      case "manual":
        return t("automationTriggerManual");
      case "interval":
        return `${t("automationTriggerInterval")} · ${trigger.every}`;
      case "cron":
        return `${t("automationTriggerCron")} · ${trigger.cron}`;
      case "once":
        return formatDateTime(trigger.at);
      default:
        return "—";
    }
  })();

  return (
    <div className="flex flex-col gap-3">
      {/* Payload: the plan prompt or the shell command. */}
      <section className="rounded-lg border border-border bg-surface/60 p-3.5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          {isCommand ? <Terminal size={12} /> : <ListChecks size={12} />}
          {isCommand ? t("automationFormCommand") : t("automationFormPrompt")}
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
      <DetailGroup title={t("automationDetailGroupTrigger")}>
        <DetailRow label={t("automationFormTrigger")}>{triggerText}</DetailRow>
        <DetailRow label={t("automationDetailNextRun")}>{formatDateTime(job.nextRunAt)}</DetailRow>
        <DetailRow label={t("automationFormMissedWindow")}>
          {t(`automationMissedWindow${job.missedWindow === "catch_up_one" ? "CatchUp" : "Skip"}`)}
        </DetailRow>
      </DetailGroup>

      {/* Execution */}
      <DetailGroup title={t("automationDetailGroupExecution")}>
        {!isCommand && (
          <>
            <DetailRow label={t("automationFormPermission")}>
              {t(PERMISSION_LABEL[job.permission] ?? "automationPermissionReadOnly")}
            </DetailRow>
            <DetailRow label={t("automationFormModel")}>
              {job.model
                ? `${job.model.provider} · ${job.model.id}`
                : t("automationModelDefaultPlain")}
            </DetailRow>
            <DetailRow label={t("pixieDetailToolsTitle")}>
              {job.loadExtensions
                ? t("pixieDetailToolsWithExtensions")
                : t("pixieDetailToolsBuiltin")}
            </DetailRow>
          </>
        )}
        <DetailRow label={t("automationDetailLastRun")}>
          {formatDateTime(job.lastRunAt)}
          {job.lastStatus ? ` · ${t(AUTOMATION_STATUS_LABEL[job.lastStatus])}` : ""}
        </DetailRow>
        <DetailRow label={t("automationDetailRunCount")}>
          {job.runCount}
          {job.maxRuns !== null ? ` / ${job.maxRuns}` : ""}
        </DetailRow>
        <DetailRow label={t("automationFormTimeoutMinutes")}>
          {Math.round(job.timeoutMs / 60_000)} min
        </DetailRow>
      </DetailGroup>

      {(job.tags.length > 0 || job.terminated) && (
        <DetailGroup title={t("automationDetailGroupMeta")}>
          {job.tags.length > 0 && (
            <DetailRow label={t("automationFormTags")}>
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
            <DetailRow label={t("automationTerminated")}>
              <span className="text-warning">{job.terminated}</span>
            </DetailRow>
          )}
          <DetailRow label={t("automationFilterWorkspace")}>
            {workspaceBaseLabel(job.cwd)}
          </DetailRow>
        </DetailGroup>
      )}
    </div>
  );
}
