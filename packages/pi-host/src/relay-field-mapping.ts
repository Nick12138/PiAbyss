/**
 * 中转站字段映射解析器 —— 映射化改造的核心。
 *
 * 不同中转站的余额/价格 API 形态各异。与其每接入一家就改源码，这里把
 * 「上游字段 → 本地标准字段」的对应关系抽成映射表（RelayFieldMap，JSON），
 * 由 Agent 探测后生成、用户核对后生效。解析器只做三件事：
 *
 *   1. resolveFieldPath：把 "data[].model_ratio" 这类点路径按 reader 语义取值
 *   2. mapEndpoint：按一张 endpoint 映射规则表解析整个响应
 *   3. applyFieldMap：把映射结果翻译成本地标准结构（groups/rows/balance）
 *
 * 没有映射表（mapping 为 null 或 enabled=false）时走内置 new-api 默认路径，
 * 行为与改造前完全一致。
 */
import type {
  RelayBalance,
  RelayEndpointMapping,
  RelayFieldMapping,
  RelayPricingGroup,
  RelayPricingRow,
} from "@piabyss/protocol";
import { isObject, type JsonObject } from "./provider-models-config.js";

/** 基准价：new-api 体系下 model_ratio=1、group_ratio=1 时的输入价（$/1M）。 */
const RELAY_BASE_PRICE_PER_1M = 2;

export type MappedPricingResult = {
  groups: RelayPricingGroup[];
  rows: RelayPricingRow[];
};

export type MappedModelsResult = {
  keyModels: string[];
};

export type MappedBalanceResult = {
  remaining?: number;
  used?: number;
  unlimited?: boolean;
};

/** 点路径中的一段（数字下标表示数组索引，字符串表示键）。 */
type PathSegment = string | number;

function splitPath(path: string): PathSegment[] {
  return path
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

/**
 * 按 reader 语义从 payload 中取一个标准字段的值。
 *   - "value"（默认）：路径直达标量（或透传数组/对象）
 *   - "entries"：路径指向对象，展开为 [name, value][]（含 itemsField 时取对象值里的字段）
 *   - "array"：路径指向字符串数组（或对象键列表）
 */
export function readMappedField(
  payload: unknown,
  mapping: RelayFieldMapping,
): Array<[string, unknown]> | unknown {
  const segments = splitPath(mapping.path);
  let current: unknown = payload;
  let currentPath: PathSegment[] = [];
  for (const segment of segments) {
    if (segment === "[]") {
      // 通配数组段：以数组首元素继续（entries/array reader 会再展开）。
      if (!Array.isArray(current)) return undefined;
      current = current[0];
      currentPath = [...currentPath, 0];
      continue;
    }
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
    currentPath = [...currentPath, segment];
  }
  void currentPath;

  const reader = mapping.reader ?? "value";
  if (reader === "entries") {
    if (!isObject(current)) return undefined;
    const entries: Array<[string, unknown]> = [];
    for (const [name, value] of Object.entries(current as JsonObject)) {
      if (mapping.itemField) {
        const inner = isObject(value) ? (value as JsonObject)[mapping.itemField] : undefined;
        if (inner === undefined) continue;
        entries.push([name, inner]);
      } else {
        entries.push([name, value]);
      }
    }
    return entries;
  }
  if (reader === "array") {
    if (Array.isArray(current)) {
      return current
        .map((item) => {
          if (mapping.itemField && isObject(item)) {
            return (item as JsonObject)[mapping.itemField];
          }
          return item;
        })
        .filter((item) => typeof item === "string" || typeof item === "number");
    }
    if (isObject(current)) return Object.keys(current as JsonObject);
    return undefined;
  }
  return current;
}

/** 把数值型映射规则（scale/offset/unlimitedAbove/fallback）应用到原始值。 */
function applyNumericMapping(
  raw: unknown,
  mapping: RelayFieldMapping,
): number | undefined {
  let value: number;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
    value = Number(raw);
  } else if (mapping.fallback !== undefined && typeof mapping.fallback === "number") {
    value = mapping.fallback;
  } else {
    return undefined;
  }
  if (mapping.offset !== undefined) value -= mapping.offset;
  if (mapping.scale !== undefined) value *= mapping.scale;
  return value;
}

/** 从已解析的值里取数值（用于 groups 等 entries 读法）。 */
function numericOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * 解析一个 endpoint 的响应：返回按 canonical 字段组织的
 * 「字段 → 值 | entries」。items 型 endpoint（模型列表）在这里只负责把
 * `models` 字段展开成逐条记录的映射结果数组。
 */
export type ResolvedEndpoint = {
  /** root 型字段（keyModels、balanceRemaining 等）的原始值。 */
  scalars: Map<string, unknown>;
  /** 每个标量字段对应的映射规则（换算用，如 scale/offset）。 */
  scalarMappings: Map<string, RelayFieldMapping>;
  /**
   * items 型字段（models/vendors）：每个元素是「字段名 → 该行原始值」,
   * 供 applyFieldMap 逐行换算价格。
   */
  itemLists: Map<string, Array<Map<string, unknown>>>;
};

/** 对已解析的标量值套用其映射规则（offset/scale/fallback）。 */
function applyScalarMapping(
  resolved: ResolvedEndpoint,
  field: string,
): number | undefined {
  const mapping = resolved.scalarMappings.get(field);
  return applyNumericMapping(resolved.scalars.get(field), mapping ?? { path: "$" });
}

/** Canonical fields that describe one item of a list (per-model / per-vendor). */
const ITEM_LEVEL_FIELDS = new Set([
  "modelId",
  "modelVendor",
  "modelInputRatio",
  "modelCompletionRatio",
  "modelCacheRatio",
  "modelCallPrice",
  "modelPerCallFlag",
  "modelGroups",
  "modelEndpoints",
]);

export function resolveEndpoint(
  payload: unknown,
  endpoint: RelayEndpointMapping,
): ResolvedEndpoint {
  const scalars = new Map<string, unknown>();
  const scalarMappings = new Map<string, RelayFieldMapping>();
  const itemLists = new Map<string, Array<Map<string, unknown>>>();
  const itemsMode = endpoint.fieldsApplyTo === "items";
  const itemsField = endpoint.itemsField ?? "models";

  if (itemsMode) {
    // items 模式：endpoint.path 是端点 URL；记录数组在响应内的位置由 itemsPath
    // 决定（缺省即响应根本体，形如 {data:[...]} 的包装用 itemsPath: "data"）。
    // item 级字段按记录解析；其余字段（分组倍率等）从响应根取。
    let list: unknown = payload;
    const itemsPath = endpoint.itemsPath;
    if (itemsPath && itemsPath !== "$") {
      for (const segment of splitPath(itemsPath)) {
        if (!isObject(list) && !Array.isArray(list)) {
          list = undefined;
          break;
        }
        list = (list as Record<string | number, unknown>)[segment];
      }
    }
    const items = Array.isArray(list) ? list : [];
    const rows = items.map((item) => {
      const row = new Map<string, unknown>();
      const rowMappings = new Map<string, RelayFieldMapping>();
      if (!isObject(item)) {
        row.set("__mappings", rowMappings);
        return row;
      }
      const record = item as JsonObject;
      for (const [field, mapping] of Object.entries(endpoint.fields)) {
        if (!ITEM_LEVEL_FIELDS.has(field)) continue;
        rowMappings.set(field, mapping);
        row.set(field, resolveItemPath(record, mapping.path));
      }
      row.set("__mappings", rowMappings);
      return row;
    });
    if (rows.length > 0) itemLists.set(itemsField, rows);
    for (const [field, mapping] of Object.entries(endpoint.fields)) {
      if (ITEM_LEVEL_FIELDS.has(field)) continue;
      scalarMappings.set(field, mapping);
      scalars.set(field, readMappedField(payload, mapping));
    }
    return { scalars, scalarMappings, itemLists };
  }

  for (const [field, mapping] of Object.entries(endpoint.fields)) {
    scalarMappings.set(field, mapping);
    scalars.set(field, readMappedField(payload, mapping));
  }
  return { scalars, scalarMappings, itemLists };
}

/** items 模式下的相对路径：只支持纯键/下标链（不允许 "[]" 通配）。 */
function resolveItemPath(record: JsonObject, path: string): unknown {
  let current: unknown = record;
  for (const segment of splitPath(path)) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** 取一行里某字段的映射规则（resolveEndpoint 塞在 `__mappings` 里）。 */
function rowMappings(row: Map<string, unknown>): Map<string, RelayFieldMapping> {
  const mappings = row.get("__mappings");
  return mappings instanceof Map ? (mappings as Map<string, RelayFieldMapping>) : new Map();
}

/** 逐行数值：取原始值并套用该行的映射规则。 */
function mappedNumber(row: Map<string, unknown>, field: string): number | undefined {
  const mapping = rowMappings(row).get(field);
  return applyNumericMapping(row.get(field), mapping ?? { path: "$" });
}

function groupRatioEntries(resolved: ResolvedEndpoint): Array<[string, number]> {
  const raw = resolved.scalars.get("groups");
  if (!Array.isArray(raw)) return [];
  const entries: Array<[string, number]> = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const [name, value] = entry;
    if (typeof name !== "string" || !name) continue;
    const ratio = numericOf(value);
    if (ratio !== undefined) entries.push([name, ratio]);
  }
  return entries;
}

function stringSetEntries(resolved: ResolvedEndpoint, field: string): Set<string> {
  const raw = resolved.scalars.get(field);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((item): item is string => typeof item === "string"));
}

function descriptionEntries(resolved: ResolvedEndpoint): Map<string, string> {
  const raw = resolved.scalars.get("groupDescriptions");
  const descriptions = new Map<string, string>();
  if (!Array.isArray(raw)) return descriptions;
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const [name, value] = entry;
    if (typeof name === "string" && typeof value === "string") {
      descriptions.set(name, value);
    }
  }
  return descriptions;
}

function vendorMap(resolved: ResolvedEndpoint): Map<number, string> {
  const vendors = resolved.itemLists.get("vendors");
  const names = new Map<number, string>();
  if (!vendors) return names;
  for (const vendor of vendors) {
    const id = vendor.get("modelVendor");
    const name = vendor.get("modelId");
    if (typeof id === "number" && typeof name === "string") names.set(id, name);
  }
  return names;
}

/**
 * 把 pricing endpoint 的解析结果换算成本地价格行。
 * 逐行取值都走映射规则（scale/offset 照常生效），per-call 判定优先看
 * modelPerCallFlag，缺失时回退「有 callPrice 就按次」。
 */
export function applyPricingMapping(
  resolved: ResolvedEndpoint,
  stationId: string,
  keyModels: ReadonlySet<string>,
): MappedPricingResult {
  const ratios = new Map(groupRatioEntries(resolved));
  const descriptions = descriptionEntries(resolved);
  const autos = stringSetEntries(resolved, "autoGroups");
  const vendors = vendorMap(resolved);

  const groups: RelayPricingGroup[] = [...ratios.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, ratio]) => ({
      name,
      ratio,
      ...(descriptions.has(name) ? { description: descriptions.get(name) } : {}),
      ...(autos.has(name) ? { isAuto: true } : {}),
    }));

  const modelRows = resolved.itemLists.get("models") ?? [];
  const rows: RelayPricingRow[] = [];
  for (const model of modelRows) {
    const modelId = model.get("modelId");
    if (typeof modelId !== "string" || !modelId.trim()) continue;
    const vendorId = model.get("modelVendor");
    const vendor = typeof vendorId === "number" ? vendors.get(vendorId) : undefined;
    const groupNames = model.get("modelGroups");
    const enableGroups: string[] = Array.isArray(groupNames)
      ? groupNames.filter((name): name is string => typeof name === "string")
      : [];
    const endpointsRaw = model.get("modelEndpoints");
    const endpoints = Array.isArray(endpointsRaw)
      ? endpointsRaw.filter((item): item is string => typeof item === "string")
      : [];
    const perCallFlag = model.get("modelPerCallFlag");
    const perCall =
      (typeof perCallFlag === "number" && perCallFlag !== 0) || perCallFlag === true;
    const callPrice = mappedNumber(model, "modelCallPrice");
    const inputRatio = mappedNumber(model, "modelInputRatio");
    const completionRatio = mappedNumber(model, "modelCompletionRatio");
    const cacheRatio = mappedNumber(model, "modelCacheRatio");
    const usePerCall = perCall || (callPrice !== undefined && inputRatio === undefined);
    for (const group of enableGroups) {
      const groupRatio = ratios.get(group);
      if (groupRatio === undefined) continue;
      if (usePerCall) {
        rows.push({
          stationId,
          modelId,
          modelName: modelId,
          ...(vendor ? { vendor } : {}),
          group,
          groupRatio,
          inputPer1M: null,
          outputPer1M: null,
          cachePer1M: null,
          callPrice: (callPrice ?? 0) * groupRatio,
          endpoints,
          keyAvailable: keyModels.has(modelId),
        });
      } else {
        const input =
          RELAY_BASE_PRICE_PER_1M * (inputRatio ?? 1) * groupRatio;
        rows.push({
          stationId,
          modelId,
          modelName: modelId,
          ...(vendor ? { vendor } : {}),
          group,
          groupRatio,
          inputPer1M: input,
          outputPer1M: input * (completionRatio ?? 1),
          cachePer1M: input * (cacheRatio ?? 0),
          callPrice: null,
          endpoints,
          keyAvailable: keyModels.has(modelId),
        });
      }
    }
  }
  return { rows, groups };
}

/** 解析 key 可见模型列表 endpoint（/v1/models 或任意映射目标）。 */
export function applyModelsMapping(resolved: ResolvedEndpoint): MappedModelsResult {
  const raw = resolved.scalars.get("keyModels");
  const keyModels: string[] = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
  return { keyModels };
}

/** 解析余额 endpoint（可能同时带 remaining/used，任一缺失即 undefined）。 */
export function applyBalanceMapping(
  resolved: ResolvedEndpoint,
  previous?: { remaining?: number; used?: number },
): MappedBalanceResult {
  const result: MappedBalanceResult = { ...previous };
  if (resolved.scalars.has("balanceRemaining")) {
    const remaining = applyScalarMapping(resolved, "balanceRemaining");
    if (remaining !== undefined) {
      result.remaining = remaining;
      const threshold = applyScalarMapping(resolved, "balanceUnlimitedValue");
      result.unlimited = threshold !== undefined ? remaining >= threshold : false;
    }
  }
  if (resolved.scalars.has("balanceUsed")) {
    const used = applyScalarMapping(resolved, "balanceUsed");
    if (used !== undefined) result.used = used;
  }
  if (result.unlimited === undefined) result.unlimited = false;
  return result;
}


/** 构造 RelayBalance 快照（余额映射结果 → 本地结构）。 */
export function balanceFromMapping(
  stationId: string,
  mapped: MappedBalanceResult,
  fetchedAt: string,
): RelayBalance {
  const remaining = mapped.remaining ?? 0;
  const used = mapped.used ?? 0;
  const unlimited = mapped.unlimited ?? false;
  return {
    stationId,
    hardLimitUsd: remaining,
    totalUsageUsd: used,
    remainingUsd: unlimited ? null : remaining,
    unlimited,
    fetchedAt,
    ok: true,
  };
}
