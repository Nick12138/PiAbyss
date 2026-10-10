/**
 * 顶栏云同步操作区（仅备忘录页显示，渲染在 AppTopBar 的
 * data-settings-header-actions 槽位）：刷新（立即同步）按钮 + 云同步设置按钮。
 *
 * 状态点含义：灰 = 未配置/尚未同步；绿 = 最近同步成功；红 = 最近同步失败。
 * 同步成功后广播 MEMO_SYNCED_EVENT，备忘录页据此刷新列表。
 *
 * v2：同步引擎与 R2 密钥配置都由 piabyss-memo 插件自持——本弹窗只保留
 * 状态展示、测试连接与立即同步；密钥/自动同步改到「设置 → 插件 →
 * PiAbyss 备忘录」的配置表单里，弹窗内提供跳转按钮（深链直达配置弹窗）。
 */
import {
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import type { MemoSyncSettings } from "@piabyss/protocol";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { requestPluginConfigDeepLink } from "../plugin-library/plugin-config-deeplink";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { getMemoSyncSettings, syncMemoNow, testMemoSync } from "./memo-client";
import { formatMemoDateTime } from "./memo-model";
import { MEMO_SYNCED_EVENT, refreshMemoSyncStatus, useMemoSyncStatus } from "./memo-sync-status";

/** 承载备忘录云同步的插件库条目（配置表单在这个插件的卡片上）。 */
const MEMO_PLUGIN_ID = "piabyss-memo";

type SyncFeedback = { tone: "success" | "error"; text: string };

export function MemoSyncHeaderActions() {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<MemoSyncSettings | null>(null);
  const [syncBusy, setSyncBusy] = useState<"test" | "sync" | null>(null);
  const [syncMessage, setSyncMessage] = useState<SyncFeedback | null>(null);
  // 状态点/配置判断用共享订阅（标题旁的点与本按钮共用一个 30s 轮询）。
  const syncStatus = useMemoSyncStatus();
  const [toolbarSyncing, setToolbarSyncing] = useState(false);

  const syncConfigured = syncStatus?.configured === true;

  /** 打开云同步弹窗：读取插件控制面回报的同步状态（密钥不回传）。 */
  async function openSyncModal() {
    setSyncMessage(null);
    setSyncModalOpen(true);
    try {
      setSyncSettings(await getMemoSyncSettings());
    } catch (error) {
      setSyncSettings(null);
      pushNotification(
        `${t("memoSyncLoadFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  /** 跳转到「设置 → 插件 → PiAbyss 备忘录」的配置表单（深链直达配置弹窗）。 */
  function openPluginConfig() {
    requestPluginConfigDeepLink(MEMO_PLUGIN_ID);
    useAppStore.getState().openSettingsSection("plugins");
    setSyncModalOpen(false);
  }

  /** 顶栏刷新按钮：立即双向同步一次（成功不弹全局通知，失败才提示）。 */
  async function handleToolbarSync() {
    if (toolbarSyncing) return;
    if (!syncConfigured) {
      pushNotification(t("memoSyncDotDisabled"), "warning");
      return;
    }
    setToolbarSyncing(true);
    try {
      await syncMemoNow();
      refreshMemoSyncStatus();
      window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));
    } catch (error) {
      refreshMemoSyncStatus();
      pushNotification(
        `${t("memoSyncNowFail")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setToolbarSyncing(false);
    }
  }

  /** 用插件当前保存的配置测一次 R2 连通性（配置在设置的插件配置里）。 */
  async function handleSyncTest() {
    if (syncBusy) return;
    setSyncBusy("test");
    setSyncMessage(null);
    try {
      const outcome = await testMemoSync();
      setSyncMessage(
        outcome.ok
          ? { tone: "success", text: t("memoSyncTestOk") }
          : { tone: "error", text: `${t("memoSyncTestFail")}: ${outcome.error}` },
      );
    } catch (error) {
      setSyncMessage({
        tone: "error",
        text: `${t("memoSyncTestFail")}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setSyncBusy(null);
    }
  }

  async function handleSyncNow() {
    if (syncBusy) return;
    setSyncBusy("sync");
    setSyncMessage(null);
    try {
      const stats = await syncMemoNow();
      setSyncSettings(await getMemoSyncSettings());
      refreshMemoSyncStatus();
      setSyncMessage({
        tone: "success",
        text: t("memoSyncSuccess", {
          uploadedNotes: stats.uploadedNotes,
          downloadedNotes: stats.downloadedNotes,
          uploadedImages: stats.uploadedImages,
          downloadedImages: stats.downloadedImages,
        }),
      });
      window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));
    } catch (error) {
      setSyncMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      void getMemoSyncSettings()
        .then(setSyncSettings)
        .catch(() => undefined);
      refreshMemoSyncStatus();
    } finally {
      setSyncBusy(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleToolbarSync()}
        disabled={toolbarSyncing}
        title={t("memoSyncNow")}
        aria-label={t("memoSyncNow")}
        data-testid="memo-sync-refresh"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:opacity-40"
      >
        <RefreshCw size={15} className={toolbarSyncing ? "animate-spin" : ""} />
      </button>
      <button
        type="button"
        onClick={() => void openSyncModal()}
        title={t("memoSyncTitle")}
        aria-label={t("memoSyncTitle")}
        data-testid="memo-sync-open"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
      >
        <CloudUpload size={15} className="shrink-0" />
      </button>

      {/* 云同步弹窗（轻量临时浮层）：状态 + 测试/立即同步 + 跳转插件配置。 */}
      {syncModalOpen && (
        <Dialog
          title={t("memoSyncTitle")}
          icon={CloudUpload}
          showCloseIcon
          hideActions
          confirmLabel={t("memoSyncNow")}
          maxWidthClass="max-w-xl"
          onCancel={() => setSyncModalOpen(false)}
          onConfirm={() => undefined}
        >
          <div className="flex flex-col gap-3 text-left">
            <p className="text-[12px] text-muted">{t("memoSyncDesc")}</p>

            {!syncConfigured && (
              <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning">
                <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{t("memoSyncNotConfigured")}</span>
              </div>
            )}

            {syncSettings && (
              <div className="text-[11px] text-muted">
                {syncSettings.autoSync ? `${t("memoSyncAutoOn")} · ` : ""}
                {syncSettings.lastSyncAt === null
                  ? t("memoSyncNever")
                  : syncSettings.lastSyncOk === true
                    ? `${t("memoSyncLastSync", { time: formatMemoDateTime(syncSettings.lastSyncAt) })}`
                    : `${t("memoSyncLastFailed", { error: syncSettings.lastSyncError ?? "" })}`}
              </div>
            )}
            {syncMessage && (
              <div
                role="status"
                className={`flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] ${
                  syncMessage.tone === "success"
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-danger/40 bg-danger/10 text-danger"
                }`}
              >
                {syncMessage.tone === "success" ? (
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0" aria-hidden />
                ) : (
                  <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 break-words">{syncMessage.text}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={openPluginConfig}
                data-testid="memo-sync-open-config"
                className={`${secondaryButton} text-[12px]`}
              >
                <ExternalLink size={13} />
                <span>{t("memoSyncOpenConfig")}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSyncTest()}
                disabled={syncBusy !== null || !syncConfigured}
                title={syncConfigured ? undefined : t("memoSyncNotConfigured")}
                className={`${secondaryButton} text-[12px]`}
              >
                {syncBusy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
                <span>{t("memoSyncTest")}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSyncNow()}
                disabled={syncBusy !== null || !syncConfigured}
                title={syncConfigured ? undefined : t("memoSyncNotConfigured")}
                className={`${primaryButton} text-[12px]`}
              >
                {syncBusy === "sync" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CloudUpload size={13} />
                )}
                <span>{t("memoSyncNow")}</span>
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
