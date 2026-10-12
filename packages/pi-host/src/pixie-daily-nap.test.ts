/**
 * 每日自动打盹判定（v4.4）：日界由「跨日 + 静默时长」决定，不由钟点决定。
 * 覆盖用户拍板要防止的几种误判/漏判。
 */
import { describe, expect, it } from "vitest";
import {
  DAILY_NAP_DEFAULTS,
  adaptiveGapMs,
  composeDailyNapHandoff,
  dailyNapPhrase,
  localDayKey,
  percentile75,
  resolveDailyNapConfig,
  shouldDailyNap,
  type DailyNapConfig,
} from "./pixie-daily-nap.js";

const CONFIG: DailyNapConfig = {
  enabled: true,
  minGapMs: DAILY_NAP_DEFAULTS.minGapMs,
  maxGapMs: DAILY_NAP_DEFAULTS.maxGapMs,
  minIntervalMs: DAILY_NAP_DEFAULTS.minIntervalMs,
};

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const HOUR = 3_600_000;

function decide(over: Partial<Parameters<typeof shouldDailyNap>[0]> = {}) {
  return shouldDailyNap({
    now: at(2026, 10, 13, 9, 0),
    lastActivityAt: at(2026, 10, 12, 23, 0),
    lastNapAt: null,
    turnsInCurrentSegment: 5,
    streaming: false,
    idleSamples: [],
    config: CONFIG,
    ...over,
  });
}

describe("每日打盹 — 日界判定", () => {
  it("真正隔夜（昨晚 23:00 → 今早 9:00）→ 打盹", () => {
    const out = decide();
    expect(out.nap).toBe(true);
    expect(out.nap && out.reason).toBe("daily-idle");
  });

  it("跨了午夜但只隔 30 分钟（23:50 → 00:20）→ 不切，同一段工作", () => {
    const out = decide({
      now: at(2026, 10, 13, 0, 20),
      lastActivityAt: at(2026, 10, 12, 23, 50),
    });
    expect(out).toEqual({ nap: false, reason: "not-idle-enough" });
  });

  it("同一天内长静默（下午消失 5 小时）→ 不算新的一天", () => {
    const out = decide({
      now: at(2026, 10, 12, 20, 0),
      lastActivityAt: at(2026, 10, 12, 15, 0),
    });
    expect(out).toEqual({ nap: false, reason: "not-next-day" });
  });

  it("空段（今天还没说过话）→ 不睡，防连打两次", () => {
    expect(decide({ turnsInCurrentSegment: 0 })).toEqual({ nap: false, reason: "empty-segment" });
  });

  it("会话正在生成 → 不打断", () => {
    expect(decide({ streaming: true })).toEqual({ nap: false, reason: "streaming" });
  });

  it("距上次打盹不足最小间隔（一天两睡）→ 不睡", () => {
    expect(decide({ lastNapAt: at(2026, 10, 13, 7, 0) })).toEqual({
      nap: false,
      reason: "too-soon",
    });
  });

  it("没有活动记录 / 时间倒挂 → 不睡", () => {
    expect(decide({ lastActivityAt: null })).toEqual({ nap: false, reason: "no-activity" });
    expect(decide({ lastActivityAt: 0 })).toEqual({ nap: false, reason: "no-activity" });
    expect(decide({ lastActivityAt: at(2026, 10, 14, 9, 0) })).toEqual({
      nap: false,
      reason: "no-activity",
    });
  });

  it("开关关掉 → 不睡", () => {
    expect(decide({ config: { ...CONFIG, enabled: false } })).toEqual({
      nap: false,
      reason: "disabled",
    });
  });
});

describe("每日打盹 — 自适应阈值", () => {
  it("样本不足 8 条 → 用下限", () => {
    expect(percentile75([HOUR, 2 * HOUR])).toBeNull();
    expect(adaptiveGapMs([HOUR, 2 * HOUR], CONFIG)).toBe(CONFIG.minGapMs);
  });

  it("夜猫子画像（P75×2 高于下限）→ 阈值随之上抬", () => {
    const samples = Array.from({ length: 10 }, (_, index) => (index + 1) * HOUR);
    expect(percentile75(samples)).toBe(8 * HOUR);
    expect(adaptiveGapMs(samples, CONFIG)).toBe(
      16 * HOUR > CONFIG.maxGapMs ? CONFIG.maxGapMs : 16 * HOUR,
    );
  });

  it("阈值被上限兜住：每天只聊一次的用户当天仍能睡到", () => {
    const samples = Array.from({ length: 12 }, () => 20 * HOUR);
    expect(adaptiveGapMs(samples, CONFIG)).toBe(CONFIG.maxGapMs);
    // 昨晚 23:00 → 今早 9:00 只有 10h，被 12h 上限挡下（再晚一点就会睡）
    expect(decide({ idleSamples: samples }).nap).toBe(false);
    expect(decide({ now: at(2026, 10, 13, 12, 0), idleSamples: samples }).nap).toBe(true);
  });

  it("localDayKey 按本地日切分", () => {
    expect(localDayKey(at(2026, 10, 12, 23, 59))).toBe("2026-10-12");
    expect(localDayKey(at(2026, 10, 13, 0, 1))).toBe("2026-10-13");
  });
});

describe("每日打盹 — 配置与短语", () => {
  it("默认配置：3h 下限 / 12h 上限 / 18h 最小间隔", () => {
    const config = resolveDailyNapConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.minGapMs).toBe(3 * HOUR);
    expect(config.maxGapMs).toBe(12 * HOUR);
    expect(config.minIntervalMs).toBe(18 * HOUR);
  });

  it("只有一个开关可配；三个阈值走内置常量（不受环境变量影响）", () => {
    const config = resolveDailyNapConfig({
      PIABYSS_PIXIE_DAILY_NAP: "off",
      PIABYSS_PIXIE_NAP_IDLE_MS: String(2 * HOUR),
      PIABYSS_PIXIE_NAP_MAX_GAP_MS: String(8 * HOUR),
      PIABYSS_PIXIE_NAP_MIN_HOURS: "6",
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      enabled: false,
      minGapMs: 3 * HOUR,
      maxGapMs: 12 * HOUR,
      minIntervalMs: 18 * HOUR,
    });
  });

  it("短语按时段挑：早上/午后/深夜各不相同", () => {
    const morning = [
      "天亮了，新的一天开工~",
      "早上好，我先换一副新身子",
      "睡醒了，昨天那些都归档啦",
    ];
    const night = ["夜深了，今天就到这儿", "今天先存档，明天接着聊", "晚安，明天见~"];
    expect(morning).toContain(dailyNapPhrase(at(2026, 10, 13, 9, 0)));
    expect(night).toContain(dailyNapPhrase(at(2026, 10, 13, 2, 0)));
  });
});

describe("每日打盹 — 交接摘要（硬切也要留话）", () => {
  it("什么都没有 → null", () => {
    expect(
      composeDailyNapHandoff({
        lastAssistantText: null,
        unfinishedDispatches: [],
        openMemoTitles: [],
      }),
    ).toBeNull();
  });

  it("拼出三行：上段尾巴 + 未回音委派 + 备忘录未完成", () => {
    const handoff = composeDailyNapHandoff({
      lastAssistantText: "已把三个工作区的巡检跑完\n还差乐山那个没回音",
      unfinishedDispatches: [{ task: "查一下门店数量", status: "dispatched" }],
      openMemoTitles: ["废钢项目响应文件"],
    });
    expect(handoff).toBe(
      [
        "上一段最后聊到：已把三个工作区的巡检跑完 还差乐山那个没回音",
        "还没回音的委派：查一下门店数量（dispatched）",
        "备忘录未完成：废钢项目响应文件",
      ].join("\n"),
    );
  });

  it("超长文本截断，不把全文塞进交接", () => {
    const handoff = composeDailyNapHandoff({
      lastAssistantText: "长".repeat(400),
      unfinishedDispatches: [],
      openMemoTitles: [],
    });
    expect(handoff).not.toBeNull();
    expect(handoff!.length).toBeLessThan(200);
    expect(handoff!.endsWith("…")).toBe(true);
  });
});
