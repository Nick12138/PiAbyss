/**
 * 内置余额预设（纯提取逻辑，无网络）。
 *
 * 覆盖 new-api 默认端点解析不了的官方厂商（端点/字段/单位各不相同）。
 * 提取器拿到端点响应，返回美元余额；响应形态不符返回 null，
 * 由调用方回退下一优先级（new-api 默认 → /v1/usage 形态兜底）。
 *
 * 预设优先级：映射表 > 域名预设 > new-api 默认 > 形态兜底。
 */

export type RelayBalanceExtraction = {
  remainingUsd: number;
  totalUsageUsd?: number;
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
  const usd = payload.balance_infos.find(
    (entry: unknown) => isObject(entry) && entry.currency === "USD",
  );
  const usdBalance = isObject(usd) ? toNumber(usd.total_balance) : null;
  if (usdBalance !== null) return { remainingUsd: usdBalance };
  // 人民币主账户：按固定汇率折算成美元展示（仅显示用）。
  const cny = payload.balance_infos.find(
    (entry: unknown) => isObject(entry) && entry.currency === "CNY",
  );
  const cnyBalance = isObject(cny) ? toNumber(cny.total_balance) : null;
  return cnyBalance !== null ? { remainingUsd: cnyBalance / 7.2 } : null;
}

/** OpenRouter：GET /api/v1/credits → data.total_credits − data.total_usage。 */
export function extractOpenRouterBalance(payload: unknown): RelayBalanceExtraction | null {
  if (!isObject(payload) || !isObject(payload.data)) return null;
  const credits = toNumber(payload.data.total_credits);
  if (credits === null) return null;
  const usage = toNumber(payload.data.total_usage);
  return {
    remainingUsd: credits - (usage ?? 0),
    totalUsageUsd: usage ?? 0,
  };
}

/** NingYi 式网关形态：GET /v1/usage 顶层数字 balance（已是美元）。 */
export function extractUsageShapeBalance(payload: unknown): RelayBalanceExtraction | null {
  if (!isObject(payload) || typeof payload.balance !== "number") return null;
  const usage = isObject(payload.usage) ? toNumber(payload.usage.total_cost) : null;
  return {
    remainingUsd: payload.balance,
    totalUsageUsd: usage ?? 0,
  };
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
