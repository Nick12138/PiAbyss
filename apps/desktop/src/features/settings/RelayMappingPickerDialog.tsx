/**
 * 映射机器人弹窗：把「中转站价格总表」右上角机器人图标点开的站点多选列表。
 *
 * 数据源：host 端 provider.mapping.picker —— 已按主域/归一化地址合并，
 * 排除 cf.x / api.x 等子域名镜像入口，因此一个站点只出现一行。
 * 已存在映射表的站点显示「已映射」标识；勾选它表示重新测试并覆盖映射。
 *
 * 确定后把选中的站点交给 openRelayMappingAgents，在默认工作区新建一条会话
 * 并注入多个映射任务胶囊。
 */
import { useEffect, useMemo, useState } from "react";
import type { RelayMappingPickerEntry, RelayMappingPickerResult } from "@piabyss/protocol";
import { Bot, RefreshCw, Search } from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { requestWithRetry } from "../../lib/bridge/request-retry";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { useAppStore } from "../../lib/stores/app-store";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { openRelayMappingAgents, type RelayMappingTarget } from "./relay-mapping-agent";

type RelayMappingPickerDialogProps = {
  onClose: () => void;
};

export function RelayMappingPickerDialog({ onClose }: RelayMappingPickerDialogProps) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const hostInstanceId = host?.hostInstanceId;
  const pushNotification = useAppStore((state) => state.pushNotification);
  const [entries, setEntries] = useState<RelayMappingPickerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dispatching, setDispatching] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!hostInstanceId) return;
    const requestHost = useAppStore.getState().host;
    if (!requestHost) return;
    let cancelled = false;
    setLoading(true);
    void requestWithRetry(() =>
      hostClient.request("provider.mapping.picker", hostContext(requestHost), null),
    )
      .then((response) => {
        if (cancelled) return;
        if (!response || !response.ok) {
          pushNotification(localizeHostError(response?.error, t), "error");
          return;
        }
        setEntries((response.result as RelayMappingPickerResult).entries);
      })
      .catch((error) => {
        if (cancelled) return;
        pushNotification(
          error instanceof Error ? error.message : t("providersMappingHandoffFailed"),
          "error",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostInstanceId]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) =>
      `${entry.names.join(" ")} ${entry.stationId} ${entry.baseUrl}`.toLowerCase().includes(query),
    );
  }, [entries, search]);

  function toggle(stationId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(stationId)) next.delete(stationId);
      else next.add(stationId);
      return next;
    });
  }

  async function confirm() {
    const targets: RelayMappingTarget[] = entries
      .filter((entry) => selected.has(entry.stationId))
      .map((entry) => ({
        stationId: entry.stationId,
        // 合并后的站点可能有多个镜像 provider 名，取第一个作为胶囊标题。
        providerName: entry.names[0] ?? entry.stationId,
      }));
    if (targets.length === 0) return;
    setDispatching(true);
    try {
      const ok = await openRelayMappingAgents(targets);
      if (ok) onClose();
    } finally {
      setDispatching(false);
    }
  }

  const allVisibleSelected =
    visible.length > 0 && visible.every((entry) => selected.has(entry.stationId));

  return (
    <Dialog
      title={t("providersMappingPickerTitle")}
      confirmLabel={
        dispatching ? t("providersMappingPickerDispatching") : t("providersMappingPickerConfirm")
      }
      showCloseIcon
      maxWidthClass="max-w-xl"
      icon={Bot}
      onCancel={onClose}
      onConfirm={() => void confirm()}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t("providersMappingPickerHint")}</p>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-2 text-muted" size={14} />
            <input
              className="h-8 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-xs outline-none focus:border-focus"
              placeholder={t("providersMappingPickerSearch")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={`${secondaryButton} h-8`}
            disabled={visible.length === 0}
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current);
                if (allVisibleSelected) {
                  for (const entry of visible) next.delete(entry.stationId);
                } else {
                  for (const entry of visible) next.add(entry.stationId);
                }
                return next;
              })
            }
          >
            {allVisibleSelected ? t("providersSelectNone") : t("providersSelectAll")}
          </button>
        </div>
        <div className="max-h-[46vh] overflow-auto rounded-md border border-border">
          {loading ? (
            <p className="flex items-center justify-center gap-2 p-6 text-xs text-muted">
              <RefreshCw className="animate-spin" size={13} /> {t("providersLoading")}
            </p>
          ) : visible.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted">{t("providersMappingPickerEmpty")}</p>
          ) : (
            visible.map((entry) => (
              <label
                key={entry.stationId}
                className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-xs last:border-b-0 hover:bg-control-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.stationId)}
                  onChange={() => toggle(entry.stationId)}
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
              </label>
            ))
          )}
        </div>
        <p className="text-[11px] text-muted">
          {t("providersMappingPickerSelected", { count: selected.size })}
        </p>
      </div>
    </Dialog>
  );
}
