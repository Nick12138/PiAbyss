/**
 * 价格总表右上角「站点管理」弹窗：把字段映射入口与按站价格刷新合并成一个列表。
 *
 * 数据源：
 *   - provider.mapping.picker —— 按主域合并镜像入口后的站点候选（含 hasApiKey /
 *     hasMapping / 合并的 providerIds）
 *   - provider.pricing.get —— 各站最近一次抓取快照（fetchedAt / error / 行数）
 *
 * 交互：
 *   - 每行右侧：刷新按钮（只刷新该站价格，转圈 → 成功/失败原因就地显示）
 *   - 每行勾选：参与底部「更新价格」（批量刷新）与「发起映射」（批量派发）
 *   - 底部按钮不跳转会话页，映射任务照旧注入默认工作区的新会话
 */
import { useEffect, useMemo, useState } from "react";
import type {
  RelayMappingPickerEntry,
  RelayPricingResult,
  RelayPricingStation,
} from "@piabyss/protocol";
import { Bot, CircleAlert, CircleCheck, MapPinCheckInside, RefreshCw } from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { openRelayMappingAgents, type RelayMappingTarget } from "./relay-mapping-agent";

type RelayStationsDialogProps = {
  /** 已配置的 providers（用于隐藏已删除 provider 的站点）。 */
  providerIds: ReadonlySet<string>;
  /** 当前价格快照（各站最近一次抓取状态）。 */
  pricing: RelayPricingResult | null;
  /** 按站（或批量）刷新价格后回传新快照给父组件。 */
  onPricingRefreshed: (result: RelayPricingResult) => void;
  /** 映射任务已派发（会话已新建并注入任务），调用方应关闭所有弹窗。 */
  onMappingStarted: () => void;
  onClose: () => void;
};

/** 一个站点行的按站刷新状态：同步中 / 成功 / 失败原因。 */
type StationSyncState = {
  syncing: ReadonlySet<string>;
  results: Record<string, { ok: boolean; message: string }>;
};

export function RelayStationsDialog({
  providerIds,
  pricing,
  onPricingRefreshed,
  onMappingStarted,
  onClose,
}: RelayStationsDialogProps) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [entries, setEntries] = useState<RelayMappingPickerEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** 批量刷新中（底部按钮），锁住全部刷新入口。 */
  const [batchFetching, setBatchFetching] = useState(false);
  const [sync, setSync] = useState<StationSyncState>({ syncing: new Set(), results: {} });

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void requestWithRetry(() =>
      hostClient.request("provider.mapping.picker", hostContext(host), null),
    )
      .then((response) => {
        if (cancelled) return;
        if (!response?.ok) {
          setLoadFailed(true);
          pushNotification(localizeHostError(response?.error, t), "error");
          return;
        }
        setEntries((response.result as { entries: RelayMappingPickerEntry[] }).entries);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId]);

  /** 站点行 = 合并候选 + 该站最近一次抓取快照（可能没有）。 */
  const rows = useMemo(() => {
    const stationByStationId = new Map<string, RelayPricingStation>();
    for (const station of pricing?.table.stations ?? []) {
      stationByStationId.set(station.stationId, station);
    }
    return (entries ?? []).map((entry) => ({
      entry,
      snapshot: stationByStationId.get(entry.stationId) ?? null,
    }));
  }, [entries, pricing]);

  function toggle(stationId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(stationId)) next.delete(stationId);
      else next.add(stationId);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.entry.stationId));

  function toggleAll() {
    setSelected(() => {
      if (allSelected) return new Set();
      return new Set(rows.map((row) => row.entry.stationId));
    });
  }

  /**
   * 单站刷新。一个合并站点可能对应多个镜像 provider（同主域不同 baseUrl，
   * 如 laneai 的「腾讯最低价」与「GLM-0.189」），必须整组一起刷新，否则
   * 只有组内第一个 provider 有价格，其余站点在总表里恒为空。
   */
  async function refreshOne(entry: RelayMappingPickerEntry) {
    const stationId = entry.stationId;
    if (!host || batchFetching || sync.syncing.has(stationId)) return;
    setSync((current) => ({
      ...current,
      syncing: new Set(current.syncing).add(stationId),
    }));
    try {
      const response = await hostClient.request(
        "provider.pricing.fetch",
        hostContext(host),
        { providerIds: entry.providerIds },
        120_000,
      );
      if (!response) return;
      if (!response.ok) {
        setSync((current) => ({
          ...current,
          results: {
            ...current.results,
            [stationId]: {
              ok: false,
              message: localizeHostError(response.error, t),
            },
          },
        }));
        return;
      }
      const result = response.result as RelayPricingResult;
      onPricingRefreshed(result);
      // 抓取失败不抛错（快照里带 error 字段），如实展示。
      const station = result.table.stations.find((entry) => entry.stationId === stationId);
      setSync((current) => ({
        ...current,
        results: {
          ...current.results,
          [stationId]: station?.error
            ? { ok: false, message: station.error }
            : {
                ok: true,
                message: t("relayPricingStationSyncOk", {
                  count: station?.rows.length ?? 0,
                  time: formatTime(station?.fetchedAt ?? null),
                }),
              },
        },
      }));
    } catch (error) {
      setSync((current) => ({
        ...current,
        results: {
          ...current.results,
          [stationId]: {
            ok: false,
            message: error instanceof Error ? error.message : t("relayPricingFetchFailed"),
          },
        },
      }));
    } finally {
      setSync((current) => {
        const next = new Set(current.syncing);
        next.delete(stationId);
        return { ...current, syncing: next };
      });
    }
  }

  /** 批量刷新勾选站点：一次请求带全部 providerIds。 */
  async function refreshSelected() {
    if (!host || batchFetching || selected.size === 0) return;
    // 合并站点的镜像 provider 一起刷新（见 refreshOne 的说明）。
    const ids = rows
      .filter((row) => selected.has(row.entry.stationId))
      .flatMap((row) => row.entry.providerIds);
    if (ids.length === 0) return;
    setBatchFetching(true);
    setSync((current) => ({
      ...current,
      syncing: new Set([...current.syncing, ...ids]),
      // 批量开始前清掉旧结果，转圈即状态。
      results: Object.fromEntries(
        Object.entries(current.results).filter(([id]) => !ids.includes(id)),
      ),
    }));
    try {
      const response = await hostClient.request(
        "provider.pricing.fetch",
        hostContext(host),
        { providerIds: ids },
        180_000,
      );
      if (!response) return;
      if (!response.ok) {
        // 整批失败：每个站都标记同一个原因。
        const message = localizeHostError(response.error, t);
        setSync((current) => ({
          ...current,
          results: {
            ...current.results,
            ...Object.fromEntries(ids.map((id) => [id, { ok: false, message }])),
          },
        }));
        return;
      }
      const result = response.result as RelayPricingResult;
      onPricingRefreshed(result);
      setSync((current) => ({
        ...current,
        results: {
          ...current.results,
          ...Object.fromEntries(
            ids.map((id) => {
              const station = result.table.stations.find((entry) => entry.stationId === id);
              return [
                id,
                station?.error
                  ? { ok: false, message: station.error }
                  : {
                      ok: true,
                      message: t("relayPricingStationSyncOk", {
                        count: station?.rows.length ?? 0,
                        time: formatTime(station?.fetchedAt ?? null),
                      }),
                    },
              ];
            }),
          ),
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("relayPricingFetchFailed");
      setSync((current) => ({
        ...current,
        results: {
          ...current.results,
          ...Object.fromEntries(ids.map((id) => [id, { ok: false, message }])),
        },
      }));
    } finally {
      setBatchFetching(false);
      setSync((current) => ({
        ...current,
        syncing: new Set([...current.syncing].filter((id) => !ids.includes(id))),
      }));
    }
  }

  /** 批量映射勾选站点：复用映射机器人派发（注入默认工作区新会话）。 */
  async function mapSelected() {
    if (entries === null || selected.size === 0) return;
    const targets: RelayMappingTarget[] = entries
      .filter((entry) => selected.has(entry.stationId))
      .map((entry) => ({
        stationId: entry.stationId,
        providerName: entry.names[0] ?? entry.stationId,
      }));
    if (targets.length === 0) return;
    // 映射会新建会话并跳聊天页：成功后关闭弹窗，否则用户会被蒙在弹窗后面。
    if (await openRelayMappingAgents(targets)) onMappingStarted();
  }

  const selectedCount = selected.size;

  return (
    <Dialog
      title={t("relayPricingStationsTitle")}
      confirmLabel={t("commonClose")}
      showCloseIcon
      // 底部不再放「取消/关闭」：右上角 × + Esc 已足够，避免三个关闭入口。
      hideActions
      maxWidthClass="max-w-xl"
      icon={MapPinCheckInside}
      onCancel={onClose}
      onConfirm={onClose}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t("relayPricingStationsHint")}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="text-[11px] text-muted hover:text-foreground"
            onClick={toggleAll}
            disabled={rows.length === 0}
          >
            {allSelected ? t("providersSelectNone") : t("providersSelectAll")}
          </button>
        </div>
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          {entries === null && !loadFailed ? (
            <p className="flex items-center justify-center gap-2 p-4 text-xs text-muted">
              <RefreshCw className="animate-spin" size={13} /> {t("providersLoading")}
            </p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">{t("providersMappingPickerEmpty")}</p>
          ) : (
            rows.map(({ entry }) => {
              const syncing = sync.syncing.has(entry.stationId) || batchFetching;
              const result = sync.results[entry.stationId];
              return (
                <div
                  key={entry.stationId}
                  className="flex items-center gap-2.5 border-b border-border px-3 py-2 text-xs last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(entry.stationId)}
                    onChange={() => toggle(entry.stationId)}
                    aria-label={entry.names[0] ?? entry.stationId}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">
                        {entry.names[0] ?? entry.stationId}
                      </span>
                      {entry.hasMapping && (
                        <span
                          className="shrink-0 rounded border border-success/40 bg-success/10 px-1 text-[10px] text-success"
                          title={t("providersMappingPickerHasMappingHint")}
                        >
                          {t("providersMappingPickerHasMapping")}
                        </span>
                      )}
                      {!entry.hasApiKey && (
                        <span className="shrink-0 text-[10px] text-muted">
                          {t("providersKeyNone")}
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted">
                      {entry.baseUrl}
                    </span>
                    {entry.names.length > 1 && (
                      <span className="block truncate text-[10px] text-muted">
                        {t("providersMappingPickerMerged", {
                          names: entry.names.slice(1).join("、"),
                        })}
                      </span>
                    )}
                  </span>
                  {/* 状态区：成功 ✅ / 失败 ⚠ + 原因，就地显示不跳页。同步中的
                      转圈只在右侧刷新按钮里，避免同一行出现两个转圈图标。 */}
                  <span className="flex shrink-0 items-center gap-1.5" aria-live="polite">
                    {!syncing && result ? (
                      result.ok ? (
                        <CircleCheck
                          className="text-success"
                          size={13}
                          aria-label={result.message}
                        />
                      ) : (
                        <CircleAlert
                          className="text-danger"
                          size={13}
                          aria-label={result.message}
                        />
                      )
                    ) : null}
                    {!syncing && result && !result.ok ? (
                      <span
                        className="max-w-40 truncate text-[10px] text-danger"
                        title={result.message}
                      >
                        {result.message}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded border border-border text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
                    title={t("relayPricingStationSync")}
                    aria-label={t("relayPricingStationSync")}
                    disabled={syncing || !providerIds.has(entry.stationId)}
                    onClick={() => void refreshOne(entry)}
                  >
                    <RefreshCw className={syncing ? "animate-spin" : ""} size={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">
            {t("providersMappingPickerSelected", { count: selectedCount })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className={`${secondaryButton} h-7`}
              disabled={selectedCount === 0 || batchFetching || sync.syncing.size > 0}
              onClick={() => void refreshSelected()}
            >
              <RefreshCw className={batchFetching ? "animate-spin" : ""} size={12} />
              {batchFetching ? t("relayPricingRefreshing") : t("relayPricingStationsUpdatePrices")}
            </button>
            <button
              type="button"
              className={`${secondaryButton} h-7`}
              disabled={selectedCount === 0}
              title={t("providersMappingBotTitle")}
              onClick={() => void mapSelected()}
            >
              <Bot size={12} />
              {t("relayPricingStationsStartMapping")}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** HH:mm 简短时间显示（成功提示里用）。 */
function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
