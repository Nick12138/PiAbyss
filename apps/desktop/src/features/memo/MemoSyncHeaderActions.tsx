/**
 * 顶栏云同步入口（仅小精灵页显示，渲染在 AppTopBar 的
 * data-settings-header-actions 槽位）：一个图标，点开就是同步弹窗。
 * 待办 · 速记只剩随行面板那一处入口，同步入口因此跟着搬到小精灵页。
 *
 * 状态写在图标上：最近同步失败 → 变红（可访问名补「同步失败」）；未配置 → 常态但可访问名
 * 补「未配置」；成功就是普通图标——「没有坏」不需要提示，「坏了」要一眼看得见。原来旁边
 * 还有「立即同步」按钮与一颗绿色状态点，两个入口加两颗点读起来分不清，都撤了；立即同步
 * 只在弹窗里做。
 * 同步成功后广播 MEMO_SYNCED_EVENT，随行面板「待办 · 速记」据此刷新列表；本组件同时是
 * `useMemoSyncStatus` 30s 轮询的挂载方——顶栏不渲染它，后台 autoSync 落地就没人播报。
 *
 * v2：同步引擎与 R2 密钥配置都由 piabyss-memo 插件自持——本弹窗只保留
 * 状态展示、测试连接与立即同步；密钥/自动同步改到「设置 → 插件 →
 * PiAbyss 待办 · 速记」的配置表单里，弹窗内提供跳转按钮（深链直达配置弹窗）。
 */
import { CheckCircle2, CircleAlert, CloudUpload, ExternalLink, Loader2 } from "lucide-react";
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
  // 配置判断与状态着色用共享订阅（这个按钮是唯一的挂载方，30s 轮询也靠它活着——
  // 没人挂就没有 MEMO_SYNCED_EVENT，随行面板也就收不到「同步落地」）。
  const syncStatus = useMemoSyncStatus();

  const syncConfigured = syncStatus?.configured === true;
  /**
   * 一次只留一个图标，状态就写在它的可访问名上：最近同步失败 → 红色 + 「同步失败」，
   * 未配置 → 常态 + 「未配置」。成功不标色也不表扬——「没有坏」不需要提示，「坏了」必须
   * 一眼看得见。轮询还没回来（或读不到状态）时只报默认名，不瞎猜。
   */
  const syncFailed = syncConfigured && syncStatus?.lastSyncOk === false;
  const syncLabel = syncFailed
    ? `${t("memoSyncTitle")} · ${t("memoSyncDotFail")}`
    : syncStatus !== null && !syncConfigured
      ? `${t("memoSyncTitle")} · ${t("memoSyncDotDisabled")}`
      : t("memoSyncTitle");

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

  /** 跳转到「设置 → 扩展 → PiAbyss 待办 · 速记」的配置表单（深链直达配置弹窗）。 */
  function openPluginConfig() {
    requestPluginConfigDeepLink(MEMO_PLUGIN_ID);
    useAppStore.getState().openSettingsSection("extensions");
    setSyncModalOpen(false);
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
      {/* 顶栏只留这一个图标：点它开同步弹窗（里面有立即同步 / 测试连接 / 跳转配置）。
        状态画在图标上——最近同步失败就整体转红，正常与未配置都是常态。 */}
      <button
        type="button"
        onClick={() => void openSyncModal()}
        title={syncLabel}
        aria-label={syncLabel}
        data-testid="memo-sync-open"
        data-sync-state={syncFailed ? "fail" : syncConfigured ? "idle" : "unconfigured"}
        className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-overlay ${
          syncFailed ? "bg-danger/10 text-danger" : "text-muted hover:text-foreground"
        }`}
      >
        <CloudUpload
          size={15}
          className={`shrink-0 ${syncBusy === "sync" ? "animate-spin" : ""}`}
        />
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
