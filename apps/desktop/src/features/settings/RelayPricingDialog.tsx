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
import {
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronUp,
  Bot,
  Coins,
  RefreshCw,
  Search,
} from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT, type Translate } from "../../lib/i18n/use-t";
import { RelayMappingPickerDialog } from "./RelayMappingPickerDialog";

type PriceTableDialogProps = {
  providers: ProviderSnapshot[];
  onClose: () => void;
};

/** 价格列（可排序字段的键）。 */
type PriceSortField = "input" | "output" | "cache" | "call";

function formatPrice(value: number | null): string {
  if (value === null) return "—";
  return `$${value
    .toFixed(value < 0.1 ? 4 : 3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}`;
}

/** 1:1 比例判断：cny/balance 相等（含默认未配置）时不需要 ≈ 换算显示。 */
function isOneToOneRatio(ratio: RelayRechargeRatio): boolean {
  return Math.abs(ratio.cny - ratio.balance) < 1e-9;
}

/**
 * 美元价格折算成人民币的 ≈ 显示值（非 1:1 时）：balance 单位余额对应 cny 元，
 * 即 1 美元余额 ≈ cny/balance 元人民币。
 */
function cnyApprox(usd: number, ratio: RelayRechargeRatio): string {
  return `≈¥${((usd / ratio.balance) * ratio.cny).toFixed(2)}`;
}

type RelayTestState = {
  /** 正在测试中的 rowKey 集合（按行锁，其他行可并行测试）。 */
  testingKeys: Set<string>;
  /** rowKey → 最近一次测试结果（每行独立保留，弹窗关闭时随组件卸载清空）。 */
  results: Record<string, { ok: boolean; message: string }>;
  test: (providerId: string, modelId: string, rowKey: string) => Promise<void>;
};

function useRelayTest(t: Translate): RelayTestState {
  const pushNotification = useAppStore((state) => state.pushNotification);
  const refreshProviderConfig = useAppStore((state) => state.refreshProviderConfig);
  const [testingKeys, setTestingKeys] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  async function runTest(providerId: string, modelId: string, rowKey: string): Promise<void> {
    const host = useAppStore.getState().host;
    if (!host || testingKeys.has(rowKey)) return;
    setTestingKeys((current) => new Set(current).add(rowKey));
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
      setResults((current) => ({
        ...current,
        [rowKey]: { ok: typed.ok, message: `${typed.latencyMs} ms · ${typed.message}` },
      }));
      if (typed.ok) pushNotification(t("providersConnectionOk"), "success");
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifProviderTestFailed"),
        "error",
      );
    } finally {
      setTestingKeys((current) => {
        const next = new Set(current);
        next.delete(rowKey);
        return next;
      });
      refreshProviderConfig();
    }
  }

  return { testingKeys, results, test: runTest };
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
  /** 唯一排序：null = 不排序；非空 = 该列按折算后价格排序。 */
  const [sort, setSort] = useState<{ field: PriceSortField; desc: boolean } | null>(null);
  // 映射机器人弹窗（站点多选 → 发起映射会话）。
  const [mappingPickerOpen, setMappingPickerOpen] = useState(false);
  const { testingKeys, results: testResults, test } = useRelayTest(t);

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

  /** 已配置 key 的 providerId 集合（测试资格只看这个，不依赖 keyAvailable）。 */
  const configuredProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (provider.auth.configured) ids.add(provider.id);
    }
    return ids;
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

  /** 每行所属站的充值比例（折算排序与 ≈ 显示都用它）。 */
  const stationIdByRowKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const station of visibleStations) {
      for (const row of station.rows) {
        map.set(`${row.stationId}:${row.modelId}:${row.group}`, row.stationId);
      }
    }
    return map;
  }, [visibleStations]);

  /** 排序键：美元价格按充值比例折算成人民币后的金额（null 排最后）。 */
  const sortValueFor = (row: RelayPricingRow): number | null => {
    const value =
      sort?.field === "input"
        ? row.inputPer1M
        : sort?.field === "output"
          ? row.outputPer1M
          : sort?.field === "cache"
            ? row.cachePer1M
            : row.callPrice;
    if (value === null) return null;
    const stationId = stationIdByRowKey.get(`${row.stationId}:${row.modelId}:${row.group}`);
    const ratio = rechargeRatioFor(stationId ?? null);
    // 折算排序金额：按人民币口径（1:1 时等于原价）。
    return (value / ratio.balance) * ratio.cny;
  };

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const dir = sort.desc ? -1 : 1;
    return [...rows].sort((left, right) => {
      const a = sortValueFor(left.row);
      const b = sortValueFor(right.row);
      // null（无价格）固定排最后，与方向无关。
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a - b) * dir || left.row.modelId.localeCompare(right.row.modelId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, stationIdByRowKey, pricing]);

  /** 排序按钮：悬浮显示；当前排序列固定显示。点击切换 asc/desc/无。 */
  function SortButton({ field }: { field: PriceSortField }) {
    const active = sort?.field === field;
    return (
      <button
        type="button"
        className={`group/sort inline-flex h-4 w-4 items-center justify-center rounded align-middle text-muted hover:bg-surface-overlay hover:text-foreground ${
          active ? "text-focus" : "opacity-0 group-hover/th:opacity-100 focus-visible:opacity-100"
        }`}
        aria-label={
          sort?.field === field && sort.desc ? t("relayPricingSortDesc") : t("relayPricingSortAsc")
        }
        title={
          sort?.field === field && sort.desc ? t("relayPricingSortDesc") : t("relayPricingSortAsc")
        }
        onClick={() =>
          setSort((current) => {
            if (current?.field !== field) return { field, desc: false };
            if (!current.desc) return { field, desc: true };
            return null; // 第三次点击取消排序。
          })
        }
      >
        {active && sort?.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>
    );
  }

  return (
    <>
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
            <button
              type="button"
              className={`${secondaryButton} h-7`}
              title={t("providersMappingBotTitle")}
              aria-label={t("providersMappingBot")}
              onClick={() => setMappingPickerOpen(true)}
            >
              <Bot size={13} />
              {t("providersMappingBot")}
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
                      <span className="text-[11px] text-muted">
                        {t("relayPricingNotConfigured")}
                      </span>
                    ) : balance === null ? (
                      <span className="text-[11px] text-muted">—</span>
                    ) : !balance.ok ? (
                      <span
                        className="inline-flex items-center text-danger"
                        title={t("relayPricingBalanceError")}
                        aria-label={t("relayPricingBalanceError")}
                      >
                        <CircleAlert size={13} />
                      </span>
                    ) : balance.unlimited ? (
                      <span
                        className="text-success"
                        title={t("relayPricingBalanceUnlimited")}
                        aria-label={t("relayPricingBalanceUnlimited")}
                      >
                        ∞
                      </span>
                    ) : (
                      <span className="tabular-nums text-foreground">
                        {balance.currency === "CNY" ? "¥" : "$"}
                        {balance.remainingUsd?.toFixed(2) ?? "0.00"}
                        {balance.currency !== "CNY" && !isOneToOneRatio(ratio) && (
                          <span className="ml-1 text-[11px] text-muted">
                            {cnyApprox(balance.remainingUsd ?? 0, ratio)}
                          </span>
                        )}
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
                  {(
                    [
                      ["input", t("relayPricingColInput")],
                      ["output", t("relayPricingColOutput")],
                      ["cache", t("relayPricingColCache")],
                      ["call", t("relayPricingColCall")],
                    ] as Array<[PriceSortField, string]>
                  ).map(([field, label]) => (
                    <th key={field} className="group/th px-2.5 py-1.5 text-right font-medium">
                      {/* 按钮放文字前面：表头文字右缘与单元格数字右缘对齐。 */}
                      <SortButton field={field} />
                      {label}
                    </th>
                  ))}
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
                  sortedRows.map(({ row, stationName }) => {
                    const rowKey = `${row.stationId}:${row.modelId}:${row.group}`;
                    // 测试直接用该行的 stationId（抓取它的 provider）——同 baseUrl
                    // 多 provider（不同 key/分组）时不能用 baseUrl 反查，会错用
                    // 别家 provider 的 key 导致分组不匹配。
                    const configured = configuredProviderIds.has(row.stationId)
                      ? row.stationId
                      : null;
                    // 非 1:1 充值比例的站：价格旁显示人民币 ≈ 换算。
                    const rowRatio = rechargeRatioFor(row.stationId);
                    const approx = !isOneToOneRatio(rowRatio)
                      ? (value: number | null) =>
                          value !== null ? (
                            <span className="ml-1 text-[10px] text-muted">
                              {cnyApprox(value, rowRatio)}
                            </span>
                          ) : null
                      : () => null;
                    // 可测试：站点已配置 key 即可。不要求 keyAvailable——
                    // /v1/models 拉不到（如 Anthropic 风格入口）不该否决测试，
                    // 模型实际可用性由测试请求本身回答。
                    const testable = configured !== null;
                    return (
                      <tr
                        key={rowKey}
                        className={`border-b border-border/70 last:border-0 ${
                          row.keyAvailable ? "" : "opacity-60"
                        }`}
                      >
                        <td
                          className="max-w-56 truncate px-2.5 py-1.5 font-mono"
                          title={row.modelId}
                        >
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
                          {approx(row.inputPer1M)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatPrice(row.outputPer1M)}
                          {approx(row.outputPer1M)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatPrice(row.cachePer1M)}
                          {approx(row.cachePer1M)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatPrice(row.callPrice)}
                          {approx(row.callPrice)}
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-1.5">
                          {configured ? (
                            testable ? (
                              (() => {
                                // 结果融进按钮本身（图标颜色/边框/悬浮详情），不追加
                                // 额外元素，避免行高跳动。只锁定当前测试中的按钮，
                                // 其他行可并行测试。
                                const rowResult = testResults[rowKey];
                                const rowTesting = testingKeys.has(rowKey);
                                const stateClass = rowTesting
                                  ? "border-border text-muted"
                                  : !rowResult
                                    ? "border-border text-muted"
                                    : rowResult.ok
                                      ? "border-success/40 text-success"
                                      : "border-danger/40 text-danger";
                                return (
                                  <button
                                    type="button"
                                    className={`flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] hover:bg-surface-overlay disabled:opacity-50 ${stateClass}`}
                                    disabled={rowTesting}
                                    title={
                                      rowTesting ? t("relayPricingTesting") : rowResult?.message
                                    }
                                    onClick={() => void test(configured, row.modelId, rowKey)}
                                  >
                                    {rowTesting ? (
                                      <RefreshCw className="animate-spin" size={11} />
                                    ) : rowResult ? (
                                      rowResult.ok ? (
                                        <CircleCheck size={11} />
                                      ) : (
                                        <CircleAlert size={11} />
                                      )
                                    ) : (
                                      <CircleCheck size={11} />
                                    )}
                                    {/* 文字固定为「测试」：测试中状态只用图标与 title 表达，
                                      避免文字变宽撑开列。 */}
                                    {t("relayPricingTest")}
                                  </button>
                                );
                              })()
                            ) : (
                              <span
                                className="text-[10px] text-muted"
                                title={t("notifRelayTestFromPricing")}
                              >
                                {t("relayPricingNotConfigured")}
                              </span>
                            )
                          ) : null}
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
      {mappingPickerOpen && (
        <RelayMappingPickerDialog onClose={() => setMappingPickerOpen(false)} />
      )}
    </>
  );
}
