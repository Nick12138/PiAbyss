import type { ScheduleJob, ScheduleJobInput, ScheduleTrigger } from "@piabyss/protocol";
import type { MessageKey } from "../../lib/i18n";

/** Matches the plugin's DEFAULTS.timeoutMs (30 minutes). */
const SCHEDULE_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Plugin LIMITS.maxJobs-aware guard rails used by the form. */
export const SCHEDULE_MAX_TIMEOUT_MINUTES = 6 * 60;

type SchedulePermissionValue = "read_only" | "write" | "full";

export type ScheduleFormState = {
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
  cronTimezone: string;
  permission: SchedulePermissionValue;
  /** 按计划推送配置。 */
  notify: "none" | "system" | "tg";
  /** null = 宿主默认模型。 */
  model: { provider: string; id: string } | null;
  missedWindow: "catch_up_one" | "skip";
  timeoutMinutes: number;
  /** "" = 不限制。 */
  maxRuns: string;
  /** 逗号分隔。 */
  tags: string;
  enabled: boolean;
};

export type ScheduleIntervalUnit = "s" | "m" | "h" | "d" | "w" | "mo";

export function defaultScheduleForm(cwd: string): ScheduleFormState {
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
    cronTimezone: "",
    permission: "read_only",
    notify: "system",
    model: null,
    missedWindow: "catch_up_one",
    timeoutMinutes: SCHEDULE_DEFAULT_TIMEOUT_MS / 60_000,
    maxRuns: "",
    tags: "",
    enabled: true,
  };
}

/** Parse the plugin's interval string ("30m" / "2h" / "1d" / "15s" / "2w" / "1mo"). */
export function parseIntervalEvery(every: string): { value: number; unit: ScheduleIntervalUnit } {
  const match = every.trim().match(/^(\d+)\s*(mo|m|h|d|w|s)$/i);
  if (!match) return { value: 30, unit: "m" };
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase() as ScheduleIntervalUnit,
  };
}

export function jobToForm(job: ScheduleJob): ScheduleFormState {
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
    cronTimezone: trigger.type === "cron" && trigger.timezone ? trigger.timezone : "",
    permission: job.permission,
    notify: job.notify ?? "none",
    model: job.model ? { provider: job.model.provider, id: job.model.id } : null,
    missedWindow: job.missedWindow,
    timeoutMinutes: Math.max(1, Math.round(job.timeoutMs / 60_000)),
    maxRuns: job.maxRuns === null ? "" : String(job.maxRuns),
    tags: job.tags.join(", "),
    enabled: job.enabled,
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

function buildTrigger(form: ScheduleFormState): ScheduleTrigger | { error: MessageKey } {
  switch (form.triggerType) {
    case "manual":
      return { type: "manual" };
    case "once": {
      if (!form.onceAt) return { error: "scheduleFormOnceRequired" };
      const at = new Date(form.onceAt);
      if (Number.isNaN(at.getTime())) return { error: "scheduleFormOnceInvalid" };
      return { type: "once", at: at.toISOString() };
    }
    case "interval": {
      if (!Number.isFinite(form.intervalValue) || form.intervalValue < 1) {
        return { error: "scheduleFormIntervalInvalid" };
      }
      return { type: "interval", every: `${form.intervalValue}${form.intervalUnit}` };
    }
    case "cron": {
      const cron = form.cron.trim();
      const fields = cron.split(/\s+/).filter(Boolean);
      if (fields.length !== 5) return { error: "scheduleFormCronInvalid" };
      return {
        type: "cron",
        cron,
        ...(form.cronTimezone.trim() ? { timezone: form.cronTimezone.trim() } : {}),
      };
    }
  }
}

export function formToJobInput(
  form: ScheduleFormState,
): { ok: true; input: ScheduleJobInput } | { ok: false; errorKey: MessageKey } {
  const trigger = buildTrigger(form);
  if ("error" in trigger) return { ok: false, errorKey: trigger.error };
  const timeoutMs = Math.round(form.timeoutMinutes * 60_000);
  const maxRuns = form.maxRuns.trim() === "" ? null : Number(form.maxRuns.trim());
  if (maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 1)) {
    return { ok: false, errorKey: "scheduleFormMaxRunsInvalid" };
  }
  if (form.timeoutMinutes < 1 || form.timeoutMinutes > SCHEDULE_MAX_TIMEOUT_MINUTES) {
    return { ok: false, errorKey: "scheduleFormTimeoutInvalid" };
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
      model: form.model ? { provider: form.model.provider, id: form.model.id } : null,
      missedWindow: form.missedWindow,
      timeoutMs,
      maxRuns,
      loadExtensions: false,
      tags: form.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      enabled: form.enabled,
    },
  };
}

/** Field-level validation for live form feedback. Returns i18n error keys. */
export function scheduleFormErrors(form: ScheduleFormState): Partial<Record<string, MessageKey>> {
  const errors: Partial<Record<string, MessageKey>> = {};
  if (!form.name.trim()) errors.name = "scheduleFormNameRequired";
  if (form.kind === "prompt" && !form.prompt.trim()) errors.prompt = "scheduleFormPromptRequired";
  if (form.kind === "command" && !form.command.trim())
    errors.command = "scheduleFormCommandRequired";
  if (!form.cwd.trim()) errors.cwd = "scheduleFormCwdRequired";
  if (form.triggerType === "once") {
    if (!form.onceAt) errors.onceAt = "scheduleFormOnceRequired";
    else if (Number.isNaN(new Date(form.onceAt).getTime()))
      errors.onceAt = "scheduleFormOnceInvalid";
  }
  if (form.triggerType === "interval" && form.intervalValue < 1) {
    errors.interval = "scheduleFormIntervalInvalid";
  }
  if (form.triggerType === "cron" && form.cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
    errors.cron = "scheduleFormCronInvalid";
  }
  if (form.timeoutMinutes < 1 || form.timeoutMinutes > SCHEDULE_MAX_TIMEOUT_MINUTES) {
    errors.timeout = "scheduleFormTimeoutInvalid";
  }
  if (form.maxRuns.trim() !== "") {
    const maxRuns = Number(form.maxRuns.trim());
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1)
      errors.maxRuns = "scheduleFormMaxRunsInvalid";
  }
  return errors;
}

/* ── Display helpers ─────────────────────────────────────────── */

export type ScheduleTriggerSummary = {
  kind: "manual" | "once" | "interval" | "cron";
  /** cron 表达式 / interval 字符串 / once 的 ISO。 */
  value: string | null;
};

export function triggerSummary(trigger: ScheduleTrigger): ScheduleTriggerSummary {
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
