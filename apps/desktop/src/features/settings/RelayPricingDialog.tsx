/**
 * 中转站价格总表弹窗。
 *
 * 数据源：host 端 piabyss/relay-pricing/pricing.json（provider.pricing.get 缓存
 * / provider.pricing.fetch 手动刷新）。无定时刷新，全部手动触发。
 *
 * 功能：
 *   - 站点 / 分组 / 关键字 / 仅看 Key 可用 四个筛选维度
 *   - 有 key 且模型属于已配置 provider 的行可发起真实连接测试
 *     （复用 provider.checkConnection，需要先在模型服务里把该模型加入列表）
 */
import { useEffect, useMemo, useState } from "react";
import type {
  ProviderConnectionResult,
  ProviderSnapshot,
  RelayPricingResult,
  RelayPricingRow,
  RelayRechargeRatio,
} from "@piabyss/protocol";
import { CircleCheck, Coins, RefreshCw, Search } from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT, type Translate } from "../../lib/i18n/use-t";

type PriceTableDialogProps = {
  providers: ProviderSnapshot[];
  onClose: () => void;
};

function formatPrice(value: number | null): string {
  if (value === null) return "—";
  return `$${value
    .toFixed(value < 0.1 ? 4 : 3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}`;
}

type RelayTestState = {
  testingKey: string | null;
  result: { key: string; ok: boolean; message: string } | null;
  test: (providerId: string, modelId: string, rowKey: string) => Promise<void>;
};

function useRelayTest(t: Translate): RelayTestState {
  const pushNotification = useAppStore((state) => state.pushNotification);
  const refreshProviderConfig = useAppStore((state) => state.refreshProviderConfig);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; ok: boolean; message: string } | null>(null);

  async function runTest(providerId: string, modelId: string, rowKey: string): Promise<void> {
    const host = useAppStore.getState().host;
    if (!host || testingKey) return;
    setTestingKey(rowKey);
    setResult(null);
    try {
      const response = await hostClient.request(
        "provider.checkConnection",
        hostContext(host),
        { providerId, modelId },
        25_000,
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), "error");
        return;
      }
      const typed = response.result as ProviderConnectionResult;
      setResult({
        key: rowKey,
        ok: typed.ok,
        message: `${typed.latencyMs} ms · ${typed.message}`,
      });
      if (typed.ok) pushNotification(t("providersConnectionOk"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderTestFailed"),
        "error",
      );
    } finally {
      setTestingKey(null);
      refreshProviderConfig();
    }
  }

  return { testingKey, result, test: runTest };
}

export function RelayPricingDialog({ providers, onClose }: PriceTableDialogProps) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const hostInstanceId = host?.hostInstanceId;
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [pricing, setPricing] = useState<RelayPricingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [stationFilter, setStationFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [keyOnly, setKeyOnly] = useState(false);
  const { testingKey, result: testResult, test } = useRelayTest(t);

  useEffect(() => {
    if (!hostInstanceId) return;
    const requestHost = useAppStore.getState().host;
    if (!requestHost) return;
    let cancelled = false;
    setLoading(true);
    void requestWithRetry(() =>
      hostClient.request("provider.pricing.get", hostContext(requestHost), null),
    )
      .then((response) => {
        if (cancelled || !response?.ok) return;
        setPricing(response.result as RelayPricingResult);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostInstanceId]);

  async function refresh(providerId?: string) {
    if (!host || fetching) return;
    setFetching(true);
    try {
      const response = await hostClient.request(
        "provider.pricing.fetch",
        hostContext(host),
        providerId ? { providerId } : null,
        120_000,
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(localizeHostError(response.error, t), "error");
        return;
      }
      setPricing(response.result as RelayPricingResult);
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("relayPricingFetchFailed"),
        "error",
      );
    } finally {
      setFetching(false);
    }
  }

  const stations = useMemo(() => pricing?.table.stations ?? [], [pricing]);

  /** providerId → 显示名（host 不落盘站名，跟随 provider.name 动态取）。 */
  const providerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers) map.set(provider.id, provider.name);
    return map;
  }, [providers]);

  /** 只展示仍存在的 provider 对应的站点（手动条目 providerId===null 保留）。 */
  const visibleStations = useMemo(
    () =>
      stations.filter(
        (station) => station.providerId === null || providerNames.has(station.providerId),
      ),
    [stations, providerNames],
  );

  const groupOptions = useMemo(() => {
    const names = new Set<string>();
    for (const station of visibleStations) {
      if (stationFilter !== "all" && station.stationId !== stationFilter) continue;
      for (const group of station.groups) names.add(group.name);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [visibleStations, stationFilter]);

  /** baseUrl →（已配置且有 key 的）provider 及其模型集合。 */
  const providerByBaseUrl = useMemo(() => {
    const map = new Map<string, { providerId: string; models: Set<string> }>();
    for (const provider of providers) {
      if (!provider.baseUrl || !provider.auth.configured) continue;
      map.set(provider.baseUrl.replace(/\/+$/, ""), {
        providerId: provider.id,
        models: new Set(provider.models.map((model) => model.id)),
      });
    }
    return map;
  }, [providers]);

  const rows = useMemo(() => {
    const providerNamesByStation = providerNames;
    const query = search.trim().toLowerCase();
    const all: Array<{ row: RelayPricingRow; stationName: string }> = [];
    for (const station of visibleStations) {
      if (stationFilter !== "all" && station.stationId !== stationFilter) continue;
      const stationName = station.providerId
        ? (providerNamesByStation.get(station.providerId) ?? station.stationId)
        : station.stationId;
      for (const row of station.rows) {
        if (groupFilter !== "all" && row.group !== groupFilter) continue;
        if (keyOnly && !row.keyAvailable) continue;
        if (
          query &&
          !`${row.modelId} ${row.modelName} ${row.vendor ?? ""}`.toLowerCase().includes(query)
        ) {
          continue;
        }
        all.push({ row, stationName });
      }
    }
    return all.sort(
      (left, right) =>
        left.row.modelId.localeCompare(right.row.modelId) ||
        left.row.group.localeCompare(right.row.group),
    );
  }, [visibleStations, stationFilter, groupFilter, keyOnly, search, providerNames]);

  const rechargeRatioFor = (providerId: string | null): RelayRechargeRatio =>
    (providerId && pricing?.rechargeRatios[providerId]) || { cny: 1, balance: 1 };

  return (
    <Dialog
      title={t("relayPricingDialogTitle")}
      confirmLabel={t("commonClose")}
      showCloseIcon
      maxWidthClass="max-w-6xl"
      onCancel={onClose}
      onConfirm={onClose}
      headerExtra={
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted">
            {t("relayPricingRowsCount", { count: rows.length })}
          </span>
          <button
            type="button"
            className={`${secondaryButton} h-7`}
            disabled={fetching || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={fetching ? "animate-spin" : ""} size={13} />
            {fetching ? t("relayPricingRefreshing") : t("relayPricingRefresh")}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 筛选行 */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-focus"
            value={stationFilter}
            aria-label={t("relayPricingAllStations")}
            onChange={(event) => {
              setStationFilter(event.target.value);
              setGroupFilter("all");
            }}
          >
            <option value="all">{t("relayPricingAllStations")}</option>
            {visibleStations.map((station) => (
              <option key={station.stationId} value={station.stationId}>
                {station.providerId
                  ? (providerNames.get(station.providerId) ?? station.stationId)
                  : station.stationId}
              </option>
            ))}
          </select>
          <select
            className="h-8 max-w-48 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-focus"
            value={groupFilter}
            aria-label={t("relayPricingAllGroups")}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="all">{t("relayPricingAllGroups")}</option>
            {groupOptions.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <div className="relative min-w-40 flex-1">
            <Search className="absolute left-2 top-2 text-muted" size={14} />
            <input
              className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-focus"
              placeholder={t("relayPricingSearch")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={keyOnly}
              onChange={(event) => setKeyOnly(event.target.checked)}
            />
            {t("relayPricingKeyOnly")}
          </label>
        </div>

        {/* 站点余额概览 */}
        {visibleStations.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {visibleStations.map((station) => {
              const ratio = rechargeRatioFor(station.providerId);
              const balance = station.balance;
              return (
                <div
                  key={station.stationId}
                  className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
                >
                  <span className="font-medium text-foreground">
                    {station.providerId
                      ? (providerNames.get(station.providerId) ?? station.stationId)
                      : station.stationId}
                  </span>
                  {station.providerId === null ? (
                    <span className="text-[11px] text-muted">{t("relayPricingNotConfigured")}</span>
                  ) : balance === null ? (
                    <span className="text-[11px] text-muted">—</span>
                  ) : !balance.ok ? (
                    <span className="text-[11px] text-danger" title={balance.error}>
                      {t("relayPricingBalanceError")}
                    </span>
                  ) : balance.unlimited ? (
                    <span className="text-[11px] text-success">
                      {t("relayPricingBalanceUnlimited")}
                    </span>
                  ) : (
                    <span className="tabular-nums text-foreground">
                      ${balance.remainingUsd?.toFixed(2) ?? "0.00"}
                      <span className="ml-1 text-[11px] text-muted">
                        ≈¥{(((balance.remainingUsd ?? 0) / ratio.balance) * ratio.cny).toFixed(2)}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 价格表 */}
        <div className="max-h-[52vh] overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[54rem] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-raised text-[11px] text-muted">
              <tr className="border-b border-border/70">
                <th className="px-2.5 py-1.5 font-medium">{t("relayPricingColModel")}</th>
                <th className="px-2.5 py-1.5 font-medium">{t("relayPricingColStation")}</th>
                <th className="px-2.5 py-1.5 font-medium">{t("relayPricingColGroup")}</th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  {t("relayPricingColInput")}
                </th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  {t("relayPricingColOutput")}
                </th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  {t("relayPricingColCache")}
                </th>
                <th className="px-2.5 py-1.5 text-right font-medium">{t("relayPricingColCall")}</th>
                <th className="px-2.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted">
                    {loading ? "…" : t("relayPricingEmpty")}
                  </td>
                </tr>
              ) : (
                rows.map(({ row, stationName }) => {
                  const rowKey = `${row.stationId}:${row.modelId}:${row.group}`;
                  const configured = providerByBaseUrl.get(
                    stations.find((station) => station.stationId === row.stationId)?.baseUrl ?? "",
                  );
                  const testable =
                    configured !== undefined &&
                    row.keyAvailable &&
                    configured.models.has(row.modelId);
                  return (
                    <tr
                      key={rowKey}
                      className={`border-b border-border/70 last:border-0 ${
                        row.keyAvailable ? "" : "opacity-60"
                      }`}
                    >
                      <td className="max-w-56 truncate px-2.5 py-1.5 font-mono" title={row.modelId}>
                        {row.modelId}
                        {row.billingExpr && (
                          <span
                            className="ml-1.5 rounded bg-warning/15 px-1 text-[10px] text-warning"
                            title={row.billingExpr}
                          >
                            {t("relayPricingTieredBadge")}
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5">{stationName}</td>
                      <td className="px-2.5 py-1.5">
                        {row.group}
                        <span className="ml-1 text-[10px] tabular-nums text-muted">
                          ×{row.groupRatio}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {formatPrice(row.inputPer1M)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {formatPrice(row.outputPer1M)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {formatPrice(row.cachePer1M)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {formatPrice(row.callPrice)}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">
                        {row.keyAvailable && configured ? (
                          testable ? (
                            <button
                              type="button"
                              className="flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] hover:bg-surface-overlay disabled:opacity-50"
                              disabled={testingKey !== null}
                              onClick={() => void test(configured.providerId, row.modelId, rowKey)}
                            >
                              {testingKey === rowKey ? (
                                <RefreshCw className="animate-spin" size={11} />
                              ) : (
                                <CircleCheck size={11} />
                              )}
                              {testingKey === rowKey
                                ? t("relayPricingTesting")
                                : t("relayPricingTest")}
                            </button>
                          ) : (
                            <span
                              className="text-[10px] text-muted"
                              title={t("notifRelayTestFromPricing")}
                            >
                              {t("relayPricingNotConfigured")}
                            </span>
                          )
                        ) : null}
                        {testResult?.key === rowKey && (
                          <span
                            className={`ml-1.5 text-[10px] ${
                              testResult.ok ? "text-success" : "text-danger"
                            }`}
                            title={testResult.message}
                          >
                            {testResult.ok ? "✓" : "✗"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Coins size={12} />
          {t("relayPricingRechargeRatioHint")}
        </p>
      </div>
    </Dialog>
  );
}
