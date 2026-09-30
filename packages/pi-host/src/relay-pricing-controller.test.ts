import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayPricingHandlers, joinRelayEndpointUrl } from "./relay-pricing-controller.js";
import { RelayPricingStore } from "./relay-pricing-store.js";
import { PiHostServer } from "./server.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";
import { createTestModelServices, putApiKey } from "./test-helpers/model-runtime.js";
import { refreshModelsLocal } from "./model-runtime-refresh.js";
import { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { ModelConfigHealth, RelayBalance, RelayPricingResult } from "@piabyss/protocol";

const layouts: TempAgentLayout[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const layout of layouts.splice(0)) layout.cleanup();
});

/** Minimal new-api-style fixture endpoints. */
function startRelayServer(options: {
  pricing?: unknown;
  models?: unknown;
  subscription?: unknown;
  usage?: unknown;
  /** /api/pricing/{id} 二次请求：id → 响应体。 */
  groupDetail?: Record<string, unknown>;
  authExpected?: string;
}): Promise<string> {
  const server = createServer((request, response) => {
    const auth = request.headers.authorization;
    const publicPath = request.url === "/api/pricing";
    if (
      options.authExpected !== undefined &&
      !publicPath &&
      auth !== `Bearer ${options.authExpected}`
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    const body = (payload: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const detailMatch = options.groupDetail
      ? /^\/api\/pricing\/(\d+)$/.exec(request.url ?? "")
      : null;
    if (detailMatch && options.groupDetail) {
      const payload = options.groupDetail[detailMatch[1]!];
      if (payload === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      body(payload);
      return;
    }
    if (request.url === "/api/pricing") {
      body(options.pricing ?? { data: [], group_ratio: {}, usable_group: {} });
      return;
    }
    if (request.url === "/v1/models") {
      body(options.models ?? { data: [] });
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      body(options.subscription ?? { hard_limit_usd: 2 });
      return;
    }
    if (request.url === "/v1/dashboard/billing/usage") {
      body(options.usage ?? { total_usage: 0.05 });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  httpServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function setup(initialProviders: unknown) {
  const layout = createTempAgentLayout("pi-relay-pricing-test-");
  layouts.push(layout);
  writeFileSync(join(layout.agentDir, "models.json"), JSON.stringify(initialProviders, null, 2));
  const { credentialStore, modelRuntime, modelRegistry, providerOwnership } =
    await createTestModelServices(layout.agentDir);
  const health: ModelConfigHealth = {
    state: modelRuntime.getError() ? "error" : "ok",
    source: "ModelRegistry.getError",
  };
  const factory = new WorkspaceGraphFactory({
    agentDir: layout.agentDir,
    credentialStore,
    modelRuntime,
    modelRegistry,
    providerOwnership,
    getModelConfigHealth: () => health,
    refreshModelHealth: async (signal) => {
      await refreshModelsLocal(modelRuntime, { signal });
      return health;
    },
    packageUpdateCheck: false,
  });
  const server = new PiHostServer({
    agentDir: layout.agentDir,
    sdkVersion: "test",
    getModelConfigHealth: () => health,
    capabilities: { packageUpdateCheck: false, extensionUi: true, sessionExport: true },
    handlers: {},
  });
  factory.bindServer(server);
  return { layout, credentialStore, factory, handlers: createRelayPricingHandlers(factory) };
}

const RELAY_PROVIDER = {
  providers: {
    hetune: {
      name: "河图 API",
      baseUrl: "PLACEHOLDER",
      api: "openai-completions",
      models: [
        {
          id: "glm-5.3-flash",
          name: "glm-5.3-flash",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
    other: {
      name: "别家",
      baseUrl: "https://other.example.com",
      api: "openai-completions",
      models: [],
    },
  },
};

const PRICING_FIXTURE = {
  data: [
    {
      model_name: "glm-5.3-flash",
      vendor_id: 1,
      quota_type: 0,
      model_ratio: 0.052,
      completion_ratio: 3.5,
      cache_ratio: 0.1,
      enable_groups: ["国模统一分组"],
      supported_endpoint_types: ["openai"],
    },
    {
      model_name: "nano-banana-pro",
      quota_type: 1,
      model_price: 0.15,
      enable_groups: ["国模统一分组"],
      supported_endpoint_types: ["openai-image"],
    },
  ],
  group_ratio: { 国模统一分组: 1 },
  usable_group: { 国模统一分组: "国模" },
  vendors: [{ id: 1, name: "Zhipu" }],
};

describe("RelayPricingStore", () => {
  it("starts empty and round-trips a table atomically", () => {
    const layout = createTempAgentLayout("pi-relay-store-test-");
    layouts.push(layout);
    const store = new RelayPricingStore(layout.agentDir);
    expect(store.getTable().stations).toEqual([]);
    expect(store.getRatio("hetune")).toEqual({ cny: 1, balance: 1 });
    store.setRatio("hetune", { cny: 1, balance: 5 });
    expect(store.getRatio("hetune")).toEqual({ cny: 1, balance: 5 });
    expect(store.setRatio("hetune", null)).toBeNull();
    expect(store.getRatio("hetune")).toEqual({ cny: 1, balance: 1 });
  });

  it("treats corrupt JSON as empty with a corrupt backup", () => {
    const layout = createTempAgentLayout("pi-relay-store-test-");
    layouts.push(layout);
    const store = new RelayPricingStore(layout.agentDir);
    store.saveTable({
      schemaVersion: 1,
      stations: [
        {
          stationId: "x",
          providerId: "x",
          baseUrl: "http://x",
          groups: [],
          rows: [],
          keyModels: [],
          balance: null,
          fetchedAt: "now",
        },
      ],
    });
    writeFileSync(join(layout.agentDir, "piabyss", "relay-pricing", "pricing.json"), "{broken");
    expect(store.getTable().stations).toEqual([]);
  });

  it("prunes stations whose provider no longer exists, keeping manual ones", () => {
    const layout = createTempAgentLayout("pi-relay-store-test-");
    layouts.push(layout);
    const store = new RelayPricingStore(layout.agentDir);
    const base = {
      groups: [],
      rows: [],
      keyModels: [],
      balance: null,
      fetchedAt: "now",
    };
    store.saveTable({
      schemaVersion: 1,
      stations: [
        { stationId: "live", providerId: "live", baseUrl: "http://live", ...base },
        { stationId: "dead", providerId: "dead", baseUrl: "http://dead", ...base },
        { stationId: "manual", providerId: null, baseUrl: "http://manual", ...base },
      ],
    });
    const removed = store.pruneStations(new Set(["live"]));
    expect(removed).toBe(1);
    const stations = store.getTable().stations;
    expect(stations.map((station) => station.stationId)).toEqual(["live", "manual"]);
    // No-op prune leaves the file untouched.
    expect(store.pruneStations(new Set(["live", "other"]))).toBe(0);
  });
});

describe("relay pricing handlers", () => {
  describe("joinRelayEndpointUrl", () => {
    it("resolves endpoint paths with real URL semantics", () => {
      // baseUrl 带 /v1 后缀的站：根相对 /api/pricing 不得拼成 /v1/api/pricing。
      expect(joinRelayEndpointUrl("https://yujianwudi.top/v1", "/api/pricing")).toBe(
        "https://yujianwudi.top/api/pricing",
      );
      expect(joinRelayEndpointUrl("https://yujianwudi.top/v1", "models")).toBe(
        "https://yujianwudi.top/models",
      );
      expect(joinRelayEndpointUrl("https://api.rivoapi.com", "/api/pricing")).toBe(
        "https://api.rivoapi.com/api/pricing",
      );
      expect(joinRelayEndpointUrl("https://x.top/v1/", "../v2/models")).toBe(
        "https://x.top/v2/models",
      );
      expect(joinRelayEndpointUrl("https://x.top/v1", "https://other.io/pricing")).toBe(
        "https://other.io/pricing",
      );
    });
  });

  it("fetches pricing, expands rows, and persists balance", async () => {
    const baseUrl = await startRelayServer({
      pricing: PRICING_FIXTURE,
      models: { data: [{ id: "glm-5.3-flash" }] },
      subscription: { hard_limit_usd: 2.000034 },
      usage: { total_usage: 0.0584 },
      authExpected: "sk-test",
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { layout, credentialStore, factory, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const fetchResult = await handlers["provider.pricing.fetch"]!({
      id: "req-1",
      method: "provider.pricing.fetch",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: factory.getServer()!.identity.hostInstanceId },
    } as never);
    if (!("result" in fetchResult)) throw new Error(JSON.stringify(fetchResult));
    const fetchResultr = fetchResult.result as RelayPricingResult;
    expect(fetchResultr.cached).toBe(false);
    const station = fetchResultr.table.stations[0]!;
    expect(station.stationId).toBe("hetune");
    expect(station.providerId).toBe("hetune");
    expect(station.balance?.ok).toBe(true);
    // one-api 语义：hard_limit_usd 即剩余额度；total_usage 为美分，/100 换算美元。
    expect(station.balance?.remainingUsd).toBeCloseTo(2.000034, 5);
    expect(station.balance?.totalUsageUsd).toBeCloseTo(0.000584, 6);
    // Token row: $2 × 0.052 × 1 = 0.104 in; ×3.5 = 0.364 out; ×0.1 cache.
    const tokenRow = station.rows.find((row) => row.modelId === "glm-5.3-flash");
    expect(tokenRow?.inputPer1M).toBeCloseTo(0.104, 6);
    expect(tokenRow?.outputPer1M).toBeCloseTo(0.364, 6);
    expect(tokenRow?.cachePer1M).toBeCloseTo(0.0104, 6);
    expect(tokenRow?.keyAvailable).toBe(true);
    // Per-call row: 0.15 × 1.
    const callRow = station.rows.find((row) => row.modelId === "nano-banana-pro");
    expect(callRow?.callPrice).toBeCloseTo(0.15, 6);
    expect(callRow?.inputPer1M).toBeNull();
    expect(callRow?.keyAvailable).toBe(false);

    // Persisted to the isolated file, readable by a fresh store instance.
    const persisted = new RelayPricingStore(layout.agentDir).getTable();
    expect(persisted.stations).toHaveLength(1);
    expect(persisted.stations[0]!.rows.length).toBe(2);
  });

  it("reports unlimited balance above the threshold", async () => {
    const baseUrl = await startRelayServer({
      pricing: { data: [], group_ratio: {} },
      subscription: { hard_limit_usd: 100000000 },
      usage: { total_usage: 0 },
      authExpected: "sk-test",
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const result = await handlers["provider.balance.get"]!({
      id: "req-2",
      method: "provider.balance.get",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const resultr = result.result as RelayBalance;
    expect(resultr.unlimited).toBe(true);
    expect(resultr.remainingUsd).toBeNull();
  });

  it("caches balance and serves it without network on the next call", async () => {
    const baseUrl = await startRelayServer({
      subscription: { hard_limit_usd: 5 },
      usage: { total_usage: 1 },
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { layout, credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const first = await handlers["provider.balance.get"]!({
      id: "req-3",
      method: "provider.balance.get",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in first)) throw new Error(JSON.stringify(first));
    const firstr = first.result as RelayBalance;
    // hard_limit_usd = 剩余 5；total_usage = 1 美分 = $0.01 已用。
    expect(firstr.remainingUsd).toBeCloseTo(5, 5);
    expect(firstr.totalUsageUsd).toBeCloseTo(0.01, 6);

    // Kill the server: the cached path must not touch the network.
    await new Promise<void>((resolve) => {
      const server = httpServers.pop()!;
      server.close(() => resolve());
    });

    const cached = await handlers["provider.balance.get"]!({
      id: "req-3b",
      method: "provider.balance.get",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in cached)) throw new Error(JSON.stringify(cached));
    const cachedr = cached.result as RelayBalance;
    expect(cachedr.hardLimitUsd).toBe(5);

    // refresh=true must re-hit the (now dead) network and report failure.
    const refreshed = await handlers["provider.balance.get"]!({
      id: "req-3c",
      method: "provider.balance.get",
      params: { providerId: "hetune", refresh: true },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in refreshed)) throw new Error(JSON.stringify(refreshed));
    const refreshedr = refreshed.result as RelayBalance;
    expect(refreshedr.ok).toBe(false);
    expect(refreshedr.error).toBeTruthy();
    void layout;
  });

  it("strips the /v1 suffix from baseUrl for built-in default endpoints", async () => {
    // 川流Luna 现象：baseUrl 带 /v1 时，内置 new-api 默认端点不得拼出 /v1/v1/...。
    const baseUrl = await startRelayServer({
      subscription: { hard_limit_usd: 7 },
      usage: { total_usage: 0.5 },
    });
    const server = httpServers[0]!;
    const requested: string[] = [];
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      requested.push(request.url ?? "");
      if (request.url === "/v1/dashboard/billing/subscription") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ hard_limit_usd: 7 }));
        return;
      }
      if (request.url === "/v1/dashboard/billing/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ total_usage: 0.5 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = `${baseUrl}/v1`;
    const { credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const result = await handlers["provider.balance.get"]!({
      id: "req-v1",
      method: "provider.balance.get",
      params: { providerId: "hetune", refresh: true },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const balance = result.result as RelayBalance;
    expect(balance.ok).toBe(true);
    expect(balance.remainingUsd).toBeCloseTo(7, 5);
    // 请求路径没有 /v1/v1/。
    expect(requested.every((url) => !url.includes("/v1/v1/"))).toBe(true);
  });

  it("uses a built-in balance preset for matching domains (NingYi /v1/usage)", async () => {
    // NingYi 非 new-api 风格：/v1/dashboard/* 全 404，余额在 /v1/usage。
    const baseUrl = await startRelayServer({});
    const server = httpServers[0]!;
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      if (request.url === "/v1/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            balance: 7.17589596,
            remaining: 7.17589596,
            unit: "USD",
            usage: { total_cost: 0.018 },
          }),
        );
        return;
      }
      // new-api 默认端点故意 404：预设命中时不应被请求到。
      response.writeHead(404);
      response.end();
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl.replace("127.0.0.1", "127.0.0.1.nip.io");
    const { credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const result = await handlers["provider.balance.get"]!({
      id: "req-preset",
      method: "provider.balance.get",
      params: { providerId: "hetune", refresh: true },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const balance = result.result as RelayBalance;
    expect(balance.ok).toBe(true);
    expect(balance.remainingUsd).toBeCloseTo(7.17589596, 6);
    expect(balance.totalUsageUsd).toBeCloseTo(0.018, 6);
  });

  it("falls back to /v1/usage shape probe when new-api defaults fail", async () => {
    // NingYi 式网关：/v1/dashboard/* 全 404，余额在 GET /v1/usage 顶层 balance。
    const baseUrl = await startRelayServer({});
    const server = httpServers[0]!;
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      if (request.url === "/v1/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            balance: 7.17589596,
            remaining: 7.17589596,
            unit: "USD",
            usage: { total_cost: 0.018 },
          }),
        );
        return;
      }
      // new-api 默认端点故意 404。
      response.writeHead(404);
      response.end();
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    const result = await handlers["provider.balance.get"]!({
      id: "req-preset",
      method: "provider.balance.get",
      params: { providerId: "hetune", refresh: true },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const balance = result.result as RelayBalance;
    expect(balance.ok).toBe(true);
    expect(balance.remainingUsd).toBeCloseTo(7.17589596, 6);
    expect(balance.totalUsageUsd).toBeCloseTo(0.018, 6);
  });

  it("refreshes only the requested providers when providerIds is given", async () => {
    const baseUrl = await startRelayServer({
      pricing: PRICING_FIXTURE,
      authExpected: "sk-test",
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    config.providers.other = {
      name: "别家",
      baseUrl,
      api: "openai-completions",
      models: [],
    };
    const { handlers } = await setup(config);

    const partial = await handlers["provider.pricing.fetch"]!({
      id: "req-pid",
      method: "provider.pricing.fetch",
      params: { providerIds: ["hetune"] },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in partial)) throw new Error(JSON.stringify(partial));
    const stations = (partial.result as RelayPricingResult).table.stations;
    // 只刷新 hetune：other 不会被建快照，全量刷新的 prune 也不会误删。
    expect(stations.map((station) => station.stationId)).toEqual(["hetune"]);

    // 两个站都刷新：各落一份快照。
    const both = await handlers["provider.pricing.fetch"]!({
      id: "req-pid2",
      method: "provider.pricing.fetch",
      params: { providerIds: ["hetune", "other"] },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in both)) throw new Error(JSON.stringify(both));
    expect(
      (both.result as RelayPricingResult).table.stations.map((station) => station.stationId).sort(),
    ).toEqual(["hetune", "other"]);
  });

  it("fetches per-model group details via a second request (groupsDetail)", async () => {
    // CodeFlow 风格：/api/pricing 给模型+价格（数字 id），/api/pricing/{id}
    // 给该模型的分组（[{name, multiplier, description}]）。
    const baseUrl = await startRelayServer({
      pricing: {
        models: [
          {
            id: 1,
            model: "model-a",
            inputPricePerMillionTokens: 5,
            outputPricePerMillionTokens: 25,
          },
          {
            id: 2,
            model: "model-b",
            inputPricePerMillionTokens: 1,
            outputPricePerMillionTokens: 6,
          },
        ],
      },
      groupDetail: {
        "1": {
          groups: [
            { id: 2, name: "低价分组", description: "便宜", multiplier: 1 },
            { id: 4, name: "官方分组", description: "Max", multiplier: 9 },
          ],
        },
        "2": { groups: [{ id: 5, name: "Codex 官方分组", description: "", multiplier: 2 }] },
      },
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { handlers } = await setup(config);
    await handlers["provider.mapping.set"]!({
      id: "m0",
      method: "provider.mapping.set",
      params: {
        stationId: "hetune",
        mapping: {
          schemaVersion: 1,
          stationId: "hetune",
          endpoints: {
            pricing: {
              path: "api/pricing",
              auth: false,
              fieldsApplyTo: "items",
              itemsPath: "models",
              fields: {
                modelId: { path: "model" },
                modelDetailKey: { path: "id" },
                modelInputRatio: { path: "inputPricePerMillionTokens", scale: 0.002 },
                modelCompletionRatio: { path: "outputPricePerMillionTokens", scale: 0.002 },
              },
            },
            groupsDetail: {
              path: "api/pricing/{modelDetailKey}",
              auth: false,
              fields: {
                groups: {
                  path: "groups",
                  reader: "entries",
                  itemField: "name",
                  itemValueField: "multiplier",
                },
                groupDescriptions: {
                  path: "groups",
                  reader: "entries",
                  itemField: "name",
                  itemValueField: "description",
                },
              },
            },
          },
        },
      },
      context: { expectedHostInstanceId: "x" },
    } as never);

    const result = await handlers["provider.pricing.fetch"]!({
      id: "m1",
      method: "provider.pricing.fetch",
      params: { providerIds: ["hetune"] },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const station = (result.result as RelayPricingResult).table.stations[0]!;
    expect(station.error).toBeUndefined();

    // 分组合并自两次详情请求。
    expect(station.groups.map((g) => g.name).sort()).toEqual([
      "Codex 官方分组",
      "低价分组",
      "官方分组",
    ]);
    expect(station.groups.find((g) => g.name === "官方分组")?.ratio).toBe(9);
    expect(station.groups.find((g) => g.name === "官方分组")?.description).toBe("Max");

    // 每行按详情端点返回的分组展开（一个模型 N 组 = N 行，各带各的倍率），
    // 且价格按该分组的倍率重算（主端点解析时倍率表还没有）。
    expect(station.rows).toHaveLength(3);
    const rowALow = station.rows.find((r) => r.modelId === "model-a" && r.group === "低价分组")!;
    expect(rowALow.groupRatio).toBe(1);
    // model-a input = 5 百万分/1M × 0.002 = 0.01 相对倍率 → $2 × 0.01 × 1 = $0.02。
    expect(rowALow.inputPer1M).toBeCloseTo(0.02, 6);
    const rowAOff = station.rows.find((r) => r.modelId === "model-a" && r.group === "官方分组")!;
    expect(rowAOff.groupRatio).toBe(9);
    // ×9 分组价格是 ×1 的 9 倍。
    expect(rowAOff.inputPer1M).toBeCloseTo(0.18, 6);
    expect(rowAOff.outputPer1M).toBeCloseTo(rowALow.outputPer1M! * 9, 6);
    const rowB = station.rows.find((r) => r.modelId === "model-b")!;
    expect(rowB.group).toBe("Codex 官方分组");
    expect(rowB.groupRatio).toBe(2);
    // model-b input = 1 × 0.002 = 0.002 → $2 × 0.002 × 2(组倍率) = $0.008。
    expect(rowB.inputPer1M).toBeCloseTo(0.008, 6);
  });

  it("maps CodeFlow-style absolute per-1M prices and per-model group details", async () => {
    // CodeFlow 风格：/api/pricing 的 models[] 给美元/每百万 token 的绝对单价
    //（不是 new-api 倍率），分组不在主响应里，需按数字 id 二次请求
    // /api/pricing/{id}。映射表用 divideBy 把绝对价换算成相对倍率：
    //   输入倍率 = 绝对输入价 / 2（modelEndpoints 字段借用为常量 2 持有者）；
    //   输出/缓存倍率 = 对应绝对价 / 绝对输入价（divideBy modelInputRatio）。
    const baseUrl = await startRelayServer({
      pricing: {
        models: [
          {
            id: 3,
            model: "claude-opus-x",
            inputPricePerMillionTokens: 5,
            outputPricePerMillionTokens: 25,
            cachedInputPricePerMillionTokens: 0.5,
          },
          {
            id: 9,
            model: "gpt-y",
            inputPricePerMillionTokens: 10,
            outputPricePerMillionTokens: 50,
            cachedInputPricePerMillionTokens: 1,
          },
        ],
      },
      groupDetail: {
        "3": {
          groups: [
            { id: 1, name: "低价分组", description: "Kiro", multiplier: 1 },
            { id: 4, name: "官方分组", description: "Max 20x", multiplier: 9 },
          ],
        },
        "9": { groups: [{ id: 2, name: "Codex 官方分组", description: "", multiplier: 2 }] },
      },
    });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { handlers } = await setup(config);
    await handlers["provider.mapping.set"]!({
      id: "cfm0",
      method: "provider.mapping.set",
      params: {
        stationId: "hetune",
        mapping: {
          schemaVersion: 1,
          stationId: "hetune",
          endpoints: {
            pricing: {
              path: "api/pricing",
              auth: false,
              fieldsApplyTo: "items",
              itemsPath: "models",
              fields: {
                modelId: { path: "model" },
                modelDetailKey: { path: "id" },
                modelEndpoints: { path: "__base", fallback: 2 },
                modelInputRatio: {
                  path: "inputPricePerMillionTokens",
                  divideBy: "modelEndpoints",
                },
                modelCompletionRatio: {
                  path: "outputPricePerMillionTokens",
                  divideBy: "modelInputRatio",
                },
                modelCacheRatio: {
                  path: "cachedInputPricePerMillionTokens",
                  divideBy: "modelInputRatio",
                },
              },
            },
            groupsDetail: {
              path: "api/pricing/{modelDetailKey}",
              auth: false,
              fields: {
                groups: {
                  path: "groups",
                  reader: "entries",
                  itemField: "name",
                  itemValueField: "multiplier",
                },
                groupDescriptions: {
                  path: "groups",
                  reader: "entries",
                  itemField: "name",
                  itemValueField: "description",
                },
              },
            },
          },
        },
      },
      context: { expectedHostInstanceId: "x" },
    } as never);

    const result = await handlers["provider.pricing.fetch"]!({
      id: "cfm1",
      method: "provider.pricing.fetch",
      params: { providerIds: ["hetune"] },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const station = (result.result as RelayPricingResult).table.stations[0]!;
    expect(station.error).toBeUndefined();

    // 分组合并自两次详情请求；同名分组跨模型共享倍率表。
    expect(station.groups.map((g) => g.name).sort()).toEqual([
      "Codex 官方分组",
      "低价分组",
      "官方分组",
    ]);
    expect(station.groups.find((g) => g.name === "官方分组")?.ratio).toBe(9);

    // 价格核对（绝对价语义，非倍率语义）：
    // opus 绝对输入价 $5：低价分组 ×1 → $5/$25/$0.5；官方分组 ×9 → $45。
    const opusLow = station.rows.find(
      (r) => r.modelId === "claude-opus-x" && r.group === "低价分组",
    )!;
    expect(opusLow.inputPer1M).toBeCloseTo(5, 6);
    expect(opusLow.outputPer1M).toBeCloseTo(25, 6);
    expect(opusLow.cachePer1M).toBeCloseTo(0.5, 6);
    expect(opusLow.groupRatio).toBe(1);
    const opusOfficial = station.rows.find(
      (r) => r.modelId === "claude-opus-x" && r.group === "官方分组",
    )!;
    expect(opusOfficial.inputPer1M).toBeCloseTo(45, 6);
    expect(opusOfficial.outputPer1M).toBeCloseTo(225, 6);
    expect(opusOfficial.groupRatio).toBe(9);
    // gpt 绝对输入价 $10、Codex 分组 ×2 → $20/$100。
    const gpt = station.rows.find((r) => r.modelId === "gpt-y" && r.group === "Codex 官方分组")!;
    expect(gpt.inputPer1M).toBeCloseTo(20, 6);
    expect(gpt.outputPer1M).toBeCloseTo(100, 6);
    expect(gpt.groupRatio).toBe(2);
  });

  it("redacts the api key from fetch errors", async () => {
    const baseUrl = await startRelayServer({ authExpected: "sk-secret" });
    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-secret");
    const result = await handlers["provider.pricing.fetch"]!({
      id: "req-4",
      method: "provider.pricing.fetch",
      params: null,
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in result)) throw new Error(JSON.stringify(result));
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("sk-secret");
  });

  it("persists and clears recharge ratios", async () => {
    const { layout, handlers } = await setup(RELAY_PROVIDER);
    const setResult = await handlers["provider.pricing.setRechargeRatio"]!({
      id: "req-5",
      method: "provider.pricing.setRechargeRatio",
      params: { providerId: "hetune", ratio: { cny: 0.98, balance: 1 } },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in setResult)) throw new Error(JSON.stringify(setResult));
    const setResultr = setResult.result as { ratio: unknown };
    expect(setResultr.ratio).toEqual({ cny: 0.98, balance: 1 });

    const pricingGet = await handlers["provider.pricing.get"]!({
      id: "req-6",
      method: "provider.pricing.get",
      params: null,
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in pricingGet)) throw new Error(JSON.stringify(pricingGet));
    const pricingGetr = pricingGet.result as RelayPricingResult;
    expect(pricingGetr.rechargeRatios.hetune).toEqual({ cny: 0.98, balance: 1 });
    expect(pricingGetr.cached).toBe(true);

    const cleared = await handlers["provider.pricing.setRechargeRatio"]!({
      id: "req-7",
      method: "provider.pricing.setRechargeRatio",
      params: { providerId: "hetune", ratio: null },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in cleared)) throw new Error(JSON.stringify(cleared));
    const clearedr = cleared.result as { ratio: unknown };
    expect(clearedr.ratio).toBeNull();
    expect(new RelayPricingStore(layout.agentDir).getRatios().hetune).toBeUndefined();
  });

  it("fetches through a custom field mapping and handsoff context for the Agent", async () => {
    // veloera 风格站点：字段名与 new-api 不同，余额单位是 quota（1 美元 = 500000）。
    const baseUrl = await startRelayServer({});
    const server = httpServers[0]!;
    // Swap the request handler for a veloera-style fixture.
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      const auth = request.headers.authorization;
      const body = (payload: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url === "/custom/pricing" && auth === "Bearer sk-test") {
        body({
          group_ratio: { default: 1 },
          records: [{ name: "glm-x", ratio: 0.1, completion_ratio: 2, groups: ["default"] }],
        });
        return;
      }
      if (request.url === "/custom/models") {
        body({ models: ["glm-x"] });
        return;
      }
      if (request.url === "/custom/balance") {
        body({ quota: 2500000, used: 500000 });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const config = structuredClone(RELAY_PROVIDER);
    config.providers.hetune.baseUrl = baseUrl;
    const { layout, credentialStore, handlers } = await setup(config);
    await putApiKey(credentialStore, "hetune", "sk-test");

    // Handoff first: no mapping yet — path + context for the Agent prompt.
    const handoff = await handlers["provider.mapping.handoff"]!({
      id: "req-m0",
      method: "provider.mapping.handoff",
      params: { stationId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in handoff)) throw new Error(JSON.stringify(handoff));
    const handoffr = handoff.result as {
      mappingPath: string;
      baseUrl: string;
      hasApiKey: boolean;
      mapping: unknown;
    };
    expect(handoffr.mapping).toBeNull();
    expect(handoffr.hasApiKey).toBe(true);
    expect(handoffr.baseUrl).toBe(baseUrl);
    expect(handoffr.mappingPath).toContain(join("mappings", "hetune.json"));

    // Get mapping: null before the table exists.
    const before = await handlers["provider.mapping.get"]!({
      id: "req-m1",
      method: "provider.mapping.get",
      params: { stationId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in before)) throw new Error(JSON.stringify(before));
    expect((before.result as { mapping: unknown }).mapping).toBeNull();

    // The Agent's mapping table: everything points at the custom endpoints.
    const mappingTable = {
      schemaVersion: 1 as const,
      stationId: "hetune",
      endpoints: {
        pricing: {
          path: "custom/pricing",
          auth: true,
          fieldsApplyTo: "items" as const,
          itemsField: "models" as const,
          itemsPath: "records",
          fields: {
            groups: { path: "group_ratio", reader: "entries" as const },
            modelId: { path: "name" },
            modelInputRatio: { path: "ratio" },
            modelCompletionRatio: { path: "completion_ratio", fallback: 1 },
            modelGroups: { path: "groups", reader: "array" as const },
          },
        },
        models: {
          path: "custom/models",
          auth: true,
          fields: { keyModels: { path: "models", reader: "array" as const } },
        },
        balance: {
          path: "custom/balance",
          auth: true,
          fields: {
            balanceRemaining: { path: "quota", scale: 0.000002 },
            balanceUsed: { path: "used", scale: 0.000002 },
          },
        },
      },
    };

    const set = await handlers["provider.mapping.set"]!({
      id: "req-m2",
      method: "provider.mapping.set",
      params: { stationId: "hetune", mapping: mappingTable },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in set)) throw new Error(JSON.stringify(set));
    expect((set.result as { mapping: { stationId: string } }).mapping.stationId).toBe("hetune");

    // Fetch now flows through the mapping: custom paths, custom field names.
    const fetchResult = await handlers["provider.pricing.fetch"]!({
      id: "req-m3",
      method: "provider.pricing.fetch",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in fetchResult)) throw new Error(JSON.stringify(fetchResult));
    const station = (fetchResult.result as RelayPricingResult).table.stations[0]!;
    expect(station.error).toBeUndefined();
    expect(station.keyModels).toEqual(["glm-x"]);
    const row = station.rows.find((entry) => entry.modelId === "glm-x");
    // input = $2 × 0.1 × 1 = 0.2; output = ×2.
    expect(row?.inputPer1M).toBeCloseTo(0.2, 6);
    expect(row?.outputPer1M).toBeCloseTo(0.4, 6);
    expect(row?.keyAvailable).toBe(true);
    // Balance: 2500000 × 0.000002 = $5 remaining; used $1.
    expect(station.balance?.ok).toBe(true);
    expect(station.balance?.remainingUsd).toBeCloseTo(5, 5);
    expect(station.balance?.totalUsageUsd).toBeCloseTo(1, 5);

    // Handoff now returns the saved table.
    const handoffAfter = await handlers["provider.mapping.handoff"]!({
      id: "req-m4",
      method: "provider.mapping.handoff",
      params: { stationId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in handoffAfter)) throw new Error(JSON.stringify(handoffAfter));
    expect(
      (handoffAfter.result as { mapping: { stationId: string } | null }).mapping?.stationId,
    ).toBe("hetune");

    // Clearing the table restores built-in defaults (404 on custom paths → error field).
    await handlers["provider.mapping.set"]!({
      id: "req-m5",
      method: "provider.mapping.set",
      params: { stationId: "hetune", mapping: null },
      context: { expectedHostInstanceId: "x" },
    } as never);
    const fallback = await handlers["provider.pricing.fetch"]!({
      id: "req-m6",
      method: "provider.pricing.fetch",
      params: { providerId: "hetune" },
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in fallback)) throw new Error(JSON.stringify(fallback));
    const fallbackStation = (fallback.result as RelayPricingResult).table.stations[0]!;
    expect(fallbackStation.error).toBeTruthy();
    void layout;
  });

  it("picker merges mirror providers by main domain and flags existing mappings", async () => {
    const config = {
      providers: {
        hetune: {
          name: "河图主站",
          baseUrl: "https://api.hetune.top/v1",
          api: "openai-completions",
          models: [],
        },
        "hetune-cf": {
          name: "河图CF",
          baseUrl: "https://cf.hetune.top/v1",
          api: "openai-completions",
          models: [],
        },
        other: {
          name: "别家",
          baseUrl: "https://other.example.com",
          api: "openai-completions",
          models: [],
        },
      },
    };
    const { layout, handlers } = await setup(config);

    const empty = await handlers["provider.mapping.picker"]!({
      id: "req-p0",
      method: "provider.mapping.picker",
      params: null,
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in empty)) throw new Error(JSON.stringify(empty));
    const entries = (
      empty.result as {
        entries: Array<{
          stationId: string;
          names: string[];
          hasMapping: boolean;
          providerIds: string[];
        }>;
      }
    ).entries;
    // cf.hetune.top 与 api.hetune.top 同主域合并成一条，站点 id 取组内第一个。
    expect(entries.map((entry) => entry.stationId).sort()).toEqual(["hetune", "other"]);
    const merged = entries.find((entry) => entry.stationId === "hetune")!;
    expect(merged.names.sort()).toEqual(["河图CF", "河图主站"]);
    expect(merged.providerIds.sort()).toEqual(["hetune", "hetune-cf"]);
    expect(merged.hasMapping).toBe(false);

    // 写入映射表后 hasMapping 翻转。
    await handlers["provider.mapping.set"]!({
      id: "req-p1",
      method: "provider.mapping.set",
      params: {
        stationId: "hetune",
        mapping: { schemaVersion: 1, stationId: "hetune", endpoints: {} } as never,
      },
      context: { expectedHostInstanceId: "x" },
    } as never);
    const after = await handlers["provider.mapping.picker"]!({
      id: "req-p2",
      method: "provider.mapping.picker",
      params: null,
      context: { expectedHostInstanceId: "x" },
    } as never);
    if (!("result" in after)) throw new Error(JSON.stringify(after));
    const entriesAfter = (
      after.result as { entries: Array<{ stationId: string; hasMapping: boolean }> }
    ).entries;
    expect(entriesAfter.find((entry) => entry.stationId === "hetune")!.hasMapping).toBe(true);
    expect(entriesAfter.find((entry) => entry.stationId === "other")!.hasMapping).toBe(false);
    void layout;
  });
});
