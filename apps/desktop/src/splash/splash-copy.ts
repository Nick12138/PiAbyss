/**
 * 开屏小窗的文案。
 *
 * 刻意不放进 `lib/i18n`：那份词表约 220KB，而开屏必须在 Host 起来之前完成
 * 首帧——这里只要这几十行，包体差三个数量级。
 *
 * 开屏只显示叙事化轮播文案，不显示「正在启动 Pi Host」这类阶段提示：
 * 开屏期间用户无事可做，与其给一行技术性的状态，不如给点有温度的东西。
 * 阶段本身仍然被跟踪——它决定进度条何时收尾、轮播何时停下。
 *
 * 文案围绕产品本身写，不引入任何拟人设定：PiAbyss 是 Pi Coding Agent 的桌面
 * 工作空间，没有「她 / Ta」这样的角色。意象全部来自名字里的 Abyss（深渊）
 * 与它实际在做的事——上下文层层沉淀、会话跨项目累积、上次离开的地方可以
 * 原样接着走。语气克制，不卖萌也不煽情：这是给写代码的人看的。
 */

export type Locale = "zh" | "en";

/** 与主窗口 `StartupStage` 同一套词表；开屏只需要「启动期间真会出现」的这几个。 */
export type SplashStage =
  | "preparing"
  | "starting-host"
  | "restoring-workspace"
  | "restoring-session"
  | "reconnecting"
  | "ready";

/**
 * 阶段只许前进。Rust 先广播 `starting-host`，主窗口随后推它自己算出的
 * `resolveStartupStage` 结果——两者在交界处可能「回退」（主窗口刚挂载时
 * desktopSettings 还没到，算出来仍是 `preparing`）。没有这道单调闸门，
 * 文案会在开屏上闪一下旧值。
 */
export const STAGE_RANK: Record<SplashStage, number> = {
  preparing: 0,
  "starting-host": 1,
  "restoring-workspace": 2,
  "restoring-session": 3,
  reconnecting: 4,
  ready: 5,
};

/** 轮播间隔：3 秒一条，留出读完一句的时间。
 *  注意它与 `MIN_SPLASH_VISIBLE_MS`（Rust 侧，同为 3000ms）刚好相等——
 *  也就是说**启动快的时候用户只会看到第一句**，轮播要等启动慢时才显出来。
 *  这是有意接受的取舍：宁可让多数启动保持安静，也不要为了「秀轮播」把一句
 *  话切得读不完。想让轮播更容易被看到，把 Rust 的保底时长调到 6s 即可。 */
export const NARRATIVE_INTERVAL_MS = 3_000;
/** 淡出时长；与 CSS `.splash-narrative` 的 transition 必须一致。 */
export const NARRATIVE_FADE_MS = 420;

export const NARRATIVE: Record<Locale, readonly string[]> = {
  zh: [
    "越往下，越安静",
    "上下文一层层沉下去，成了底",
    "会话叠着会话，就有了深度",
    "上次离开的地方，还亮着",
    "光标停在半句上，等你回来",
    "工具跑过的地方，都留了痕",
    "把想法放下去，先去做别的",
    "深处没有回声，只有结果",
    "从断掉的那一句接着写",
    "沉到底的，都是有用的",
  ],
  en: [
    "The deeper you go, the quieter it gets",
    "Context settles, layer by layer, into bedrock",
    "Sessions stack on sessions — that is where depth comes from",
    "The place you left is still lit",
    "A cursor waits mid-sentence for your return",
    "Everything the tools touched left a mark",
    "Drop the thought in, then go do something else",
    "Down here there is no echo, only results",
    "Pick up from the sentence that broke off",
    "Whatever sinks all the way down is worth keeping",
  ],
};

export function isSplashStage(value: unknown): value is SplashStage {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STAGE_RANK, value);
}

/** 与主窗口 `resolveLocale(undefined)` 同一条回落规则：跟随系统语言。 */
export function systemLocale(): Locale {
  const language = typeof navigator !== "undefined" ? (navigator.language ?? "") : "";
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 洗牌。开场顺序随机，避免每次启动都从同一句开始。 */
export function shuffled<T>(items: readonly T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}
