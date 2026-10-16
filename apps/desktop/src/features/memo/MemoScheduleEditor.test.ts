import { describe, expect, it } from "vitest";
import type { Translate } from "../../lib/i18n/use-t";
import { formatMemoDue } from "./MemoScheduleEditor";

/**
 * 计划时刻的口语写法：今天 / 昨天 / 明天，同年其余「10月18日」，跨年才补年份。
 * 只喂一份中文词典，断言的是选哪条文案 + 拼出来的样子，不依赖 i18n 模块。
 */
const ZH: Record<string, string> = {
  memoDayToday: "今天",
  memoDayYesterday: "昨天",
  memoDayTomorrow: "明天",
  memoDateMonthDay: "{month}月{day}日",
  memoDateWithYear: "{year}年{month}月{day}日",
};

const t: Translate = (key, params) =>
  (ZH[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));

const NOW = new Date(2026, 9, 16, 14, 30).getTime();
const at = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month, day, hour, minute).getTime();

describe("formatMemoDue", () => {
  it("今天 / 昨天 / 明天只看日历日，不看时刻差", () => {
    expect(formatMemoDue(at(9, 16, 9, 20), NOW, t)).toBe("今天 09:20");
    expect(formatMemoDue(at(9, 15, 23, 59), NOW, t)).toBe("昨天 23:59");
    expect(formatMemoDue(at(9, 17, 0, 5), NOW, t)).toBe("明天 00:05");
  });

  it("跨月、跨年也按自然日算，隔 7 个半小时同样是「明天」", () => {
    const halloween = new Date(2026, 9, 31, 23, 0).getTime();
    expect(formatMemoDue(at(10, 1, 6, 30), halloween, t)).toBe("明天 06:30");
  });

  it("其余日期同年省年份，跨年才补年份", () => {
    expect(formatMemoDue(at(9, 18, 9, 20), NOW, t)).toBe("10月18日 09:20");
    expect(formatMemoDue(at(8, 30, 8, 0), NOW, t)).toBe("9月30日 08:00");
    expect(formatMemoDue(new Date(2027, 0, 5, 8, 0).getTime(), NOW, t)).toBe("2027年1月5日 08:00");
  });

  it("非法时间戳给空串，让调用方省掉整段", () => {
    expect(formatMemoDue(Number.NaN, NOW, t)).toBe("");
  });
});
