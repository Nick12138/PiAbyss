import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBalanceMapping,
  applyModelsMapping,
  applyPricingMapping,
  balanceFromMapping,
  readMappedField,
  resolveEndpoint,
} from "./relay-field-mapping.js";
import { RelayMappingStore } from "./relay-mapping-store.js";
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
});
