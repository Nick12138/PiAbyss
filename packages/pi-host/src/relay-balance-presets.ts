/**
 * 内置余额预设（纯提取逻辑，无网络）。
 *
 * 覆盖 new-api 默认端点解析不了的官方厂商（端点/字段/单位各不相同）。
 * 提取器拿到端点响应，返回账户原生币种的余额（不折算，前端按币种显示）；
 * 响应形态不符返回 null，由调用方回退下一优先级
 * （new-api 默认 → /v1/usage 形态兜底）。
 *
 * 预设优先级：映射表 > 域名预设 > new-api 默认 > 形态兜底。
 */

export type RelayBalanceCurrency = "USD" | "CNY";

export type RelayBalanceExtraction = {
  /** 账户原生币种的剩余余额（不折算）。 */
  remaining: number;
  used?: number;
  currency: RelayBalanceCurrency;
};

export type RelayBalanceExtractor = (payload: unknown) => RelayBalanceExtraction | null;

/** 数字或数字字符串 → number（DeepSeek 实测 total_balance 是 "6.18"）。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** DeepSeek 官方：GET /user/balance → balance_infos[].{currency, total_balance}。 */
export function extractDeepSeekBalance(payload: unknown): RelayBalanceExtraction | null {
  if (!isObject(payload) || !Array.isArray(payload.balance_infos)) return null;
  const valid = payload.balance_infos.filter(
    (item: unknown) => isObject(item) && toNumber(item.total_balance) !== null,
  );
  if (valid.length === 0) return null;
  // 多币种条目时优先 USD；否则取第一条（DeepSeek 主账户币种）。
  const entry =
    valid.find((item) => (item as { currency?: unknown }).currency === "USD") ?? valid[0]!;
  const balance = toNumber((entry as { total_balance: unknown }).total_balance);
  if (balance === null) return null;
  // currency 字段即账户币种（"CNY"/"USD"），原样保留，不折算。
  const currency: RelayBalanceCurrency =
    (entry as { currency?: unknown }).currency === "CNY" ? "CNY" : "USD";
  return { remaining: balance, currency };
}

/** OpenRouter：GET /api/v1/credits → data.total_credits − data.total_usage。 */
export function extractOpenRouterBalance(payload: unknown): RelayBalanceExtraction | null {
  if (!isObject(payload) || !isObject(payload.data)) return null;
  const credits = toNumber(payload.data.total_credits);
  if (credits === null) return null;
  const usage = toNumber(payload.data.total_usage);
  return {
    remaining: credits - (usage ?? 0),
    used: usage ?? 0,
    currency: "USD",
  };
}

/** NingYi 式网关形态：GET /v1/usage 顶层数字 balance（响应 unit 字段即币种）。 */
export function extractUsageShapeBalance(payload: unknown): RelayBalanceExtraction | null {
  if (!isObject(payload) || typeof payload.balance !== "number") return null;
  const usage = isObject(payload.usage) ? toNumber(payload.usage.total_cost) : null;
  const currency: RelayBalanceCurrency = payload.unit === "CNY" ? "CNY" : "USD";
  return { remaining: payload.balance, used: usage ?? 0, currency };
}

/**
 * 域名预设表：主域（relayMainDomain 语义）→ 端点 + 提取器。
 * 依次尝试，形态不符/不可达由调用方回退。
 */
export const RELAY_BALANCE_PRESETS: Array<{
  domain: string;
  path: string;
  extract: RelayBalanceExtractor;
}> = [
  { domain: "deepseek.com", path: "/user/balance", extract: extractDeepSeekBalance },
  { domain: "openrouter.ai", path: "/api/v1/credits", extract: extractOpenRouterBalance },
];
