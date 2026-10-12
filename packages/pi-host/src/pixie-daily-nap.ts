/**
 * 每日自动打盹（daily nap）。
 *
 * 目标：让小精灵每天自动换一个干净会话段，但**不按钟点**判定——00:00 硬切会把
 * 「跨午夜连着做的一件工作」劈成两天。这里用「用你自己的睡眠分隔天」：
 *
 *   日界 = 上次活动在本地日历日的**前一天** 且 静默时长 ≥ 自适应阈值
 *
 * 两层判据：
 * - 硬门槛：段内已有 ≥1 轮用户消息、会话不在流式中、距上次打盹 ≥ 最小间隔；
 * - 主判据：跨日（localDayKey(lastActivityAt) ≠ localDayKey(now)）且
 *   now - lastActivityAt ≥ clamp(max(下限, 历史静默间隔 P75 × 2), 下限, 上限)。
 *
 * 自适应阈值只在样本足够（≥8 条）时启用，并夹在 [下限, 上限] 之间：下限挡住
 * 「跨午夜但只隔半小时」的误切，上限保证「每天只聊一两次」的用户当天也能睡到，
 * 不会被自己的历史 P75 抬到永远够不着。
 *
 * 本模块是纯逻辑（不碰 fs / 不碰 SDK），便于单测；落盘与接线在 pixie-agent-runner。
 */

export type DailyNapConfig = {
  enabled: boolean;
  /** 静默多久算「睡了一觉」（同时是自适应阈值下限）。 */
  minGapMs: number;
  /** 自适应阈值上限。 */
  maxGapMs: number;
  /** 两次打盹之间的最小间隔（防止一天睡两次）。 */
  minIntervalMs: number;
};

export const DAILY_NAP_DEFAULTS = {
  minGapMs: 3 * 60 * 60 * 1000,
  maxGapMs: 12 * 60 * 60 * 1000,
  minIntervalMs: 18 * 60 * 60 * 1000,
} as const;

/**
 * 读取配置：**只有一个开关**（`PIABYSS_PIXIE_DAILY_NAP`）。
 *
 * 三个阈值是内置常量，不对外暴露：自适应阈值本身已经按用户作息调整，再挂手工旋钮
 * 就是两套机制打架——用户把下限设成 3h，实际生效的却是 max(3h, P75×2)，只会让人
 * 困惑"我设了怎么不睡"。要调阈值请直接改 DAILY_NAP_DEFAULTS。
 */
export function resolveDailyNapConfig(env: NodeJS.ProcessEnv = process.env): DailyNapConfig {
  const flag = env.PIABYSS_PIXIE_DAILY_NAP?.trim().toLowerCase();
  const enabled = !(flag === "off" || flag === "0" || flag === "false");
  return { enabled, ...DAILY_NAP_DEFAULTS };
}

/**
 * 本地日历日键（YYYY-MM-DD，按本机时区；跨时区/夏令时不会错切）。
 * 注意：pixie-usage.ts 有一个同义实现——那边被 runner 依赖，这里独立实现以免成环。
 */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 历史静默间隔的 P75；样本不足 8 条时不启用自适应。 */
export function percentile75(samples: number[]): number | null {
  const clean = samples
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (clean.length < 8) return null;
  const index = Math.min(clean.length - 1, Math.floor(clean.length * 0.75));
  return clean[index]!;
}

/** 自适应静默阈值：max(下限, P75×2)，夹在 [下限, 上限]。 */
export function adaptiveGapMs(samples: number[], config: DailyNapConfig): number {
  const p75 = percentile75(samples);
  const raw = p75 === null ? config.minGapMs : Math.max(config.minGapMs, p75 * 2);
  return Math.min(Math.max(raw, config.minGapMs), config.maxGapMs);
}

export type DailyNapReason =
  | "daily-idle"
  | "disabled"
  | "streaming"
  | "empty-segment"
  | "no-activity"
  | "too-soon"
  | "not-next-day"
  | "not-idle-enough";

export type DailyNapDecision =
  | { nap: true; reason: "daily-idle"; gapMs: number; thresholdMs: number }
  | { nap: false; reason: Exclude<DailyNapReason, "daily-idle"> };

export type DailyNapInput = {
  now: number;
  /** 最后一次用户侧活动时间（跨段沿用；null/0 = 无记录）。 */
  lastActivityAt: number | null;
  /** 上次打盹时间（防一天两睡）。 */
  lastNapAt: number | null;
  /** 当前段已注入的用户消息数（0 = 空段，不睡）。 */
  turnsInCurrentSegment: number;
  /** 会话是否正在生成（不打断）。 */
  streaming: boolean;
  /** 历史静默间隔样本（毫秒）。 */
  idleSamples: number[];
  config?: DailyNapConfig;
};

export function shouldDailyNap(input: DailyNapInput): DailyNapDecision {
  const config = input.config ?? resolveDailyNapConfig();
  if (!config.enabled) return { nap: false, reason: "disabled" };
  if (input.streaming) return { nap: false, reason: "streaming" };
  if (input.turnsInCurrentSegment < 1) return { nap: false, reason: "empty-segment" };
  const lastActivityAt = input.lastActivityAt;
  if (!lastActivityAt || lastActivityAt <= 0 || lastActivityAt > input.now) {
    return { nap: false, reason: "no-activity" };
  }
  if (input.lastNapAt && input.now - input.lastNapAt < config.minIntervalMs) {
    return { nap: false, reason: "too-soon" };
  }
  if (localDayKey(lastActivityAt) === localDayKey(input.now)) {
    return { nap: false, reason: "not-next-day" };
  }
  const gapMs = input.now - lastActivityAt;
  const thresholdMs = adaptiveGapMs(input.idleSamples, config);
  if (gapMs < thresholdMs) return { nap: false, reason: "not-idle-enough" };
  return { nap: true, reason: "daily-idle", gapMs, thresholdMs };
}

/** 每日打盹短语池：按本地时段挑，跟午睡的分隔文案区分开。 */
const DAILY_NAP_PHRASES: Record<"morning" | "afternoon" | "night", string[]> = {
  morning: ["天亮了，新的一天开工~", "早上好，我先换一副新身子", "睡醒了，昨天那些都归档啦"],
  afternoon: ["午后换段，前面那堆先收起来", "歇一小会儿，翻篇继续聊"],
  night: ["夜深了，今天就到这儿", "今天先存档，明天接着聊", "晚安，明天见~"],
};

export function dailyNapPhrase(now: number): string {
  const hour = new Date(now).getHours();
  const bucket =
    hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 22 ? "afternoon" : "night";
  const pool = DAILY_NAP_PHRASES[bucket];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function truncate(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export type DailyNapHandoffInput = {
  /** 上一段最后一条小精灵回复（取摘要，不存全文）。 */
  lastAssistantText: string | null;
  /** 还没有终态回音的委派。 */
  unfinishedDispatches: { task: string; status: string }[];
  /** 备忘录里未完成的标题。 */
  openMemoTitles: string[];
};

/**
 * 规则拼一份「换段交接」—— 每日打盹是硬切，必须留话（不像 rollover 那样空手换段）。
 * 不为此再起一次模型调用：只用现有信息拼三行，一行都没有就返回 null。
 */
export function composeDailyNapHandoff(input: DailyNapHandoffInput): string | null {
  const lines: string[] = [];
  const tail = input.lastAssistantText ? truncate(input.lastAssistantText, 160) : "";
  if (tail) lines.push(`上一段最后聊到：${tail}`);
  if (input.unfinishedDispatches.length > 0) {
    const items = input.unfinishedDispatches
      .slice(0, 3)
      .map((item) => `${truncate(item.task, 40)}（${item.status}）`)
      .join("；");
    lines.push(`还没回音的委派：${items}`);
  }
  if (input.openMemoTitles.length > 0) {
    const items = input.openMemoTitles
      .slice(0, 3)
      .map((title) => truncate(title, 30))
      .join("；");
    lines.push(`备忘录未完成：${items}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
