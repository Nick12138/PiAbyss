import type { AutomationJob, AutomationJobInput, AutomationTrigger } from "@piabyss/protocol";
import type { MessageKey } from "../../lib/i18n";
import type { Translate } from "../../lib/i18n/use-t";
import type { AutomationPlanDraft } from "./automation-plan-fence";

/** Matches the plugin's DEFAULTS.timeoutMs (30 minutes). */
const AUTOMATION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Plugin LIMITS.maxJobs-aware guard rails used by the form. */
export const AUTOMATION_MAX_TIMEOUT_MINUTES = 6 * 60;

/** Shared run-status → i18n key map (主界面列表 / 详情 / 执行历史共用). */
export const AUTOMATION_STATUS_LABEL: Record<string, MessageKey> = {
  ok: "automationStatusOk",
  error: "automationStatusError",
  timeout: "automationStatusTimeout",
  aborted: "automationStatusAborted",
  running: "automationStatusRunning",
};

type AutomationPermissionValue = "read_only" | "write" | "full";

export type AutomationFormState = {
  name: string;
  /** prompt 任务（走模型）或 command 任务（直接执行 shell 命令）。 */
  kind: "prompt" | "command";
  prompt: string;
  command: string;
  cwd: string;
  triggerType: "manual" | "once" | "interval" | "cron";
  /** datetime-local 原始值（"2026-01-01T09:00"）。 */
  onceAt: string;
  intervalValue: number;
  intervalUnit: "s" | "m" | "h" | "d" | "w" | "mo";
  cron: string;
  permission: AutomationPermissionValue;
  /** 按计划推送配置。 */
  notify: "none" | "system" | "tg";
  /** null = 宿主默认模型。 */
  model: { provider: string; id: string; thinkingLevel?: string } | null;
  missedWindow: "catch_up_one" | "skip";
  timeoutMinutes: number;
  /** "" = 不限制。 */
  maxRuns: string;
  /** 逗号分隔。 */
  tags: string;
  enabled: boolean;
  /**
   * 执行会话要不要加载扩展与技能。**默认关**：计划是无人值守的重复执行，
   * 关掉扩展同时是防递归（执行会话拿不到 `automation` 工具，就不会自己再建计划）。
   * 这一位过去被表单写死成 false，用户根本不知道有这档；现在如实暴露、如实承担。
   */
  loadExtensions: boolean;
};

export type AutomationIntervalUnit = "s" | "m" | "h" | "d" | "w" | "mo";

export function defaultAutomationForm(cwd: string): AutomationFormState {
  return {
    name: "",
    kind: "prompt",
    prompt: "",
    command: "",
    cwd,
    triggerType: "manual",
    onceAt: "",
    intervalValue: 30,
    intervalUnit: "m",
    cron: "0 9 * * 1-5",
    permission: "read_only",
    notify: "system",
    model: null,
    missedWindow: "catch_up_one",
    timeoutMinutes: AUTOMATION_DEFAULT_TIMEOUT_MS / 60_000,
    maxRuns: "",
    tags: "",
    enabled: true,
    loadExtensions: false,
  };
}

/** Parse the plugin's interval string ("30m" / "2h" / "1d" / "15s" / "2w" / "1mo"). */
export function parseIntervalEvery(every: string): { value: number; unit: AutomationIntervalUnit } {
  const match = every.trim().match(/^(\d+)\s*(mo|m|h|d|w|s)$/i);
  if (!match) return { value: 30, unit: "m" };
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase() as AutomationIntervalUnit,
  };
}

export function jobToForm(job: AutomationJob): AutomationFormState {
  const trigger = job.trigger;
  const interval =
    trigger.type === "interval"
      ? parseIntervalEvery(trigger.every)
      : { value: 30, unit: "m" as const };
  return {
    name: job.name,
    kind: job.command ? "command" : "prompt",
    prompt: job.prompt,
    command: job.command ?? "",
    cwd: job.cwd,
    triggerType: trigger.type === "once" ? "once" : trigger.type,
    onceAt: trigger.type === "once" ? toDatetimeLocalValue(trigger.at) : "",
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    cron: trigger.type === "cron" ? trigger.cron : "0 9 * * 1-5",
    permission: job.permission,
    notify: job.notify ?? "none",
    model: job.model
      ? {
          provider: job.model.provider,
          id: job.model.id,
          ...(job.model.thinkingLevel ? { thinkingLevel: job.model.thinkingLevel } : {}),
        }
      : null,
    missedWindow: job.missedWindow,
    timeoutMinutes: Math.max(1, Math.round(job.timeoutMs / 60_000)),
    maxRuns: job.maxRuns === null ? "" : String(job.maxRuns),
    tags: job.tags.join(", "),
    enabled: job.enabled,
    loadExtensions: job.loadExtensions,
  };
}

/** ISO string → datetime-local value in the local timezone (best effort). */
export function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function buildTrigger(form: AutomationFormState): AutomationTrigger | { error: MessageKey } {
  switch (form.triggerType) {
    case "manual":
      return { type: "manual" };
    case "once": {
      if (!form.onceAt) return { error: "automationFormOnceRequired" };
      const at = new Date(form.onceAt);
      if (Number.isNaN(at.getTime())) return { error: "automationFormOnceInvalid" };
      return { type: "once", at: at.toISOString() };
    }
    case "interval": {
      if (!Number.isFinite(form.intervalValue) || form.intervalValue < 1) {
        return { error: "automationFormIntervalInvalid" };
      }
      return { type: "interval", every: `${form.intervalValue}${form.intervalUnit}` };
    }
    case "cron": {
      const cron = form.cron.trim();
      const fields = cron.split(/\s+/).filter(Boolean);
      if (fields.length !== 5) return { error: "automationFormCronInvalid" };
      return {
        type: "cron",
        cron,
      };
    }
  }
}

export function formToJobInput(
  form: AutomationFormState,
): { ok: true; input: AutomationJobInput } | { ok: false; errorKey: MessageKey } {
  const trigger = buildTrigger(form);
  if ("error" in trigger) return { ok: false, errorKey: trigger.error };
  const timeoutMs = Math.round(form.timeoutMinutes * 60_000);
  const maxRuns = form.maxRuns.trim() === "" ? null : Number(form.maxRuns.trim());
  if (maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 1)) {
    return { ok: false, errorKey: "automationFormMaxRunsInvalid" };
  }
  if (form.timeoutMinutes < 1 || form.timeoutMinutes > AUTOMATION_MAX_TIMEOUT_MINUTES) {
    return { ok: false, errorKey: "automationFormTimeoutInvalid" };
  }
  return {
    ok: true,
    input: {
      name: form.name.trim(),
      prompt: form.kind === "prompt" ? form.prompt : "",
      command: form.kind === "command" ? form.command : null,
      cwd: form.cwd.trim(),
      trigger,
      permission: form.permission,
      notify: form.notify,
      model: form.model
        ? {
            provider: form.model.provider,
            id: form.model.id,
            ...(form.model.thinkingLevel ? { thinkingLevel: form.model.thinkingLevel } : {}),
          }
        : null,
      missedWindow: form.missedWindow,
      timeoutMs,
      maxRuns,
      loadExtensions: form.loadExtensions,
      tags: form.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      enabled: form.enabled,
    },
  };
}

/** Field-level validation for live form feedback. Returns i18n error keys. */
export function automationFormErrors(
  form: AutomationFormState,
): Partial<Record<string, MessageKey>> {
  const errors: Partial<Record<string, MessageKey>> = {};
  if (!form.name.trim()) errors.name = "automationFormNameRequired";
  if (form.kind === "prompt" && !form.prompt.trim()) errors.prompt = "automationFormPromptRequired";
  if (form.kind === "command" && !form.command.trim())
    errors.command = "automationFormCommandRequired";
  if (!form.cwd.trim()) errors.cwd = "automationFormCwdRequired";
  if (form.triggerType === "once") {
    if (!form.onceAt) errors.onceAt = "automationFormOnceRequired";
    else if (Number.isNaN(new Date(form.onceAt).getTime()))
      errors.onceAt = "automationFormOnceInvalid";
  }
  if (form.triggerType === "interval" && form.intervalValue < 1) {
    errors.interval = "automationFormIntervalInvalid";
  }
  if (form.triggerType === "cron" && form.cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
    errors.cron = "automationFormCronInvalid";
  }
  if (form.timeoutMinutes < 1 || form.timeoutMinutes > AUTOMATION_MAX_TIMEOUT_MINUTES) {
    errors.timeout = "automationFormTimeoutInvalid";
  }
  if (form.maxRuns.trim() !== "") {
    const maxRuns = Number(form.maxRuns.trim());
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1)
      errors.maxRuns = "automationFormMaxRunsInvalid";
  }
  return errors;
}

/* ── Display helpers ─────────────────────────────────────────── */

export type AutomationTriggerSummary = {
  kind: "manual" | "once" | "interval" | "cron";
  /** cron 表达式 / interval 字符串 / once 的 ISO。 */
  value: string | null;
};

export function triggerSummary(trigger: AutomationTrigger): AutomationTriggerSummary {
  switch (trigger.type) {
    case "manual":
      return { kind: "manual", value: null };
    case "once":
      return { kind: "once", value: trigger.at };
    case "interval":
      return { kind: "interval", value: trigger.every };
    case "cron":
      return { kind: "cron", value: trigger.cron };
  }
}

/** Human interval like "90m" → "1h30m". */
export function formatIntervalEvery(every: string): string {
  const match = every.trim().match(/^(\d+)\s*(mo|m|h|d|w|s)$/i);
  if (!match) return every;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return `${value}s`;
  if (unit === "w") return `${value}w`;
  if (unit === "mo") return `${value}mo`;
  if (unit === "m" && value >= 60) {
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  }
  if (unit === "m") return `${value}m`;
  return `${value}${unit}`;
}

/* ── Smart-creation preview ────────────────────────────────────
 *
 * The preview answers "what will actually be created?", so a field the AI
 * never mentioned must not read as an unresolved blank when the plugin has a
 * well-defined default for it: a null model really creates "host default", a
 * null maxRuns really creates "unlimited". Only genuinely open *required*
 * fields are reported as pending, and fields that do not apply to the chosen
 * kind are dropped instead of rendered empty.
 */

/**
 * 草案的线格式（`automation-plan` 围栏）住在 `automation-plan-fence` 里：转写投影也要拆它，
 * 那条路径不许依赖 i18n。这里只做「页面确实用到的」再导出，不是把整个模块转出去——
 * 全部再导出会养出第二条引用路径，改起来没人报错。
 */
export type { AutomationPlanDraft } from "./automation-plan-fence";

/** Matches the plugin's create path: only an explicit "command" is a command plan. */
function automationPlanIsCommand(plan: AutomationPlanDraft): boolean {
  return plan.kind === "command";
}

/** Required fields still missing. Empty ⇒ the plan is creatable. */
export function automationPlanMissingFields(plan: AutomationPlanDraft): MessageKey[] {
  const missing: MessageKey[] = [];
  if (!plan.name?.trim()) missing.push("automationFormName");
  if (!plan.cwd?.trim()) missing.push("automationFormCwd");
  if (!(plan.trigger && typeof plan.trigger.type === "string")) {
    missing.push("automationFormTrigger");
  }
  // Mirrors the create path: anything that is not explicitly "command" is
  // created as a prompt plan, so a null kind does not block confirmation.
  if (automationPlanIsCommand(plan)) {
    if (!plan.command?.trim()) missing.push("automationFormCommand");
  } else if (!plan.prompt?.trim()) {
    missing.push("automationFormPrompt");
  }
  return missing;
}

/**
 * One preview line. `value === null` means the field is still open — by
 * construction that only happens for required fields, because every optional
 * field resolves to the value the plugin would use.
 */
export type AutomationPreviewRow = {
  label: MessageKey;
  value: string | null;
  /** The value comes from the plugin/host default, not an explicit decision. */
  fallback?: boolean;
};

/** Human trigger label, e.g. "周期 · 每 1h30m". */
function automationTriggerDisplay(
  trigger: AutomationTrigger | null | undefined,
  t: Translate,
): string | null {
  if (!trigger || typeof trigger.type !== "string") return null;
  switch (trigger.type) {
    case "manual":
      return t("automationTriggerManual");
    case "once":
      return trigger.at
        ? `${t("automationTriggerOnce")} · ${formatDateTime(trigger.at)}`
        : t("automationTriggerOnce");
    case "interval":
      return `${t("automationTriggerInterval")} · ${t("automationEveryValue", {
        value: formatIntervalEvery(trigger.every),
      })}`;
    case "cron":
      return `${t("automationTriggerCron")} · ${trigger.cron}`;
    default:
      return null;
  }
}

/** Preview rows for the smart-creation panel, in display order. */
export function automationPlanPreviewRows(
  plan: AutomationPlanDraft,
  t: Translate,
  hostDefaultModelLabel: string,
): AutomationPreviewRow[] {
  const isCommand = automationPlanIsCommand(plan);
  const rows: AutomationPreviewRow[] = [
    { label: "automationFormName", value: plan.name?.trim() || null },
    {
      label: "automationFormKind",
      value: isCommand ? t("automationFormKindCommand") : t("automationFormKindPrompt"),
      // A null kind creates a prompt plan, so label it as the default rather
      // than pretending the choice is still open.
      fallback: plan.kind !== "command",
    },
    {
      label: "automationFormTrigger",
      value: automationTriggerDisplay(plan.trigger, t),
    },
    { label: "automationFormCwd", value: plan.cwd?.trim() || null },
  ];
  // Permission/model only exist for prompt plans (`handleConfirm` ignores them
  // for command plans), so a command plan drops the rows instead of showing
  // them as undecided.
  if (!isCommand) {
    rows.push({
      label: "automationFormPermission",
      value: t(
        plan.permission === "write"
          ? "automationPermissionWrite"
          : plan.permission === "full"
            ? "automationPermissionFull"
            : "automationPermissionReadOnly",
      ),
      fallback: plan.permission !== "write" && plan.permission !== "full",
    });
    rows.push({
      label: "automationFormModel",
      value: plan.model ? `${plan.model.provider}/${plan.model.id}` : hostDefaultModelLabel,
      fallback: !plan.model,
    });
  }
  rows.push(
    {
      label: "automationFormMissedWindow",
      value: t(
        plan.missedWindow === "skip"
          ? "automationMissedWindowSkip"
          : "automationMissedWindowCatchUp",
      ),
      fallback: plan.missedWindow !== "skip",
    },
    {
      label: "automationFormTimeout",
      value: t("automationTimeoutValue", {
        value: Math.round(
          (typeof plan.timeoutMs === "number" && plan.timeoutMs > 0
            ? plan.timeoutMs
            : AUTOMATION_DEFAULT_TIMEOUT_MS) / 60_000,
        ),
      }),
      fallback: !(typeof plan.timeoutMs === "number" && plan.timeoutMs > 0),
    },
    {
      label: "automationFormMaxRuns",
      value:
        typeof plan.maxRuns === "number" && plan.maxRuns > 0
          ? String(plan.maxRuns)
          : t("automationFormMaxRunsPlaceholder"),
      fallback: !(typeof plan.maxRuns === "number" && plan.maxRuns > 0),
    },
    {
      label: "automationFormNotify",
      value: t(
        plan.notify === "system"
          ? "automationNotifySystem"
          : plan.notify === "tg"
            ? "automationNotifyTg"
            : "automationNotifyNone",
      ),
      fallback: plan.notify !== "system" && plan.notify !== "tg",
    },
    {
      label: "automationFormLoadExtensions",
      value: t(plan.loadExtensions === true ? "automationValueYes" : "automationValueNo"),
      fallback: plan.loadExtensions !== true,
    },
  );
  // Tags are purely additive: an empty list is not "undetermined", it is
  // "none", and the panel just omits the row.
  if (Array.isArray(plan.tags) && plan.tags.length > 0) {
    rows.push({ label: "automationFormTags", value: plan.tags.join(", ") });
  }
  return rows;
}

/** Convert a smart-creation plan draft into a form state for manual
 *  editing. Undetermined (null) fields fall back to the same defaults the
 *  manual form uses, so the dialog opens with everything the AI decided
 *  already filled in and the rest at their sane defaults. */
export function planToForm(plan: AutomationPlanDraft, fallbackCwd: string): AutomationFormState {
  const trigger = plan.trigger && typeof plan.trigger.type === "string" ? plan.trigger : null;
  const interval =
    trigger?.type === "interval"
      ? parseIntervalEvery(trigger.every)
      : { value: 30, unit: "m" as const };
  return {
    name: plan.name?.trim() ?? "",
    kind: plan.kind === "command" ? "command" : "prompt",
    prompt: plan.prompt ?? "",
    command: plan.command ?? "",
    cwd: plan.cwd?.trim() || fallbackCwd,
    triggerType: trigger ? trigger.type : "manual",
    onceAt: trigger?.type === "once" ? toDatetimeLocalValue(trigger.at) : "",
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    cron: trigger?.type === "cron" ? trigger.cron : "0 9 * * 1-5",
    permission:
      plan.permission === "write" || plan.permission === "full" ? plan.permission : "read_only",
    notify: plan.notify === "none" || plan.notify === "tg" ? plan.notify : "system",
    model: plan.model ? { provider: plan.model.provider, id: plan.model.id } : null,
    missedWindow: plan.missedWindow === "skip" ? "skip" : "catch_up_one",
    timeoutMinutes: Math.max(
      1,
      Math.round(
        (typeof plan.timeoutMs === "number" && plan.timeoutMs > 0
          ? plan.timeoutMs
          : AUTOMATION_DEFAULT_TIMEOUT_MS) / 60_000,
      ),
    ),
    maxRuns: typeof plan.maxRuns === "number" && plan.maxRuns > 0 ? String(plan.maxRuns) : "",
    tags: Array.isArray(plan.tags) ? plan.tags.join(", ") : "",
    enabled: true,
    loadExtensions: plan.loadExtensions === true,
  };
}

/**
 * 工作区路径的短标签：取目录名。列表行、筛选器、详情弹窗都用这一个口径，
 * 别各处自己 split 一遍（Windows 的反斜杠尤其容易写错）。
 */
export function workspaceBaseLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.length > 0 ? base : cwd;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** Short relative label for nextRunAt, e.g. "2h3m" / "已到期". */
export function formatCountdown(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const delta = target - now;
  if (delta <= 0) return "due";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
