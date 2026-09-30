/**
 * 中转站（new-api / one-api 风格网关）价格/余额控制器。
 *
 * 第一版仅适配 new-api 风格的公开接口：
 *   - GET {base}/api/pricing                        无需鉴权：分组倍率 + 模型倍率
 *   - GET {base}/v1/models                          需 key：key 可用模型列表
 *   - GET {base}/v1/dashboard/billing/subscription  需 key：hard_limit_usd
 *   - GET {base}/v1/dashboard/billing/usage         需 key：total_usage
 *
 * 计价公式（与各站页面口径一致）：
 *   输入价 = $2 × model_ratio × group_ratio / 1M tokens
 *   输出价 = 输入价 × completion_ratio；缓存价 = 输入价 × cache_ratio
 *   quota_type ≠ 0 时按次计费：call_price = model_price × group_ratio
 *
 * 网络：全局 fetch 已由 network-bootstrap 安装 EnvHttpProxyAgent，自动走代理。
 * 所有出网错误信息经 providerSensitiveValues 脱敏后返回。
 * 只读出网不取 graph 锁（与 provider.checkConnection 同策略）。
 */
import { join } from "node:path";
import type {
  RelayBalance,
  RelayEndpointMapping,
  RelayFieldMap,
  RelayFieldMapping,
  RelayMappingHandoffResult,
  RelayMappingPickerResult,
  RelayMappingResult,
  RelayMappingSetParams,
  RelayPricingFetchParams,
  RelayPricingGroup,
  RelayPricingResult,
  RelayPricingRow,
  RelayPricingStation,
  RelayRechargeRatio,
} from "@piabyss/protocol";
import { createHostError } from "@piabyss/protocol";
import type { MethodHandler, PiHostServer } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { logger } from "./logger.js";
import { isObject, readModelsConfig, type JsonObject } from "./provider-models-config.js";
import { RelayPricingStore, UNLIMITED_LIMIT_USD } from "./relay-pricing-store.js";
import {
  extractUsageShapeBalance,
  RELAY_BALANCE_PRESETS,
  type RelayBalanceExtraction,
} from "./relay-balance-presets.js";
import {
  normalizeRelayBaseUrl,
  RelayMappingStore,
  relayMainDomain,
} from "./relay-mapping-store.js";
import {
  applyBalanceMapping,
  applyModelsMapping,
  applyPricingMapping,
  balanceFromMapping,
  descriptionEntries,
  groupRatioEntries,
  resolveEndpoint,
  stringSetEntries,
} from "./relay-field-mapping.js";

/** 基准价：new-api 体系下 model_ratio=1、group_ratio=1 时的输入价（$/1M）。 */
const BASE_PRICE_PER_1M = 2;

const FETCH_TIMEOUT_MS = 15_000;

/** 识别一个 provider 是否为可抓取的中转站：baseUrl 为 http(s) 即可尝试。 */
function isRelayProvider(raw: JsonObject): boolean {
  const baseUrl = raw.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function relayErrorMessage(error: unknown, sensitiveValues: string[]): string {
  let message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  for (const value of sensitiveValues) {
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function relaySensitiveValues(apiKey: string | undefined): string[] {
  return apiKey ? [apiKey] : [];
}

/**
 * 按 baseUrl 主域找内置预设端点并尝试提取；
 * 不命中（域名不匹配 / 响应形态不符）返回 null，调用方回退 new-api 默认。
 */
async function tryBalancePreset(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<RelayBalanceExtraction | null> {
  const domain = relayMainDomain(baseUrl);
  if (!domain) return null;
  const preset = RELAY_BALANCE_PRESETS.find((entry) => entry.domain === domain);
  if (!preset) return null;
  try {
    const payload = await fetchJson(
      `${newApiBase(baseUrl)}${preset.path}`,
      { Authorization: `Bearer ${apiKey}` },
      signal,
    );
    return preset.extract(payload);
  } catch {
    // 端点不可达/形态不符：回退 new-api 默认。
    return null;
  }
}

/** 预设/兜底探测提取结果 → 标准 RelayBalance 成功快照。 */
function balanceFromExtracted(
  stationId: string,
  extracted: RelayBalanceExtraction,
  fetchedAt: string,
): RelayBalance {
  const totalUsageUsd = extracted.used ?? 0;
  const unlimited = extracted.remaining >= UNLIMITED_LIMIT_USD;
  return {
    stationId,
    hardLimitUsd: extracted.remaining + totalUsageUsd,
    totalUsageUsd,
    remainingUsd: unlimited ? null : extracted.remaining,
    unlimited,
    ...(extracted.currency === "CNY" ? { currency: "CNY" as const } : {}),
    fetchedAt,
    ok: true,
  };
}

async function probeUsageShapeBalance(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<RelayBalanceExtraction | null> {
  try {
    const payload = await fetchJson(
      `${newApiBase(baseUrl)}/v1/usage`,
      { Authorization: `Bearer ${apiKey}` },
      signal,
    );
    return extractUsageShapeBalance(payload);
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url} returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const detail =
      isObject(payload) && isObject(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : isObject(payload) && typeof payload.message === "string"
          ? payload.message
          : response.statusText;
    throw new Error(`${url} returned HTTP ${response.status}: ${detail}`);
  }
  return payload;
}

type RawPricing = {
  data?: unknown[];
  group_ratio?: unknown;
  usable_group?: unknown;
  auto_groups?: unknown;
  vendors?: unknown;
  media_pricing?: unknown[];
};

type RawPricingModel = {
  model_name: string;
  vendor_name?: string;
  quota_type?: number;
  model_ratio?: number;
  model_price?: number;
  completion_ratio?: number;
  cache_ratio?: number;
  enable_groups?: unknown;
  supported_endpoint_types?: unknown;
  billing_mode?: unknown;
  billing_expr?: unknown;
};

function groupRatioMap(raw: RawPricing): Map<string, number> {
  const ratios = new Map<string, number>();
  if (isObject(raw.group_ratio)) {
    for (const [name, value] of Object.entries(raw.group_ratio)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        ratios.set(name, value);
      }
    }
  }
  return ratios;
}

function usableGroupDescriptions(raw: RawPricing): Map<string, string> {
  const descriptions = new Map<string, string>();
  if (isObject(raw.usable_group)) {
    for (const [name, value] of Object.entries(raw.usable_group)) {
      if (typeof value === "string") descriptions.set(name, value);
    }
  }
  return descriptions;
}

function autoGroupNames(raw: RawPricing): Set<string> {
  return new Set(
    Array.isArray(raw.auto_groups)
      ? raw.auto_groups.filter((name): name is string => typeof name === "string")
      : [],
  );
}

function vendorNameMap(raw: RawPricing): Map<number, string> {
  const names = new Map<number, string>();
  if (Array.isArray(raw.vendors)) {
    for (const vendor of raw.vendors) {
      if (isObject(vendor) && typeof vendor.id === "number" && typeof vendor.name === "string") {
        names.set(vendor.id, vendor.name);
      }
    }
  }
  return names;
}

/** 展开为「模型 × 分组」最终价行。 */
function expandPricingRows(
  stationId: string,
  raw: RawPricing,
  keyModels: ReadonlySet<string>,
): { rows: RelayPricingRow[]; groups: RelayPricingGroup[] } {
  const ratios = groupRatioMap(raw);
  const descriptions = usableGroupDescriptions(raw);
  const autos = autoGroupNames(raw);
  const vendors = vendorNameMap(raw);

  const groups: RelayPricingGroup[] = [...ratios.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, ratio]) => ({
      name,
      ratio,
      ...(descriptions.has(name) ? { description: descriptions.get(name) } : {}),
      ...(autos.has(name) ? { isAuto: true } : {}),
    }));

  const rows: RelayPricingRow[] = [];
  for (const item of Array.isArray(raw.data) ? raw.data : []) {
    if (!isObject(item)) continue;
    const model = item as unknown as RawPricingModel;
    if (typeof model.model_name !== "string" || !model.model_name.trim()) continue;
    const vendorId = (item as { vendor_id?: unknown }).vendor_id;
    const vendor = typeof vendorId === "number" ? vendors.get(vendorId) : undefined;
    const enableGroups = Array.isArray(model.enable_groups)
      ? model.enable_groups.filter((name): name is string => typeof name === "string")
      : [];
    const endpoints = Array.isArray(model.supported_endpoint_types)
      ? model.supported_endpoint_types.filter(
          (endpoint): endpoint is string => typeof endpoint === "string",
        )
      : [];
    const perCall = model.quota_type !== undefined && model.quota_type !== 0;
    const billingExpr =
      typeof model.billing_expr === "string" && model.billing_expr.trim()
        ? model.billing_expr
        : undefined;
    for (const group of enableGroups) {
      const groupRatio = ratios.get(group);
      if (groupRatio === undefined) continue;
      if (perCall) {
        const basePrice =
          typeof model.model_price === "number" && Number.isFinite(model.model_price)
            ? model.model_price
            : 0;
        rows.push({
          stationId,
          modelId: model.model_name,
          modelName: model.model_name,
          ...(vendor ? { vendor } : {}),
          group,
          groupRatio,
          inputPer1M: null,
          outputPer1M: null,
          cachePer1M: null,
          callPrice: basePrice * groupRatio,
          endpoints,
          ...(billingExpr ? { billingExpr } : {}),
          keyAvailable: keyModels.has(model.model_name),
        });
      } else {
        const modelRatio =
          typeof model.model_ratio === "number" && Number.isFinite(model.model_ratio)
            ? model.model_ratio
            : 1;
        const completionRatio =
          typeof model.completion_ratio === "number" && Number.isFinite(model.completion_ratio)
            ? model.completion_ratio
            : 1;
        const cacheRatio =
          typeof model.cache_ratio === "number" && Number.isFinite(model.cache_ratio)
            ? model.cache_ratio
            : 0;
        const input = BASE_PRICE_PER_1M * modelRatio * groupRatio;
        rows.push({
          stationId,
          modelId: model.model_name,
          modelName: model.model_name,
          ...(vendor ? { vendor } : {}),
          group,
          groupRatio,
          inputPer1M: input,
          outputPer1M: input * completionRatio,
          cachePer1M: input * cacheRatio,
          callPrice: null,
          endpoints,
          ...(billingExpr ? { billingExpr } : {}),
          keyAvailable: keyModels.has(model.model_name),
        });
      }
    }
  }

  // rivo 的 media_pricing（音乐/视频/图片按次）：并入按次行，分组取 special。
  for (const item of Array.isArray(raw.media_pricing) ? raw.media_pricing : []) {
    if (!isObject(item)) continue;
    const media = item as unknown as {
      model_name?: unknown;
      unit_price?: unknown;
      media_type?: unknown;
      service_tier?: unknown;
    };
    if (typeof media.model_name !== "string" || !media.model_name.trim()) continue;
    const price =
      typeof media.unit_price === "number" && Number.isFinite(media.unit_price)
        ? media.unit_price
        : null;
    if (price === null) continue;
    const tier = typeof media.service_tier === "string" ? media.service_tier : "";
    const mediaType = typeof media.media_type === "string" ? media.media_type : "media";
    const group = tier ? `media/${mediaType}/${tier}` : `media/${mediaType}`;
    if (!rows.some((row) => row.modelId === media.model_name && row.group === group)) {
      rows.push({
        stationId,
        modelId: media.model_name,
        modelName: media.model_name,
        group,
        groupRatio: 1,
        inputPer1M: null,
        outputPer1M: null,
        cachePer1M: null,
        callPrice: price,
        endpoints: [mediaType],
        keyAvailable: keyModels.has(media.model_name),
      });
    }
  }

  return { rows, groups };
}

async function fetchKeyModels(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string[]> {
  const payload = await fetchJson(
    `${baseUrl.replace(/\/+$/, "")}/v1/models`,
    { Authorization: `Bearer ${apiKey}` },
    signal,
  );
  if (!isObject(payload) || !Array.isArray(payload.data)) return [];
  return payload.data
    .map((item) => (isObject(item) && typeof item.id === "string" ? item.id : ""))
    .filter((id) => id.length > 0);
}
/**
 * 内置 new-api 默认端点的基址：用户配置 baseUrl 时常带/不带 /v1 后缀，
 * 两种写法都指向同一站（川流Luna="https://api.rivoapi.com/v1" vs
 * 川流Claude="https://api.rivoapi.com"）。内置端点本身已含 /v1 前缀，
 * 裸拼接会出现 /v1/v1/... 404（f301eb6 已修映射路径，这里补齐内置路径）。
 */
function newApiBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base.slice(0, -"/v1".length) : base;
}

async function fetchBalance(
  stationId: string,
  baseUrl: string,
  apiKey: string,
  sensitiveValues: string[],
  signal: AbortSignal,
  mapping: RelayFieldMap | null,
): Promise<RelayBalance> {
  const fetchedAt = new Date().toISOString();
  const headers = { Authorization: `Bearer ${apiKey}` };
  // 映射路径相对原 baseUrl（f301eb6 的 URL 相对语义）；内置 new-api 默认端点
  // 自带 /v1 前缀，需归一化基址，避免 baseUrl 已带 /v1 时拼出 /v1/v1/...。
  const mappingBase = baseUrl.replace(/\/+$/, "");
  const base = newApiBase(baseUrl);
  try {
    if (mapping?.endpoints.balance) {
      // 映射路径：余额端点可自定义（可能合并 remaining/used 于同一响应）。
      const balanceEndpoint = mapping.endpoints.balance;
      const payload = await fetchJson(
        joinUrl(mappingBase, balanceEndpoint.path),
        balanceEndpoint.auth ? headers : {},
        signal,
      );
      const resolved = resolveEndpoint(payload, balanceEndpoint);
      const mapped = applyBalanceMapping(resolved);
      return balanceFromMapping(stationId, mapped, fetchedAt);
    }
    // 内置预设（DeepSeek /user/balance、OpenRouter /api/v1/credits）：
    // 主域命中且响应形态匹配时直接采用。
    const preset = await tryBalancePreset(baseUrl, apiKey, signal);
    if (preset) {
      return balanceFromExtracted(stationId, preset, fetchedAt);
    }
    const subscription = await fetchJson(
      `${base}/v1/dashboard/billing/subscription`,
      headers,
      signal,
    );
    // one-api/new-api 语义（模仿 OpenAI billing API 但口径不同）：
    //   subscription.hard_limit_usd = 剩余额度（美元）——不是总额度；
    //   usage.total_usage = 已用额度（美分），需 /100 换算成美元。
    // 即：余额 = hard_limit_usd，已用 = total_usage / 100。
    const remainingUsd =
      isObject(subscription) && typeof subscription.hard_limit_usd === "number"
        ? subscription.hard_limit_usd
        : 0;
    const usageEndpoint = mapping?.endpoints.usage;
    const usage = usageEndpoint
      ? await fetchJson(
          joinUrl(mappingBase, usageEndpoint.path),
          usageEndpoint.auth ? headers : {},
          signal,
        )
      : await fetchJson(`${base}/v1/dashboard/billing/usage`, headers, signal);
    if (usageEndpoint) {
      // 自定义 usage 端点：remaining 来自上面的 subscription，used 由映射规则
      // 换算（美分 → 美元等）。
      const resolvedUsage = resolveEndpoint(usage, usageEndpoint);
      const used = applyNumericMappingValue(
        resolvedUsage.scalars.get("balanceUsed"),
        usageEndpoint.fields.balanceUsed,
      );
      const unlimited = remainingUsd >= UNLIMITED_LIMIT_USD;
      return {
        stationId,
        hardLimitUsd: remainingUsd,
        totalUsageUsd: used ?? 0,
        remainingUsd: unlimited ? null : remainingUsd,
        unlimited,
        fetchedAt,
        ok: true,
      };
    }
    const totalUsageUsd =
      isObject(usage) && typeof usage.total_usage === "number" ? usage.total_usage / 100 : 0;
    const unlimited = remainingUsd >= UNLIMITED_LIMIT_USD;
    return {
      stationId,
      // 语义修正：这里存「剩余额度」，与字段名 remainingUsd 对齐。
      hardLimitUsd: remainingUsd,
      totalUsageUsd,
      remainingUsd: unlimited ? null : remainingUsd,
      unlimited,
      fetchedAt,
      ok: true,
    };
  } catch (error) {
    signal.throwIfAborted();
    // new-api 默认路径失败后的兜底：NingYi 式网关（GET /v1/usage 直接返回
    // balance/remaining，非 new-api 形态）。命中则成功返回，否则返回原错误。
    if (apiKey) {
      const probed = await probeUsageShapeBalance(baseUrl, apiKey, signal);
      if (probed) {
        return balanceFromExtracted(stationId, probed, fetchedAt);
      }
    }
    return {
      stationId,
      hardLimitUsd: 0,
      totalUsageUsd: 0,
      remainingUsd: null,
      unlimited: false,
      fetchedAt,
      ok: false,
      error: relayErrorMessage(error, sensitiveValues),
    };
  }
}

/** Join an endpoint path (possibly with leading slash) to a base URL. */
/**
 * 把映射表里的端点路径接到 baseUrl 上。遵循 URL 相对路径语义：
 *   - 绝对 URL（http(s)://）原样使用
 *   - 以 / 开头：相对站点根（base 的 scheme+host+port）
 *   - ../ 逐级去掉 base 路径的末段
 *   - 其余：相对 base 路径拼接
 * baseUrl 为 https://x.top/v1 时，"api/pricing" → https://x.top/v1/api/pricing，
 * "/api/pricing" → https://x.top/api/pricing，"../v1/models" → https://x.top/v1/models。
 */
export function joinRelayEndpointUrl(base: string, path: string): string {
  return joinUrl(base, path);
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }
  if (path.startsWith("/")) {
    url.pathname = path;
    return url.toString();
  }
  // 逐段处理 ../ 与普通段：基路径去掉末段文件名（或空段）。
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length > 0 && !url.pathname.endsWith("/")) segments.pop();
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment === "." || segment === "") continue;
    else segments.push(segment);
  }
  url.pathname = `/${segments.join("/")}`;
  return url.toString();
}

/** Single-value numeric mapping helper (no nested list context). */
function applyNumericMappingValue(
  raw: unknown,
  mapping: RelayFieldMapping | undefined,
): number | undefined {
  if (!mapping) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    let value = raw;
    if (mapping.offset !== undefined) value -= mapping.offset;
    if (mapping.scale !== undefined) value *= mapping.scale;
    return value;
  }
  return undefined;
}

async function fetchStation(
  stationId: string,
  providerId: string | null,
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  mapping: RelayFieldMap | null,
): Promise<RelayPricingStation> {
  const sensitiveValues = relaySensitiveValues(apiKey);
  // mappingBase 供映射分支与快照 baseUrl 用（保留原样）；apiBase 供内置
  // new-api 默认端点用（剥 /v1 后缀防 /v1/v1/... 404）。
  const mappingBase = baseUrl.replace(/\/+$/, "");
  const apiBase = newApiBase(baseUrl);
  const fetchedAt = new Date().toISOString();
  try {
    // 有映射表：全部端点按映射解析；没有：走内置 new-api 默认（与旧版一致）。
    if (mapping) {
      return await fetchStationWithMapping(
        stationId,
        providerId,
        mappingBase,
        apiKey,
        signal,
        mapping,
        fetchedAt,
        sensitiveValues,
      );
    }
    const pricing = (await fetchJson(`${apiBase}/api/pricing`, {}, signal)) as RawPricing;
    const keyModels = apiKey
      ? await fetchKeyModels(apiBase, apiKey, signal).catch((error) => {
          signal.throwIfAborted();
          logger.warn("relay pricing: /v1/models failed", {
            stationId,
            error: relayErrorMessage(error, sensitiveValues),
          });
          return [];
        })
      : [];
    const { rows, groups } = expandPricingRows(stationId, pricing, new Set(keyModels));
    const balance = apiKey
      ? await fetchBalance(stationId, baseUrl, apiKey, sensitiveValues, signal, null)
      : null;
    return {
      stationId,
      providerId,
      baseUrl: mappingBase,
      groups,
      rows,
      keyModels,
      balance,
      fetchedAt,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      stationId,
      providerId,
      baseUrl: mappingBase,
      groups: [],
      rows: [],
      keyModels: [],
      balance: null,
      fetchedAt: null,
      error: relayErrorMessage(error, sensitiveValues),
    };
  }
}

/** 映射化抓取路径：pricing/models/balance/usage 端点全部来自映射表。 */
/**
 * 逐模型分组详情（二次请求）：对每个占位符组合请求一次详情端点，把响应里的
 * groups（name→multiplier）与 groupDescriptions 合入分组表，并把行绑定到
 * 该组合解析出的分组名上。占位符字段在行上以映射后的值存在（modelId 等
 * ITEM_LEVEL_FIELDS），响应解析复用 pricing 端点同一套 fields 规则。
 */
async function enrichRowsWithGroupDetails(
  rows: RelayPricingRow[],
  groups: RelayPricingGroup[],
  base: string,
  detailEndpoint: RelayEndpointMapping,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ rows: RelayPricingRow[]; groups: RelayPricingGroup[] }> {
  // path 中允许的占位符：{modelDetailKey} / {modelId} 等行字段名。
  const placeholderNames = [...detailEndpoint.path.matchAll(/\{([A-Za-z]\w*)\}/g)].map(
    (match) => match[1]!,
  );
  if (placeholderNames.length === 0) return { rows, groups };

  /** 行占位符取值：modelDetailKey 优先（不在行上则该行不参与详情请求）。 */
  const placeholderValueOf = (row: RelayPricingRow, name: string): string | number | undefined => {
    if (name === "modelDetailKey") return row.detailKey;
    const value = row[name as keyof RelayPricingRow];
    if (name === "endpoints" || name === "vendor") return undefined;
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  };

  // 占位符组合 → 请求 URL（同组合只请求一次）与解析出的分组。
  const combinations = new Map<string, { url: string; groupNames: Set<string> | null }>();
  for (const row of rows) {
    let url = detailEndpoint.path;
    let resolvable = true;
    for (const name of placeholderNames) {
      const value = placeholderValueOf(row, name);
      if (value === undefined || value === "") {
        resolvable = false;
        break;
      }
      url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
    if (!resolvable) continue;
    const full = joinUrl(base, url);
    if (!combinations.has(full)) combinations.set(full, { url: full, groupNames: null });
  }
  if (combinations.size === 0) return { rows, groups };

  // 逐组合请求并解析分组（groups / groupDescriptions / autoGroups 规则与
  // pricing 端点一致，直接复用 resolveEndpoint）。
  const ratioByName = new Map<string, RelayPricingGroup>(groups.map((g) => [g.name, g]));
  const descriptionByName = new Map<string, string>();
  const autoNames = new Set<string>();
  for (const combination of combinations.values()) {
    signal.throwIfAborted();
    const payload = await fetchJson(combination.url, detailEndpoint.auth ? headers : {}, signal);
    const resolved = resolveEndpoint(payload, {
      ...detailEndpoint,
      // 详情端点只解析分组相关字段，忽略 modelId 等行级字段规则。
      fields: Object.fromEntries(
        Object.entries(detailEndpoint.fields).filter(([field]) =>
          ["groups", "groupDescriptions", "autoGroups"].includes(field),
        ),
      ),
    });
    const detailRatios = groupRatioEntries(resolved);
    const names = new Set<string>();
    for (const [name, ratio] of detailRatios) {
      names.add(name);
      const existing = ratioByName.get(name);
      if (!existing) {
        ratioByName.set(name, { name, ratio });
      } else if (existing.ratio !== ratio) {
        // 同名分组在不同模型下倍率不一致时保留首个（详情端点按模型隔离，
        // 理论上不会发生；万一发生以先到为准并记录）。
        logger.warn("relay pricing: inconsistent group ratio across models", {
          url: combination.url,
          group: name,
          kept: existing.ratio,
          ignored: ratio,
        });
      }
    }
    for (const [name, description] of descriptionEntries(resolved)) {
      descriptionByName.set(name, description);
    }
    for (const name of stringSetEntries(resolved, "autoGroups")) autoNames.add(name);
    combination.groupNames = names;
  }

  // 行绑定：按占位符值找到该行的详情组合，按组展开（一个模型属 N 个组 =
  // N 行，各带各的倍率）——与主端点多分组的展开语义一致。详情无分组的行
  // 原样保留。
  const detailPathTemplate = detailEndpoint.path;
  const enriched: RelayPricingRow[] = [];
  for (const row of rows) {
    let url = detailPathTemplate;
    let resolvable = true;
    for (const name of placeholderNames) {
      const value = placeholderValueOf(row, name);
      if (value === undefined || value === "") {
        resolvable = false;
        break;
      }
      url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
    const combination = resolvable ? combinations.get(joinUrl(base, url)) : undefined;
    const names = combination?.groupNames;
    if (!names || names.size === 0) {
      enriched.push(row);
      continue;
    }
    for (const name of [...names].sort()) {
      const ratio = ratioByName.get(name)?.ratio;
      // 主端点解析时没有分组倍率表，行价是按 default（×1）算的；这里按该行
      // 实际分组的倍率重算价格（价格对分组倍率线性）。
      const factor = ratio !== undefined && ratio !== row.groupRatio ? ratio / row.groupRatio : 1;
      enriched.push({
        ...row,
        group: name,
        groupRatio: ratio ?? row.groupRatio,
        ...(factor === 1
          ? {}
          : {
              inputPer1M: row.inputPer1M === null ? null : row.inputPer1M * factor,
              outputPer1M: row.outputPer1M === null ? null : row.outputPer1M * factor,
              cachePer1M: row.cachePer1M === null ? null : row.cachePer1M * factor,
              callPrice: row.callPrice === null ? null : row.callPrice * factor,
            }),
      });
    }
  }

  const mergedGroups = [...ratioByName.values()].map((group) => ({
    ...group,
    ...(descriptionByName.has(group.name)
      ? { description: descriptionByName.get(group.name) }
      : {}),
    ...(autoNames.has(group.name) ? { isAuto: true } : {}),
  }));
  // 主端点回退产生的 default 虚拟分组（倍率 1、无描述）在详情给出真实分组、
  // 且没有行落在 default 时已无意义，从分组表移除。
  const hasDefaultRows = enriched.some((row) => row.group === "default");
  const filteredGroups = hasDefaultRows
    ? mergedGroups
    : mergedGroups.filter(
        (group) =>
          group.name !== "default" ||
          group.ratio !== 1 ||
          group.description !== undefined ||
          group.isAuto === true,
      );
  return { rows: enriched, groups: filteredGroups };
}

async function fetchStationWithMapping(
  stationId: string,
  providerId: string | null,
  base: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  mapping: RelayFieldMap,
  fetchedAt: string,
  sensitiveValues: string[],
): Promise<RelayPricingStation> {
  const pricingEndpoint = mapping.endpoints.pricing;
  const modelsEndpoint = mapping.endpoints.models;
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  let groups: RelayPricingGroup[] = [];
  let rows: RelayPricingRow[] = [];
  let resolvedRows: Array<Map<string, unknown>> | null = null;
  if (pricingEndpoint) {
    const payload = await fetchJson(
      joinUrl(base, pricingEndpoint.path),
      pricingEndpoint.auth ? headers : {},
      signal,
    );
    const resolved = resolveEndpoint(payload, pricingEndpoint);
    ({ rows, groups } = applyPricingMapping(resolved, stationId, new Set<string>()));
    // 保留解析后的模型行记录，供 keyModels 已知后重算 keyAvailable（避免
    // 重新 applyPricingMapping 覆盖二次请求写入的分组绑定）。
    resolvedRows = resolved.itemLists.get("models") ?? null;
  }

  // 逐模型分组详情（二次请求）：path 里的 {fieldName} 占位符用该行的已映射
  // 字段值替换（如 api/pricing/{modelId}），按占位符组合去重后逐条请求，
  // 响应解析出 groups/groupDescriptions 并绑定到对应的模型行。
  const detailEndpoint = mapping.endpoints.groupsDetail;
  if (detailEndpoint && pricingEndpoint && rows.length > 0) {
    try {
      ({ rows, groups } = await enrichRowsWithGroupDetails(
        rows,
        groups,
        base,
        detailEndpoint,
        headers,
        signal,
      ));
    } catch (error) {
      signal.throwIfAborted();
      // 详情端点失败不否定整个抓取：保留主端点的行（分组回退为无倍率表）。
      logger.warn("relay pricing: groups detail endpoint failed", {
        stationId,
        error: relayErrorMessage(error, sensitiveValues),
      });
    }
  }

  let keyModels: string[] = [];
  if (apiKey && modelsEndpoint) {
    try {
      const payload = await fetchJson(
        joinUrl(base, modelsEndpoint.path),
        modelsEndpoint.auth ? headers : {},
        signal,
      );
      keyModels = applyModelsMapping(resolveEndpoint(payload, modelsEndpoint)).keyModels;
    } catch (error) {
      signal.throwIfAborted();
      logger.warn("relay pricing: mapped models endpoint failed", {
        stationId,
        error: relayErrorMessage(error, sensitiveValues),
      });
    }
  }

  // keyAvailable 重算：直接改写现有行的标记，不重新解析主端点 —— 否则会
  // 把 groupsDetail 二次请求写入的分组绑定覆盖掉。
  if (resolvedRows) {
    const keySet = new Set(keyModels);
    let index = 0;
    for (const model of resolvedRows) {
      const modelId = model.get("modelId");
      if (typeof modelId !== "string") continue;
      const available = keySet.has(modelId);
      while (index < rows.length && rows[index]!.modelId !== modelId) index += 1;
      if (index >= rows.length) break;
      rows[index] = { ...rows[index]!, keyAvailable: available };
      index += 1;
    }
  }

  const balance = apiKey
    ? await fetchBalance(stationId, base, apiKey, sensitiveValues, signal, mapping)
    : null;
  return {
    stationId,
    providerId,
    baseUrl: base,
    groups,
    rows,
    keyModels,
    balance,
    fetchedAt,
  };
}

/** 供 balance.get 等复用的单站抓取入口。 */
async function fetchRelayBalanceForProvider(
  providerId: string,
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  mapping: RelayFieldMap | null = null,
): Promise<RelayBalance> {
  const stationId = providerId;
  if (!apiKey) {
    return {
      stationId,
      hardLimitUsd: 0,
      totalUsageUsd: 0,
      remainingUsd: null,
      unlimited: false,
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: "No API key configured for this provider",
    };
  }
  return fetchBalance(stationId, baseUrl, apiKey, relaySensitiveValues(apiKey), signal, mapping);
}

export function createRelayPricingHandlers(factory: WorkspaceGraphFactory): {
  "provider.pricing.fetch": MethodHandler;
  "provider.pricing.get": MethodHandler;
  "provider.balance.get": MethodHandler;
  "provider.pricing.setRechargeRatio": MethodHandler;
  "provider.mapping.get": MethodHandler;
  "provider.mapping.set": MethodHandler;
  "provider.mapping.handoff": MethodHandler;
  "provider.mapping.picker": MethodHandler;
} {
  const store = new RelayPricingStore(factory.deps.agentDir);
  const mappingStore = new RelayMappingStore(factory.deps.agentDir);
  const modelsPath = join(factory.deps.agentDir, "models.json");

  /** models.json 里的自定义 provider 清单（id + baseUrl）。 */
  async function listRelayProviders(): Promise<
    Array<{ id: string; baseUrl: string; name: string }>
  > {
    const config = await readModelsConfig(modelsPath);
    return Object.entries(config.providers)
      .filter(
        (entry): entry is [string, JsonObject] => isObject(entry[1]) && isRelayProvider(entry[1]),
      )
      .map(([id, raw]) => ({
        id,
        baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      }));
  }

  /** 抓取并落盘。providerIds 为空表示刷新全部已配置的 relay provider。 */
  async function fetchAndStore(
    server: PiHostServer,
    providerIds: string[] | null,
  ): Promise<RelayPricingResult> {
    const shutdownSignal = server.getShutdownSignal();
    shutdownSignal.throwIfAborted();
    const all = await listRelayProviders();
    const targets = providerIds ? all.filter((provider) => providerIds.includes(provider.id)) : all;
    // 全量刷新时顺手清掉已删除 provider 遗留的站点快照。
    if (providerIds === null) {
      store.pruneStations(new Set(all.map((provider) => provider.id)));
    }
    // 有 key 的站才值得抓 keyModels/余额；没 key 的站只抓公开价目。
    const results: RelayPricingStation[] = [];
    for (const provider of targets) {
      if (shutdownSignal.aborted) break;
      const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(provider.id);
      // 映射表解析：本站显式表 > 同 baseUrl/主域共享表 > 内置默认。
      const mapping = mappingStore.resolve(provider.id, provider.baseUrl);
      const station = await fetchStation(
        provider.id,
        provider.id,
        provider.baseUrl,
        apiKey ?? undefined,
        shutdownSignal,
        mapping,
      );
      // 站点名只在本地展示用，不落盘（跟随 provider.name 动态取）。
      store.upsertStation(station);
      results.push(station);
    }
    return {
      table: store.getTable(),
      rechargeRatios: store.getRatios(),
      cached: false,
    };
  }

  return {
    "provider.pricing.fetch": async (ctx) => {
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      const params = (ctx.params ?? {}) as RelayPricingFetchParams;
      // 兼容三种入参：providerIds 批量（弹窗按站刷新）、旧的单站 providerId、
      // 以及空参（全量刷新全部已配置的 relay provider）。
      const requested = params.providerIds
        ? params.providerIds
        : params.providerId
          ? [params.providerId]
          : null;
      try {
        const result = await fetchAndStore(server, requested);
        return { result };
      } catch (error) {
        if (server.getShutdownSignal().aborted) {
          return { error: createHostError("HOST_SHUTTING_DOWN", "Host is shutting down") };
        }
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not fetch relay pricing",
            { retryable: true },
          ),
        };
      }
    },

    "provider.pricing.get": async () => {
      try {
        return {
          result: {
            table: store.getTable(),
            rechargeRatios: store.getRatios(),
            cached: true,
          } satisfies RelayPricingResult,
        };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read relay pricing cache",
          ),
        };
      }
    },

    "provider.balance.get": async (ctx) => {
      const { providerId, refresh } = ctx.params as {
        providerId: string;
        refresh?: boolean;
      };
      if (refresh !== true) {
        const cached = store.getCachedBalance(providerId);
        if (cached) return { result: cached };
      }
      const providers = await listRelayProviders();
      const provider = providers.find((entry) => entry.id === providerId);
      if (!provider) {
        return {
          error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${providerId}`),
        };
      }
      const server = factory.getServer();
      if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      try {
        const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(providerId);
        const balance = await fetchRelayBalanceForProvider(
          providerId,
          provider.baseUrl,
          apiKey ?? undefined,
          server.getShutdownSignal(),
          mappingStore.resolve(providerId, provider.baseUrl),
        );
        // 余额落盘进对应 station 快照，供下次快速显示。
        const table = store.getTable();
        const station = table.stations.find((entry) => entry.stationId === providerId);
        if (station) {
          store.upsertStation({ ...station, balance });
        } else {
          store.upsertStation({
            stationId: providerId,
            providerId,
            baseUrl: provider.baseUrl,
            groups: [],
            rows: [],
            keyModels: [],
            balance,
            fetchedAt: null,
          });
        }
        return { result: balance };
      } catch (error) {
        if (server.getShutdownSignal().aborted) {
          return { error: createHostError("HOST_SHUTTING_DOWN", "Host is shutting down") };
        }
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not query relay balance",
            { retryable: true },
          ),
        };
      }
    },

    "provider.pricing.setRechargeRatio": async (ctx) => {
      const { providerId, ratio } = ctx.params as {
        providerId: string;
        ratio: RelayRechargeRatio | null;
      };
      try {
        const applied = store.setRatio(providerId, ratio);
        return { result: { providerId, ratio: applied } };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_WRITE_FAILED",
            error instanceof Error ? error.message : "Could not save recharge ratio",
          ),
        };
      }
    },

    "provider.mapping.get": async (ctx) => {
      const { stationId } = ctx.params as { stationId: string };
      try {
        return {
          result: { stationId, mapping: mappingStore.get(stationId) } satisfies RelayMappingResult,
        };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_READ_FAILED",
            error instanceof Error ? error.message : "Could not read field mapping",
          ),
        };
      }
    },

    "provider.mapping.set": async (ctx) => {
      const params = ctx.params as RelayMappingSetParams;
      try {
        const mapping = mappingStore.set(params.stationId, params.mapping);
        return {
          result: {
            stationId: params.stationId,
            mapping,
          } satisfies RelayMappingResult,
        };
      } catch (error) {
        return {
          error: createHostError(
            "SETTINGS_WRITE_FAILED",
            error instanceof Error ? error.message : "Could not save field mapping",
          ),
        };
      }
    },

    /**
     * Agent 交接信息：映射文件路径、站点 baseUrl、key 位置、当前映射。
     * 桌面端机器人图标按钮调用后，把这些事实拼进提示词发给 DefaultProject。
     */
    "provider.mapping.handoff": async (ctx) => {
      const { stationId } = ctx.params as { stationId: string };
      try {
        const providers = await listRelayProviders();
        const provider = providers.find((entry) => entry.id === stationId);
        if (!provider) {
          return {
            error: createHostError("MODEL_NOT_FOUND", `Provider not found: ${stationId}`),
          };
        }
        const apiKey = await factory.deps.modelRegistry.getApiKeyForProvider(stationId);
        // 同站镜像清单：主域一致（或 URL 完全一致）的其它 provider。
        // 供 Agent 判断「已有共享映射则只需扩展 shareByBaseUrl，不用重复探测」。
        const mainDomain = relayMainDomain(provider.baseUrl);
        const sharedWith = providers
          .filter(
            (entry) =>
              entry.id !== stationId &&
              (normalizeRelayBaseUrl(entry.baseUrl) === normalizeRelayBaseUrl(provider.baseUrl) ||
                (mainDomain !== null && relayMainDomain(entry.baseUrl) === mainDomain)),
          )
          .map((entry) => entry.id);
        const result: RelayMappingHandoffResult = {
          stationId,
          mappingPath: mappingStore.mappingPath(stationId),
          baseUrl: provider.baseUrl.replace(/\/+$/, ""),
          hasApiKey: Boolean(apiKey),
          authJsonPath: join(factory.deps.agentDir, "auth.json"),
          mapping: mappingStore.get(stationId),
          sharedWith,
        };
        return { result };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not build mapping handoff",
          ),
        };
      }
    },

    /**
     * 价格总表右上角「映射机器人」弹窗的数据源：把所有自定义中转站
     * provider 按主域/归一化地址合并成站点候选（排除 cf.x/api.x 等子域名
     * 镜像入口），并标记该站点是否已有生效映射表。
     */
    "provider.mapping.picker": async () => {
      try {
        const providers = await listRelayProviders();
        const keyCache = new Map<string, boolean>();
        const hasKey = async (id: string): Promise<boolean> => {
          const cached = keyCache.get(id);
          if (cached !== undefined) return cached;
          let value: boolean;
          try {
            value = Boolean(await factory.deps.modelRegistry.getApiKeyForProvider(id));
          } catch {
            value = false;
          }
          keyCache.set(id, value);
          return value;
        };
        // 同站合并：归一化地址一致，或主域一致（cf.x/api.x/cdn.x 镜像入口）。
        // 站点候选的 stationId 取组内第一个 provider（映射文件以它命名）。
        const groups: Array<{ providerIds: string[] }> = [];
        for (const provider of providers) {
          const normalized = normalizeRelayBaseUrl(provider.baseUrl);
          const domain = relayMainDomain(provider.baseUrl);
          const group = groups.find(({ providerIds }) =>
            providerIds.some((id) => {
              const peer = providers.find((entry) => entry.id === id);
              if (!peer) return false;
              return (
                normalizeRelayBaseUrl(peer.baseUrl) === normalized ||
                (domain !== null && relayMainDomain(peer.baseUrl) === domain)
              );
            }),
          );
          if (group) group.providerIds.push(provider.id);
          else groups.push({ providerIds: [provider.id] });
        }
        const entries = [];
        for (const { providerIds } of groups) {
          const stationId = providerIds[0]!;
          const provider = providers.find((entry) => entry.id === stationId)!;
          entries.push({
            stationId,
            names: providers
              .filter((entry) => providerIds.includes(entry.id))
              .map((entry) => entry.name),
            baseUrl: provider.baseUrl.replace(/\/+$/, ""),
            hasApiKey: await hasKey(stationId),
            hasMapping: mappingStore.resolve(stationId, provider.baseUrl) !== null,
            providerIds,
          });
        }
        return { result: { entries } satisfies RelayMappingPickerResult };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Could not list mapping candidates",
          ),
        };
      }
    },
  };
}
