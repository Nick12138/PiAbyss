import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBalanceMapping,
  applyModelsMapping,
  applyPricingMapping,
  balanceFromMapping,
  readMappedField,
  resolveEndpoint,
} from "./relay-field-mapping.js";
import {
  normalizeRelayBaseUrl,
  RelayMappingStore,
  relayMainDomain,
} from "./relay-mapping-store.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import type { RelayFieldMap } from "@piabyss/protocol";

const layouts: TempAgentLayout[] = [];

afterEach(() => {
  for (const layout of layouts.splice(0)) layout.cleanup();
});

/** A mapping table shaped like what the Agent would write for a veloera-style station. */
function veloeraStyleMapping(): RelayFieldMap {
  return {
    schemaVersion: 1,
    stationId: "veloera",
    endpoints: {
      pricing: {
        path: "api/pricing",
        auth: false,
        itemsPath: "data",
        fieldsApplyTo: "items",
        itemsField: "models",
        fields: {
          groups: { path: "group_ratio", reader: "entries" },
          groupDescriptions: { path: "usable_group", reader: "entries" },
          modelId: { path: "name" },
          modelInputRatio: { path: "ratio" },
          modelCompletionRatio: { path: "completion_ratio", fallback: 1 },
          modelGroups: { path: "enable_groups", reader: "array" },
          modelPerCallFlag: { path: "no_create_ratio" },
        },
      },
      models: {
        path: "api/user/models",
        auth: true,
        fields: { keyModels: { path: "data", reader: "array" } },
      },
      balance: {
        path: "api/user/self",
        auth: true,
        fields: {
          balanceRemaining: { path: "data.quota", scale: 0.000002 },
          balanceUsed: { path: "data.used_quota", scale: 0.000002 },
        },
      },
    },
  };
}

describe("relay field mapping parser", () => {
  it("reads entries reader as name/value pairs", () => {
    const payload = { group_ratio: { vip: 0.8, default: 1 } };
    const value = readMappedField(payload, { path: "group_ratio", reader: "entries" });
    expect(value).toEqual([
      ["vip", 0.8],
      ["default", 1],
    ]);
  });

  it("reads array reader through itemField", () => {
    const payload = { data: [{ id: "m1" }, { id: "m2" }] };
    const value = readMappedField(payload, { path: "data", reader: "array", itemField: "id" });
    expect(value).toEqual(["m1", "m2"]);
  });

  it("leaves raw value to the numeric mapping layer", () => {
    const payload = { remaining: 500 };
    // readMappedField 只取原始值；换算发生在 applyNumericMapping / applyBalanceMapping。
    const value = readMappedField(payload, { path: "remaining" });
    expect(value).toBe(500);
  });

  it("maps a veloera-style pricing payload into rows", () => {
    const payload = {
      group_ratio: { default: 1, vip: 0.5 },
      usable_group: { default: "default group" },
      data: [
        {
          name: "gemini-3-flash",
          ratio: 0.11,
          completion_ratio: 3,
          enable_groups: ["default", "vip"],
        },
        {
          name: "sora-2",
          no_create_ratio: 1,
          ratio: 0,
          enable_groups: ["default"],
        },
      ],
    };
    const mapping = veloeraStyleMapping();
    const resolved = resolveEndpoint(payload, mapping.endpoints.pricing!);
    const { rows, groups } = applyPricingMapping(resolved, "veloera", new Set(["gemini-3-flash"]));

    expect(groups.map((group) => group.name).sort()).toEqual(["default", "vip"]);
    expect(groups.find((group) => group.name === "default")?.description).toBe("default group");

    const tokenRow = rows.find((row) => row.modelId === "gemini-3-flash" && row.group === "vip");
    // input = $2 × 0.11 × 0.5 = 0.11; output = ×3; cache = ×0.
    expect(tokenRow?.inputPer1M).toBeCloseTo(0.11, 6);
    expect(tokenRow?.outputPer1M).toBeCloseTo(0.33, 6);
    expect(tokenRow?.cachePer1M).toBeCloseTo(0, 6);
    expect(tokenRow?.keyAvailable).toBe(true);

    const vipRow = rows.find((row) => row.modelId === "gemini-3-flash" && row.group === "default");
    // keyAvailable 只看 key 的模型列表（与分组无关）。
    expect(vipRow?.keyAvailable).toBe(true);

    // no_create_ratio ≠ 0 → per-call with fallback callPrice = 0 × groupRatio.
    const callRow = rows.find((row) => row.modelId === "sora-2");
    expect(callRow?.callPrice).not.toBeNull();
    expect(callRow?.inputPer1M).toBeNull();
  });

  it("supports divideBy to express absolute prices as relative ratios", () => {
    // laneai 风格：站点给出每百万 token 的绝对价（微元），而本地语义要求
    // 输出/缓存存「相对输入价的倍数」→ 用 divideBy 逐行相除。
    const payload = {
      data: [
        {
          model_name: "test-model",
          input_price_micro_per_1m: 133000,
          output_price_micro_per_1m: 532000,
          cache_price_micro_per_1m: 1000,
          channel_name: "备用渠道",
        },
      ],
    };
    const mapping: RelayFieldMap = {
      schemaVersion: 1,
      stationId: "laneai",
      endpoints: {
        pricing: {
          path: "/api/models",
          auth: false,
          fieldsApplyTo: "items",
          itemsPath: "data",
          fields: {
            modelId: { path: "model_name" },
            modelInputRatio: { path: "input_price_micro_per_1m", scale: 5e-7 },
            modelCompletionRatio: {
              path: "output_price_micro_per_1m",
              scale: 5e-7,
              divideBy: "modelInputRatio",
            },
            modelCacheRatio: {
              path: "cache_price_micro_per_1m",
              scale: 5e-7,
              divideBy: "modelInputRatio",
            },
            modelGroups: { path: "channel_name" },
          },
        },
      },
    };
    const resolved = resolveEndpoint(payload, mapping.endpoints.pricing!);
    const { rows } = applyPricingMapping(resolved, "laneai", new Set());

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // input = $2 × (133000 × 5e-7) × 1 = 0.133；output = ×4；cache = ×0.007519…
    expect(row.inputPer1M).toBeCloseTo(0.133, 9);
    expect(row.outputPer1M).toBeCloseTo(0.532, 9);
    expect(row.cachePer1M).toBeCloseTo(0.001, 9);
  });

  it("treats a string flag match (equals) as per-call billing", () => {
    // laneai 风格：billing_mode: "flat" 表示按次计费，无数字型标记字段。
    const payload = {
      data: [
        {
          model_name: "flat-model",
          billing_mode: "flat",
          price_micro: 9000,
          input_price_micro_per_1m: 20000,
          output_price_micro_per_1m: 800000,
          channel_name: "按次分组",
        },
        {
          model_name: "token-model",
          billing_mode: "token",
          price_micro: 0,
          input_price_micro_per_1m: 133000,
          output_price_micro_per_1m: 532000,
          channel_name: "按量分组",
        },
      ],
    };
    const mapping: RelayFieldMap = {
      schemaVersion: 1,
      stationId: "laneai",
      endpoints: {
        pricing: {
          path: "/api/models",
          auth: false,
          fieldsApplyTo: "items",
          itemsPath: "data",
          fields: {
            modelId: { path: "model_name" },
            modelPerCallFlag: { path: "billing_mode", equals: "flat" },
            modelCallPrice: { path: "price_micro", scale: 1e-6 },
            modelInputRatio: { path: "input_price_micro_per_1m", scale: 5e-7 },
            modelGroups: { path: "channel_name" },
          },
        },
      },
    };
    const resolved = resolveEndpoint(payload, mapping.endpoints.pricing!);
    const { rows } = applyPricingMapping(resolved, "laneai", new Set());

    const flatRow = rows.find((row) => row.modelId === "flat-model");
    expect(flatRow?.callPrice).toBeCloseTo(0.009, 9);
    expect(flatRow?.inputPer1M).toBeNull();

    const tokenRow = rows.find((row) => row.modelId === "token-model");
    expect(tokenRow?.callPrice).toBeNull();
    expect(tokenRow?.inputPer1M).toBeCloseTo(0.133, 9);
  });

  it("falls back to a default group when the station has no group concept", () => {
    // laneai 风格站点：/api/models 返回每模型价格（分/1M），响应里既没有
    // group_ratio 也没有 enable_groups —— 此前这种站点 rows 恒为 0 且不报错。
    const payload = {
      code: 200,
      msg: "success",
      data: [
        {
          model_name: "grok-4.5",
          input_price_fen_per_1m: 28,
          output_price_fen_per_1m: 84,
          cache_price_fen_per_1m: 7,
        },
      ],
    };
    const mapping: RelayFieldMap = {
      schemaVersion: 1,
      stationId: "laneai",
      endpoints: {
        pricing: {
          path: "/api/models",
          auth: false,
          fieldsApplyTo: "items",
          itemsPath: "data",
          fields: {
            modelId: { path: "model_name" },
            modelInputRatio: {
              path: "input_price_fen_per_1m",
              // 分 → 美元：1 美元 = 7 分率基准（与真实映射表一致）。
              scale: 0.00014285714285714284,
            },
            modelCompletionRatio: {
              path: "output_price_fen_per_1m",
              scale: 0.00014285714285714284,
            },
            modelCacheRatio: {
              path: "cache_price_fen_per_1m",
              scale: 0.00014285714285714284,
            },
          },
        },
      },
    };
    const resolved = resolveEndpoint(payload, mapping.endpoints.pricing!);
    const { rows, groups } = applyPricingMapping(resolved, "laneai", new Set());

    // 回退到 default 虚拟分组，行不再被丢弃。
    expect(groups.map((group) => group.name)).toEqual(["default"]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.group).toBe("default");
    expect(row.groupRatio).toBe(1);
    // 行价 = RELAY_BASE_PRICE_PER_1M(2) × ratio × groupRatio，ratio 是 scale
    // 后的值（28 分 → 0.004），所以 input 行价为 0.008。
    expect(row.inputPer1M).toBeCloseTo(0.008, 6);
  });

  it("accepts a single-string group name and synonizes missing ratio entries", () => {
    // laneai 风格：modelGroups 映射到 channel_code（单个字符串而非数组），
    // 且响应里没有 group_ratio 倍率表 —— 分组名来自行自身，倍率缺省 1。
    const payload = {
      code: 200,
      data: [
        {
          model_name: "grok-4.5",
          channel_code: "限时国模福利按量分组",
          input_price_fen_per_1m: 28,
        },
        { model_name: "glm-5", channel_code: "deepseek", input_price_fen_per_1m: 10 },
      ],
    };
    const mapping: RelayFieldMap = {
      schemaVersion: 1,
      stationId: "laneai",
      endpoints: {
        pricing: {
          path: "/api/models",
          auth: false,
          fieldsApplyTo: "items",
          itemsPath: "data",
          fields: {
            modelId: { path: "model_name" },
            modelInputRatio: { path: "input_price_fen_per_1m", scale: 0.00014285714285714284 },
            modelGroups: { path: "channel_code" },
          },
        },
      },
    };
    const resolved = resolveEndpoint(payload, mapping.endpoints.pricing!);
    const { rows, groups } = applyPricingMapping(resolved, "laneai", new Set());

    // 行自带的分组名成为分组表条目（倍率 1），行保留真实分组名。
    expect(groups.map((group) => group.name).sort()).toEqual(["deepseek", "限时国模福利按量分组"]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.modelId === "grok-4.5")?.group).toBe("限时国模福利按量分组");
    expect(rows.every((row) => row.groupRatio === 1)).toBe(true);
  });

  it("maps key models and balance with scale", () => {
    const mapping = veloeraStyleMapping();
    const modelsResolved = resolveEndpoint(
      { data: ["gpt-x", "claude-y"] },
      mapping.endpoints.models!,
    );
    expect(applyModelsMapping(modelsResolved).keyModels).toEqual(["gpt-x", "claude-y"]);

    const balanceResolved = resolveEndpoint(
      { data: { quota: 2500000, used_quota: 1000000 } },
      mapping.endpoints.balance!,
    );
    const mapped = applyBalanceMapping(balanceResolved);
    expect(mapped.remaining).toBeCloseTo(5, 6);
    expect(mapped.used).toBeCloseTo(2, 6);
    expect(mapped.unlimited).toBe(false);

    const balance = balanceFromMapping("veloera", mapped, "now");
    expect(balance.ok).toBe(true);
    expect(balance.remainingUsd).toBeCloseTo(5, 6);
    expect(balance.totalUsageUsd).toBeCloseTo(2, 6);
  });

  it("marks unlimited above the mapped threshold", () => {
    const resolved = resolveEndpoint(
      { remaining: 999999999 },
      {
        path: "x",
        auth: false,
        fields: {
          balanceRemaining: { path: "remaining" },
          balanceUnlimitedValue: { path: "$", fallback: 0 },
        },
      },
    );
    resolved.scalars.set("balanceUnlimitedValue", 1_000_000);
    const mapped = applyBalanceMapping(resolved);
    expect(mapped.unlimited).toBe(true);
    expect(mapped.remaining).toBe(999999999);
  });
});

describe("relay mapping store", () => {
  it("round-trips a mapping table and rejects escaping ids", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    expect(store.get("hetune")).toBeNull();
    expect(store.getActive("hetune")).toBeNull();

    const mapping = { ...veloeraStyleMapping(), stationId: "hetune" };
    store.set("hetune", mapping);
    const path = store.mappingPath("hetune");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ stationId: "hetune" });
    expect(store.get("hetune")?.endpoints.balance?.path).toBe("api/user/self");
    expect(store.listStationIds()).toEqual(["hetune"]);

    // disabled → treated as absent by getActive but still readable by get.
    store.set("hetune", { ...mapping, enabled: false });
    expect(store.get("hetune")?.enabled).toBe(false);
    expect(store.getActive("hetune")).toBeNull();

    store.set("hetune", null);
    expect(store.get("hetune")).toBeNull();
    expect(store.listStationIds()).toEqual([]);

    expect(() => store.mappingPath("../escape")).toThrow();
    expect(() => store.mappingPath("a/b")).toThrow();
  });

  it("treats corrupt JSON as no mapping", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    const path = store.mappingPath("x");
    store.set("x", { ...veloeraStyleMapping(), stationId: "x" });
    writeFileSync(path, "{broken");
    expect(store.get("x")).toBeNull();
  });

  it("retires a table instead of deleting it, and reactivates only same-station providers", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    store.set("7", { ...veloeraStyleMapping(), stationId: "7" });

    // 软停用：文件仍在，get/resolve 视为无映射。
    expect(store.retire("7", { lastBaseUrl: "https://hetune.top/v1" })).toBe(true);
    expect(store.get("7")).not.toBeNull();
    expect(store.getActive("7")).toBeNull();
    expect(store.resolve("7", "https://hetune.top/v1")).toBeNull();
    expect(readFileSync(store.mappingPath("7"), "utf8")).toContain("[site] https://hetune.top/v1");
    // 幂等。
    expect(store.retire("7", { lastBaseUrl: "https://hetune.top/v1" })).toBe(false);

    // 同站同 id 复活：enabled 回 true 并补共享声明。
    expect(store.reactivate("7", "https://cf.hetune.top/v1")).toBe(true);
    expect(store.getActive("7")?.enabled).not.toBe(false);
    expect(store.getActive("7")?.shareByBaseUrl).toContain("hetune.top");

    // 再次停用后，不同站的同 id 不能复活（防串站）。
    store.retire("7", { lastBaseUrl: "https://hetune.top/v1" });
    expect(store.reactivate("7", "https://api.deepseek.com/v1")).toBe(false);
    expect(store.getActive("7")).toBeNull();
    // 激活表不能 repeat reactivate。
    store.reactivate("7", "https://hetune.top/v1");
    expect(store.reactivate("7", "https://hetune.top/v1")).toBe(false);
  });

  it("reassigns a table to a surviving same-station provider on rename/remove", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    store.set("7", { ...veloeraStyleMapping(), stationId: "7" });

    // 迁移后新 id 生效、旧文件移除、stationId 改写。
    expect(store.reassign("7", "9")).toBe(true);
    expect(store.get("7")).toBeNull();
    expect(store.get("9")?.stationId).toBe("9");
    expect(store.listStationIds()).toContain("9");
    expect(readdirSync(store.rootDir()).some((name) => name.startsWith("7.json.removed-"))).toBe(
      true,
    );

    // 目标已有表时不覆盖；源无表时不动作。
    store.set("2", { ...veloeraStyleMapping(), stationId: "2" });
    expect(store.reassign("2", "9")).toBe(false);
    expect(store.get("2")).not.toBeNull();
    expect(store.reassign("404", "9")).toBe(false);
  });

  it("ensureSharedByBaseUrl backfills sharing for future same-station providers", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    store.set("7", { ...veloeraStyleMapping(), stationId: "7" });

    // 补写声明后，同站新 provider（无自己的表）解析到这张表。
    expect(store.ensureSharedByBaseUrl("7", "https://hetune.top/v1")).toBe(true);
    const shared = store.getActive("7");
    expect(shared?.shareByBaseUrl).toBe("https://hetune.top/v1");
    expect(shared?.shareScope).toBe("domain");
    expect(store.resolve("13", "https://api.hetune.top/v1")?.stationId).toBe("7");
    // 幂等：已是等价声明时不重复写入。
    expect(store.ensureSharedByBaseUrl("7", "https://hetune.top/v1/")).toBe(false);
    // 非法地址/无表时不动作。
    expect(store.ensureSharedByBaseUrl("7", "not-a-url")).toBe(false);
    expect(store.ensureSharedByBaseUrl("404", "https://hetune.top/v1")).toBe(false);
  });

  it("lists same-station providers that actually resolve to the base table", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);
    // base 表带共享声明（保存时 ensureSharedByBaseUrl 会自动补齐）。
    store.set("7", {
      ...veloeraStyleMapping(),
      stationId: "7",
      shareByBaseUrl: "https://hetune.top/v1",
      shareScope: "domain",
    });

    const others = [
      { id: "8", baseUrl: "https://cf.hetune.top/v1" }, // 同主域镜像：解析到 7 的表
      { id: "9", baseUrl: "https://hetune.top/v1" }, // 同 URL：解析到 7 的表
      { id: "13", baseUrl: "https://api.deepseek.com/v1" }, // 不同站：不算
      { id: "bad", baseUrl: "not-a-url" }, // 非法地址：不算
    ];
    expect(store.dependentProviderIds("7", "https://hetune.top/v1", others)).toEqual([
      "8",
      "9",
    ]);
    // 自己有过期旧站表的 provider 也算依赖者：本站表让位后实际解析到 base。
    store.set("10", {
      ...veloeraStyleMapping(),
      stationId: "10",
      shareByBaseUrl: "https://old-site.example/v1",
      shareScope: "domain",
    });
    expect(
      store
        .dependentProviderIds("7", "https://hetune.top/v1", [...others, { id: "10", baseUrl: "https://cf.hetune.top/v1" }])
        .sort(),
    ).toEqual(["10", "8", "9"].sort());
    // base 表停用后无依赖者。
    store.retire("7", { lastBaseUrl: "https://hetune.top/v1" });
    expect(store.dependentProviderIds("7", "https://hetune.top/v1", others)).toEqual([]);
  });

  it("lets a stale own-table defer to a shared table after the provider moved to another station", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);

    // 主站 1 的完整表（含 pricing），声明按主域共享。
    store.set("1", {
      ...veloeraStyleMapping(),
      stationId: "1",
      shareByBaseUrl: "https://x.top/v1",
      shareScope: "domain",
    });
    // provider 5 早期指向 old.example，表只有 key/余额端点（没有 pricing），
    // 后来 baseUrl 换到 x.top：旧表失配，应让位给同站的共享表。
    const keyOnlyTable = veloeraStyleMapping();
    store.set("5", {
      ...keyOnlyTable,
      stationId: "5",
      endpoints: {
        models: {
          path: "v1/models",
          auth: true,
          fields: { keyModels: { path: "data", reader: "array", itemField: "id" } },
        },
      },
    });

    // 无声明时：本站表无条件生效（旧行为）。
    expect(store.resolve("5", "https://x.top/v1")?.stationId).toBe("5");

    // 加上过期声明（旧站遗留）后：让位给同站共享表。
    store.set("5", {
      ...store.get("5")!,
      shareByBaseUrl: "https://old.example/v1",
      shareScope: "domain",
    });
    expect(store.resolve("5", "https://x.top/v1")?.stationId).toBe("1");
    expect(store.resolve("5", "https://cf.x.top/v1")?.stationId).toBe("1");
    // 声明站点与当前同站的表不受影响。
    expect(store.resolve("1", "https://cf.x.top/v1")?.stationId).toBe("1");
    // 无共享表可用时失配表仍然生效（聊胜于无）。
    store.set("1", null);
    expect(store.resolve("5", "https://x.top/v1")?.stationId).toBe("5");
  });

  it("shares one mapping across providers with the same baseUrl", () => {
    const layout = createTempAgentLayout("pi-relay-mapping-test-");
    layouts.push(layout);
    const store = new RelayMappingStore(layout.agentDir);

    // 主站 "7" 生成映射并声明按主域共享（cf./api./cdn. 镜像入口同站）。
    store.set("7", {
      ...veloeraStyleMapping(),
      stationId: "7",
      shareByBaseUrl: "https://hetune.top/v1",
      shareScope: "domain",
    });

    // 同主域镜像入口：复用 "7" 的表。
    expect(store.resolve("6", "https://cf.hetune.top/v1")?.stationId).toBe("7");
    // 同 URL 但未声明自己的表：复用。
    expect(store.resolve("13", "https://hetune.top/v1/")?.stationId).toBe("7");
    // 无关站点：不共享，回退内置默认。
    expect(store.resolve("10", "https://api.deepseek.com/v1")).toBeNull();

    // 显式本站表优先于共享表。
    store.set("6", { ...veloeraStyleMapping(), stationId: "6" });
    expect(store.resolve("6", "https://cf.hetune.top/v1")?.stationId).toBe("6");

    // 默认 scope "url"：主域相同但地址不同不算同一站。
    store.set("6", null);
    store.set("7", null);
    store.set("urlonly", {
      ...veloeraStyleMapping(),
      stationId: "urlonly",
      shareByBaseUrl: "https://hetune.top/v1",
    });
    expect(store.resolve("13", "https://hetune.top/v1")?.stationId).toBe("urlonly");
    expect(store.resolve("6", "https://cf.hetune.top/v1")).toBeNull();

    // 归一化与主域键。
    expect(normalizeRelayBaseUrl("HTTPS://HETUNE.top/v1/")).toBe("https://hetune.top/v1");
    expect(relayMainDomain("https://cf.hetune.top/v1")).toBe("hetune.top");
    expect(relayMainDomain("https://localhost:3117")).toBe("localhost");
    expect(relayMainDomain("https://192.168.1.2:3117")).toBe("192.168.1.2");
    expect(relayMainDomain("not a url")).toBeNull();
  });
});
