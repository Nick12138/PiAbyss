/**
 * 会话模型菜单的中转站数据接入（价格预览 + 模型测试）。
 *
 * 数据源与设置里的「中转站价格总表」（RelayPricingDialog）完全一致：
 *   - provider.pricing.get 读取 host 磁盘缓存（piabyss/relay-pricing/pricing.json），
 *     静默失败时价格区显示「暂无价格数据」；
 *   - provider.list 提供站点显示名与 key 配置状态（测试资格判定）；
 *   - 模型测试复用 provider.checkConnection（测试通道 = 该模型所属站点
 *     provider 自己的 baseUrl + key），绝不改用会话当前通道。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderConnectionResult,
  ProviderSnapshot,
  RelayPricingResult,
  RelayPricingRow,
  RelayRechargeRatio,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { useAppStore } from "../../lib/stores/app-store";

/** 与 RelayPricingDialog 相同的「1:1 比例」判断。 */
function isOneToOneRatio(ratio: RelayRechargeRatio): boolean {
  return Math.abs(ratio.cny - ratio.balance) < 1e-9;
}

/** 价格格式化：与 RelayPricingDialog 相同的美元显示规则。 */
function formatPrice(value: number | null): string {
  if (value === null) return "—";
  return `$${value
    .toFixed(value < 0.1 ? 4 : 3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}`;
}

/** 单个价格字符串（含非 1:1 充值比例时的人民币 ≈ 换算）。 */
function priceText(value: number | null, ratio: RelayRechargeRatio | null): string {
  if (value === null) return "—";
  const base = formatPrice(value);
  if (!ratio || isOneToOneRatio(ratio)) return base;
  return `${base} ≈¥${((value / ratio.balance) * ratio.cny).toFixed(2)}`;
}

/** 价格总表里一条匹配记录（价格已折算成显示字符串）。 */
export type RelayModelPrice = {
  modelId: string;
  stationId: string;
  stationName: string;
  group: string;
  groupRatio: number;
  input: string;
  output: string;
  cache: string;
  call: string;
};

export function relayRowToPrice(
  row: RelayPricingRow,
  stationName: string,
  ratio: RelayRechargeRatio | null,
): RelayModelPrice {
  return {
    modelId: row.modelId,
    stationId: row.stationId,
    stationName,
    group: row.group,
    groupRatio: row.groupRatio,
    input: priceText(row.inputPer1M, ratio),
    output: priceText(row.outputPer1M, ratio),
    cache: priceText(row.cachePer1M, ratio),
    call: priceText(row.callPrice, ratio),
  };
}

export type RelayMenuData = {
  /** provider.pricing.get 磁盘缓存快照；null = 暂无数据。 */
  pricing: RelayPricingResult | null;
  /** providerId → 显示名（跟随 provider.name 动态取）。 */
  providerNames: ReadonlyMap<string, string>;
  /** 已配置 key 的 providerId 集合（测试资格判定，与价格总表一致）。 */
  configuredProviderIds: ReadonlySet<string>;
};

/**
 * 拉取模型菜单所需的中转站数据（价格缓存 + provider 清单，均静默失败）。
 *
 * `enabled` 为菜单是否（曾经）打开：数据懒加载，菜单首次打开才发请求，
 * 之后在宿主组件生命周期内保留（providerConfigRevision 变化时刷新，
 * 例如一次测试回写 auth header 后）。
 */
export function useRelayMenuData(enabled: boolean): RelayMenuData {
  const host = useAppStore((state) => state.host);
  const hostInstanceId = host?.hostInstanceId;
  const providerConfigRevision = useAppStore((state) => state.providerConfigRevision);
  const [pricing, setPricing] = useState<RelayPricingResult | null>(null);
  const [providers, setProviders] = useState<ProviderSnapshot[] | null>(null);
  // 菜单首次打开后闩住：之后关闭菜单不丢数据，也不重复拉取；
  // providerConfigRevision 变化（如一次测试回写 auth header）时刷新。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (enabled) setArmed(true);
  }, [enabled]);

  useEffect(() => {
    if (!armed) return;
    if (!hostInstanceId) {
      setPricing(null);
      setProviders(null);
      return;
    }
    const requestHost = useAppStore.getState().host;
    if (!requestHost) return;
    let cancelled = false;
    void requestWithRetry(() =>
      hostClient.request("provider.pricing.get", hostContext(requestHost), null),
    )
      .then((response) => {
        if (cancelled || !response?.ok) return;
        setPricing(response.result as RelayPricingResult);
      })
      .catch(() => {});
    void requestWithRetry(() => hostClient.request("provider.list", hostContext(requestHost), null))
      .then((response) => {
        if (cancelled || !response?.ok) return;
        setProviders(response.result.providers);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [armed, hostInstanceId, providerConfigRevision]);

  return useMemo(() => {
    const providerNames = new Map<string, string>();
    const configuredProviderIds = new Set<string>();
    for (const provider of providers ?? []) {
      providerNames.set(provider.id, provider.name);
      if (provider.auth.configured) configuredProviderIds.add(provider.id);
    }
    return { pricing, providerNames, configuredProviderIds };
  }, [pricing, providers]);
}

/**
 * 在价格快照里查找某 provider/model 的候选价格行（可能命中多组/多站）。
 * 价格升序（无价的排最后），多分组命中时最便宜的排前面。
 */
export function relayPriceCandidates(
  pricing: RelayPricingResult | null,
  providerId: string,
  modelId: string,
  stationNames: ReadonlyMap<string, string>,
): RelayModelPrice[] {
  if (!pricing) return [];
  const matches: RelayModelPrice[] = [];
  for (const station of pricing.table.stations) {
    if (station.stationId !== providerId) continue;
    const stationName = stationNames.get(station.stationId) ?? station.stationId;
    const ratio = pricing.rechargeRatios[station.stationId] ?? null;
    for (const row of station.rows) {
      if (row.modelId !== modelId) continue;
      matches.push(relayRowToPrice(row, stationName, ratio));
    }
  }
  return matches.sort((left, right) => {
    const priceOf = (price: RelayModelPrice) => {
      const parse = (text: string) => {
        const match = /^\$([\d.]+)/.exec(text);
        return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
      };
      return parse(price.input) + parse(price.output);
    };
    return priceOf(left) - priceOf(right);
  });
}

/** 模型菜单里单个模型的测试状态（与 RelayPricingDialog.useRelayTest 同语义）。 */
export type RelayModelTestState = {
  /** 正在测试中的模型 key（provider/modelId）集合。 */
  testingKeys: ReadonlySet<string>;
  /** key → 最近一次测试结果（菜单关闭时保留，组件卸载时清空）。 */
  results: Readonly<Record<string, { ok: boolean; message: string }>>;
  /** 发起测试；调用方需先用 testable 判定资格。 */
  test: (providerId: string, modelId: string) => void;
  /** 该模型是否可测试：provider 已配置 key 即可（价格总表同一判定）。 */
  testable: (providerId: string) => boolean;
};

/**
 * 会话模型菜单的「模型测试」状态机。测试通道与设置价格总表的测试按钮
 * 完全一致：host 端 provider.checkConnection 用该模型所属站点 provider 的
 * baseUrl + key 发最小生成请求，与会话当前使用的通道无关。
 */
export function useRelayModelTest(configuredProviderIds: ReadonlySet<string>): RelayModelTestState {
  const [testingKeys, setTestingKeys] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<
    Readonly<Record<string, { ok: boolean; message: string }>>
  >({});

  // 同步锁：避免把 testingKeys 放进 test 的依赖造成回调抖动。
  const testingKeysRef = useRef(testingKeys);
  testingKeysRef.current = testingKeys;

  const test = useCallback((providerId: string, modelId: string) => {
    const key = `${providerId}/${modelId}`;
    const { host, pushNotification, refreshProviderConfig } = useAppStore.getState();
    if (!host || testingKeysRef.current.has(key)) return;
    setTestingKeys((current) => new Set(current).add(key));
    void (async () => {
      try {
        const response = await hostClient.request(
          "provider.checkConnection",
          hostContext(host),
          { providerId, modelId },
          25_000,
        );
        if (!response) return;
        if (!response.ok) {
          pushNotification(`${providerId}/${modelId}: ${response.error.message}`, "error");
          return;
        }
        const typed = response.result as ProviderConnectionResult;
        setResults((current) => ({
          ...current,
          [key]: { ok: typed.ok, message: `${typed.latencyMs} ms · ${typed.message}` },
        }));
      } catch (error) {
        pushNotification(
          error instanceof Error ? error.message : `${providerId}/${modelId} test failed`,
          "error",
        );
      } finally {
        setTestingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        // 测试可能回写 auth header（models.json），刷新 provider 配置缓存。
        refreshProviderConfig();
      }
    })();
  }, []);

  const testable = useCallback(
    (providerId: string) => configuredProviderIds.has(providerId),
    [configuredProviderIds],
  );

  return { testingKeys, results, test, testable };
}
