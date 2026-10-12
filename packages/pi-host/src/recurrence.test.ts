/**
 * recurrence.ts 的规则校验与发生时刻计算测试。
 * 时区固定 Asia/Shanghai（UTC+8，无 DST），便于用固定 epoch 断言。
 */
import { describe, expect, it } from "vitest";
import { nextOccurrence, normalizeRecurrence, type MemoRecurrence } from "./recurrence.js";

/** Asia/Shanghai 本地时刻 → epoch ms。 */
function shanghai(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function rule(
  partial: Partial<MemoRecurrence> & Pick<MemoRecurrence, "frequency">,
): MemoRecurrence {
  return {
    interval: 1,
    weekdays: [],
    monthDay: null,
    time: "09:00",
    tz: "Asia/Shanghai",
    until: null,
    startDate: null,
    ...partial,
  };
}

describe("normalizeRecurrence", () => {
  it("fills defaults and clears non-matching fields", () => {
    expect(normalizeRecurrence({ frequency: "daily", time: "08:30" })).toEqual({
      frequency: "daily",
      interval: 1,
      weekdays: [],
      monthDay: null,
      time: "08:30",
      tz: "Asia/Shanghai",
      until: null,
      startDate: null,
    });
  });

  it("dedupes and sorts weekdays for weekly", () => {
    expect(
      normalizeRecurrence({ frequency: "weekly", weekdays: [5, 1, 5], time: "10:00" }),
    ).toMatchObject({ weekdays: [1, 5] });
  });

  it("rejects invalid input", () => {
    expect(() => normalizeRecurrence({ frequency: "yearly", time: "09:00" })).toThrow();
    expect(() => normalizeRecurrence({ frequency: "weekly", time: "09:00" })).toThrow(/weekdays/);
    expect(() => normalizeRecurrence({ frequency: "monthly", time: "09:00" })).toThrow(/monthDay/);
    expect(() => normalizeRecurrence({ frequency: "daily", time: "25:00" })).toThrow(/time/);
  });
});

describe("nextOccurrence", () => {
  it("advances daily to the next day within the rule timezone", () => {
    const after = shanghai(2026, 1, 5, 10, 0); // 2026-01-05 10:00
    expect(nextOccurrence(rule({ frequency: "daily" }), after, after)).toBe(
      shanghai(2026, 1, 6, 9, 0),
    );
  });

  it("skips to the next matching weekday for weekly (2026-01-05 is Monday)", () => {
    const after = shanghai(2026, 1, 5, 14, 0); // 周一 14:00，已过当天 13:00
    const weekly = rule({ frequency: "weekly", weekdays: [1], time: "13:00" });
    expect(nextOccurrence(weekly, after, after)).toBe(shanghai(2026, 1, 12, 13, 0));
  });

  it("aligns interval=2 weeks to the anchor week", () => {
    const anchor = shanghai(2026, 1, 5, 9, 0); // 第 0 周（周一）
    const after = shanghai(2026, 1, 6, 9, 0); // 第 0 周周二
    const biweekly = rule({ frequency: "weekly", weekdays: [1], time: "09:00", interval: 2 });
    // 第 1 周被跳过，落到第 2 周的周一。
    expect(nextOccurrence(biweekly, after, anchor)).toBe(shanghai(2026, 1, 19, 9, 0));
  });

  it("skips months without the requested day (31st)", () => {
    const anchor = shanghai(2026, 1, 31, 9, 0);
    const after = shanghai(2026, 1, 31, 10, 0);
    const monthly = rule({ frequency: "monthly", monthDay: 31, time: "09:00" });
    // 2 月没有 31 号 → 跳到 3 月 31 日。
    expect(nextOccurrence(monthly, after, anchor)).toBe(shanghai(2026, 3, 31, 9, 0));
  });

  it("treats until as inclusive and terminates afterwards", () => {
    const until = shanghai(2026, 1, 7, 9, 0);
    const daily = rule({ frequency: "daily", until });
    // 严格晚于 after 且不晚于 until：1/7 09:00 恰好等于 until，仍然产生。
    expect(nextOccurrence(daily, shanghai(2026, 1, 6, 10, 0), 0)).toBe(until);
    // after 已达 until 本身 → 无未来发生时刻。
    expect(nextOccurrence(daily, until, 0)).toBeNull();
  });
});
