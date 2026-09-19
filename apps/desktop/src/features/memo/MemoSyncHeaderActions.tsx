/**
 * 顶栏云同步操作区（仅备忘录页显示，渲染在 AppTopBar 的
 * data-settings-header-actions 槽位）：刷新（立即同步）按钮 + 云同步设置按钮。
 *
 * 状态点含义：灰 = 未配置/尚未同步；绿 = 最近同步成功；红 = 最近同步失败。
 * 同步成功后广播 MEMO_SYNCED_EVENT，备忘录页据此刷新列表。
 */
import { Check, CheckCircle2, CircleAlert, CloudUpload, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoSyncConfig, MemoSyncSettings } from "@piabyss/protocol";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { getMemoSyncSettings, setMemoSyncConfig, syncMemoNow, testMemoSync } from "./memo-client";
import { formatMemoDateTime } from "./memo-model";

/** 同步完成后广播的事件名（备忘录页监听后刷新列表）。 */
export const MEMO_SYNCED_EVENT = "piabyss:memo-synced";

const EMPTY_FORM: MemoSyncConfig = {
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  autoSync: false,
};

type SyncFeedback = { tone: "success" | "error"; text: string };

export function MemoSyncHeaderActions() {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);

  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<MemoSyncSettings | null>(null);
  const [syncForm, setSyncForm] = useState<MemoSyncConfig>(EMPTY_FORM);
  const [syncBusy, setSyncBusy] = useState<"test" | "sync" | "save" | null>(null);
  const [syncMessage, setSyncMessage] = useState<SyncFeedback | null>(null);
  // 工具栏状态点用的最近配置/状态（独立于弹窗内编辑中的 syncSettings）。
  const [syncStatus, setSyncStatus] = useState<MemoSyncSettings | null>(null);
  const [toolbarSyncing, setToolbarSyncing] = useState(false);

  const lastSeenSyncAtRef = useRef<number | null>(null);

  /** 状态点数据：挂载时 + 每 30s 轮询（捕获后台 autoSync 的结果）。 */
  const loadSyncStatus = useCallback(() => {
    getMemoSyncSettings()
      .then((settings) => {
        setSyncStatus(settings);
        // lastSyncAt 变化 = 后台（autoSync/启动同步）刚发生过一次同步：
        // 广播事件让备忘录列表也刷新，否则其他设备拉入的变更不会上屏。
        if (
          lastSeenSyncAtRef.current !== null &&
          settings.lastSyncAt !== null &&
          settings.lastSyncAt !== lastSeenSyncAtRef.current
        ) {
          window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));
        }
        lastSeenSyncAtRef.current = settings.lastSyncAt;
      })
      .catch(() => setSyncStatus(null));
  }, []);
  useEffect(() => {
    loadSyncStatus();
    const timer = window.setInterval(loadSyncStatus, 30_000);
    return () => window.clearInterval(timer);
  }, [loadSyncStatus]);

  const syncConfigured =
    syncStatus !== null &&
    syncStatus.accountId !== "" &&
    syncStatus.bucket !== "" &&
    syncStatus.accessKeyId !== "" &&
    syncStatus.secretAccessKey !== "";
  const syncDotClass =
    !syncConfigured || syncStatus?.lastSyncOk === null
      ? "bg-muted"
      : syncStatus?.lastSyncOk === true
        ? "bg-success"
        : "bg-danger";
  const syncDotKey = !syncConfigured
    ? "memoSyncDotDisabled"
    : syncStatus?.lastSyncOk === true
      ? "memoSyncDotOk"
      : syncStatus?.lastSyncOk === false
        ? "memoSyncDotFail"
        : "memoSyncDotNone";

  /** 打开云同步配置弹窗：加载 Host 端已保存的配置与同步状态。 */
  async function openSyncModal() {
    setSyncMessage(null);
    setSyncModalOpen(true);
    try {
      const settings = await getMemoSyncSettings();
      setSyncSettings(settings);
      setSyncForm({
        accountId: settings.accountId,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        bucket: settings.bucket,
        autoSync: settings.autoSync,
      });
    } catch (error) {
      setSyncSettings(null);
      pushNotification(
        `${t("memoSyncLoadFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  /** 顶栏刷新按钮：立即双向同步一次。 */
  async function handleToolbarSync() {
    if (toolbarSyncing) return;
    if (!syncConfigured) {
      pushNotification(t("memoSyncDotDisabled"), "warning");
      return;
    }
    setToolbarSyncing(true);
    try {
      const stats = await syncMemoNow();
      loadSyncStatus();
      window.dispatchEvent(new Event(MEMO_SYNCED_EVENT));
      pushNotification(
        t("memoSyncSuccess", {
          uploadedNotes: stats.uploadedNotes,
          downloadedNotes: stats.downloadedNotes,
          uploadedImages: stats.uploadedImages,
          downloadedImages: stats.downloadedImages,
        }),
        "success",
      );
    } catch (error) {
      loadSyncStatus();
      pushNotification(
        `${t("memoSyncNowFail")}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setToolbarSyncing(false);
    }
  }

  async function handleSyncTest() {
    if (syncBusy) return;
    setSyncBusy("test");
    setSyncMessage(null);
    try {
      const outcome = await testMemoSync(syncForm);
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

  async function handleSyncSave() {
    if (syncBusy) return;
    setSyncBusy("save");
    setSyncMessage(null);
    try {
      const settings = await setMemoSyncConfig(syncForm);
      setSyncSettings(settings);
      // 打开自动同步后保存 → 立即同步一次（拉齐云端 / 补传积压变更）。
      if (syncForm.autoSync) {
        const stats = await syncMemoNow();
        const latest = await getMemoSyncSettings();
        setSyncSettings(latest);
        setSyncStatus(latest);
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
      } else {
        setSyncMessage({ tone: "success", text: t("memoSyncSaved") });
      }
    } catch (error) {
      setSyncMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
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
      // 未保存过的新配置先落盘再同步，保证 autoSync/状态一致。
      const settings = await setMemoSyncConfig(syncForm);
      setSyncSettings(settings);
      const stats = await syncMemoNow();
      const latest = await getMemoSyncSettings();
      setSyncSettings(latest);
      setSyncStatus(latest);
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
        title={`${t("memoSyncTitle")} · ${t(syncDotKey)}`}
        aria-label={`${t("memoSyncTitle")} · ${t(syncDotKey)}`}
        data-testid="memo-sync-open"
        data-sync-state={syncDotKey}
        className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground"
      >
        <CloudUpload size={15} className="shrink-0" />
        <span
          aria-hidden
          className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background ${syncDotClass}`}
        />
      </button>

      {/* 云同步配置弹窗（轻量临时浮层）：R2 密钥配置 + 立即同步。 */}
      {syncModalOpen && (
        <Dialog
          title={t("memoSyncTitle")}
          icon={CloudUpload}
          showCloseIcon
          hideActions
          confirmLabel={t("memoSyncSave")}
          maxWidthClass="max-w-xl"
          onCancel={() => setSyncModalOpen(false)}
          onConfirm={() => undefined}
        >
          <div className="flex flex-col gap-3 text-left">
            <p className="text-[12px] text-muted">{t("memoSyncDesc")}</p>
            <div className="grid grid-cols-2 gap-3">
              <SyncField
                label={t("memoSyncAccountId")}
                value={syncForm.accountId}
                placeholder="xxxxxxxxxxxxxxxx"
                onChange={(value) => setSyncForm((form) => ({ ...form, accountId: value.trim() }))}
              />
              <SyncField
                label={t("memoSyncBucket")}
                value={syncForm.bucket}
                placeholder="my-memos"
                onChange={(value) => setSyncForm((form) => ({ ...form, bucket: value.trim() }))}
              />
              <SyncField
                label={t("memoSyncAccessKeyId")}
                value={syncForm.accessKeyId}
                onChange={(value) =>
                  setSyncForm((form) => ({ ...form, accessKeyId: value.trim() }))
                }
              />
              <SyncField
                label={t("memoSyncSecret")}
                value={syncForm.secretAccessKey}
                password
                onChange={(value) =>
                  setSyncForm((form) => ({ ...form, secretAccessKey: value.trim() }))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="text-[12px] text-foreground">{t("memoSyncAuto")}</span>
              <Switch
                checked={syncForm.autoSync}
                onChange={(next) => setSyncForm((form) => ({ ...form, autoSync: next }))}
                label={t("memoSyncAuto")}
              />
            </div>

            {syncSettings && (
              <div className="text-[11px] text-muted">
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

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleSyncTest()}
                disabled={syncBusy !== null}
                className={`${secondaryButton} text-[12px]`}
              >
                {syncBusy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
                <span>{t("memoSyncTest")}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSyncSave()}
                disabled={syncBusy !== null}
                className={`${secondaryButton} text-[12px]`}
              >
                {syncBusy === "save" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                <span>{t("memoSyncSave")}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleSyncNow()}
                disabled={syncBusy !== null || !syncForm.accountId || !syncForm.bucket}
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

/** 弹窗内的配置字段行：label + 输入框。 */
function SyncField({
  label,
  value,
  onChange,
  placeholder,
  password = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type={password ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-[12px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus"
      />
    </label>
  );
}
