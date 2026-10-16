/**
 * 备忘录「计划」编辑与展示辅助。
 *
 * - `MemoScheduleEditor`：编辑器内的计划设置行（一次性截止时间 + 周期规则
 *   子表单）。规则为结构化字段（frequency / interval / weekdays / monthDay /
 *   time / tz），与 pi-host 的 recurrence.ts 及 piabyss_memo 插件保持同一形状；
 *   时区固定 Asia/Shanghai（Host 侧时刻计算不依赖设备本地时区）。
 * - `formatRecurrenceText` / `formatMemoDue` / `noteScheduleSummary`：人读描述，供列表与详情复用。
 */
import type { MemoNote, MemoRecurrence, MemoRecurrenceFrequency } from "@piabyss/protocol";
import { useT, type Translate } from "../../lib/i18n/use-t";

/** 记录的计划值（截止 + 周期）。 */
export type MemoScheduleValue = {
  dueAt: number | null;
  recurrence: MemoRecurrence | null;
};

/** 无计划（新建表单默认值）。 */
export function emptySchedule(): MemoScheduleValue {
  return { dueAt: null, recurrence: null };
}

const WEEKDAY_KEYS = [
  "memoWeekdayMon",
  "memoWeekdayTue",
  "memoWeekdayWed",
  "memoWeekdayThu",
  "memoWeekdayFri",
  "memoWeekdaySat",
  "memoWeekdaySun",
] as const;

/** 各频率的默认规则（切换频率时用它兜底，保证形状合法）。 */
function defaultRecurrence(frequency: MemoRecurrenceFrequency): MemoRecurrence {
  return {
    frequency,
    interval: 1,
    weekdays: frequency === "weekly" ? [1] : [],
    monthDay: frequency === "monthly" ? 1 : null,
    time: "09:00",
    tz: "Asia/Shanghai",
    until: null,
    startDate: null,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** epoch ms → `<input type="datetime-local">` 的本地时区取值。 */
function toLocalInputValue(epoch: number | null): string {
  if (epoch === null) return "";
  const date = new Date(epoch);
  if (Number.isNaN(date.getTime())) return "";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 本地时区输入值 → epoch ms（空/非法返回 null）。 */
function fromLocalInputValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** 周期规则的人读描述，如「每周周一 13:00」「每 2 周的周一、周三 09:30」。 */
export function formatRecurrenceText(rule: MemoRecurrence, t: Translate): string {
  const days = rule.weekdays.map((day) => t(WEEKDAY_KEYS[day - 1] ?? "memoWeekdayMon")).join(", ");
  switch (rule.frequency) {
    case "daily":
      return rule.interval === 1
        ? t("memoRecurDaily", { time: rule.time })
        : t("memoRecurEveryNDays", { interval: rule.interval, time: rule.time });
    case "weekly":
      return rule.interval === 1
        ? t("memoRecurWeekly", { days, time: rule.time })
        : t("memoRecurEveryNWeeks", { interval: rule.interval, days, time: rule.time });
    case "monthly":
      return rule.interval === 1
        ? t("memoRecurMonthly", { day: rule.monthDay ?? 1, time: rule.time })
        : t("memoRecurEveryNMonths", {
            interval: rule.interval,
            day: rule.monthDay ?? 1,
            time: rule.time,
          });
  }
}

const DAY_MS = 86_400_000;

/** 本地日历日界；跨夏令时留下的那一小时偏移用四舍五入消化掉。 */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 时刻的口语写法：今天 / 昨天 / 明天 + 时:分；同年其余「10月18日 09:20」；跨年才补上年份。
 * 列表行一行要塞下状态、时间和标签，绝对日期太长——详情页仍用 `formatMemoDateTime` 给完整时间。
 */
export function formatMemoDue(timestamp: number, now: number, t: Translate): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const shift = Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY_MS);
  const day =
    shift === 0
      ? t("memoDayToday")
      : shift === -1
        ? t("memoDayYesterday")
        : shift === 1
          ? t("memoDayTomorrow")
          : null;
  if (day !== null) return `${day} ${clock}`;
  const month = date.getMonth() + 1;
  const stamp =
    date.getFullYear() === new Date(now).getFullYear()
      ? t("memoDateMonthDay", { month, day: date.getDate() })
      : t("memoDateWithYear", { year: date.getFullYear(), month, day: date.getDate() });
  return `${stamp} ${clock}`;
}

/** 列表用的一行计划摘要；无计划返回 null。 */
export function noteScheduleSummary(note: MemoNote, t: Translate): string | null {
  if (note.recurrence !== null) return formatRecurrenceText(note.recurrence, t);
  if (note.dueAt !== null) {
    return t("memoDueLabel", { time: formatMemoDue(note.dueAt, Date.now(), t) });
  }
  return null;
}

/** 频率下拉的可选值（"none" = 不重复）。 */
type FrequencyChoice = "none" | MemoRecurrenceFrequency;

/**
 * 计划设置行：截止时间 + 重复频率；选择重复后展开频率细节
 * （间隔 / 星期或每月几号 / 时刻）。
 */
export function MemoScheduleEditor({
  value,
  onChange,
}: {
  value: MemoScheduleValue;
  onChange: (next: MemoScheduleValue) => void;
}) {
  const t = useT();
  const rule = value.recurrence;
  const frequency: FrequencyChoice = rule?.frequency ?? "none";

  const inputClass =
    "h-7 min-w-0 rounded-md border border-border bg-transparent px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus";

  function setDue(next: string) {
    onChange({ ...value, dueAt: fromLocalInputValue(next) });
  }

  function setFrequency(next: FrequencyChoice) {
    onChange({ ...value, recurrence: next === "none" ? null : defaultRecurrence(next) });
  }

  function patchRule(partial: Partial<MemoRecurrence>) {
    if (!rule) return;
    onChange({ ...value, recurrence: { ...rule, ...partial } });
  }

  function toggleWeekday(day: number) {
    if (!rule) return;
    const has = rule.weekdays.includes(day);
    const weekdays = has
      ? rule.weekdays.filter((entry) => entry !== day)
      : [...rule.weekdays, day].sort((a, b) => a - b);
    // weekly 至少保留一个星期，避免产生非法规则。
    if (weekdays.length === 0) return;
    patchRule({ weekdays });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">{t("memoPlanSection")}</span>
        <input
          type="datetime-local"
          value={toLocalInputValue(value.dueAt)}
          onChange={(event) => setDue(event.target.value)}
          aria-label={t("memoPlanDue")}
          title={t("memoPlanDue")}
          data-testid="memo-schedule-due"
          className={`${inputClass} flex-1`}
        />
        <select
          value={frequency}
          onChange={(event) => setFrequency(event.target.value as FrequencyChoice)}
          aria-label={t("memoPlanRecurrence")}
          title={t("memoPlanRecurrence")}
          data-testid="memo-schedule-frequency"
          className={inputClass}
        >
          <option value="none">{t("memoPlanNone")}</option>
          <option value="daily">{t("memoPlanDaily")}</option>
          <option value="weekly">{t("memoPlanWeekly")}</option>
          <option value="monthly">{t("memoPlanMonthly")}</option>
        </select>
      </div>

      {rule && (
        <div className="flex flex-wrap items-center gap-2 pl-0.5">
          <span className="text-[11px] text-muted">{t("memoPlanInterval")}</span>
          <input
            type="number"
            min={1}
            max={365}
            value={rule.interval}
            onChange={(event) => {
              const next = Math.max(1, Math.min(365, Number(event.target.value) || 1));
              patchRule({ interval: next });
            }}
            aria-label={t("memoPlanInterval")}
            data-testid="memo-schedule-interval"
            className={`${inputClass} w-16`}
          />
          <span className="text-[11px] text-muted">
            {rule.frequency === "daily"
              ? t("memoPeriodUnitDay")
              : rule.frequency === "weekly"
                ? t("memoPeriodUnitWeek")
                : t("memoPeriodUnitMonth")}
          </span>

          {rule.frequency === "weekly" && (
            <span className="flex items-center gap-1">
              {WEEKDAY_KEYS.map((key, index) => {
                const day = index + 1;
                const active = rule.weekdays.includes(day);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    aria-pressed={active}
                    title={t(key)}
                    className={`h-6 shrink-0 rounded px-1.5 text-[11px] transition-colors ${
                      active
                        ? "bg-nav-active text-nav-active-foreground"
                        : "text-muted hover:bg-surface-overlay hover:text-foreground"
                    }`}
                  >
                    {t(key)}
                  </button>
                );
              })}
            </span>
          )}

          {rule.frequency === "monthly" && (
            <>
              <span className="text-[11px] text-muted">{t("memoPlanMonthDay")}</span>
              <input
                type="number"
                min={1}
                max={31}
                value={rule.monthDay ?? 1}
                onChange={(event) => {
                  const next = Math.max(1, Math.min(31, Number(event.target.value) || 1));
                  patchRule({ monthDay: next });
                }}
                aria-label={t("memoPlanMonthDay")}
                data-testid="memo-schedule-monthday"
                className={`${inputClass} w-16`}
              />
            </>
          )}

          <span className="text-[11px] text-muted">{t("memoPlanTime")}</span>
          <input
            type="time"
            value={rule.time}
            onChange={(event) => patchRule({ time: event.target.value || "09:00" })}
            aria-label={t("memoPlanTime")}
            data-testid="memo-schedule-time"
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
}
