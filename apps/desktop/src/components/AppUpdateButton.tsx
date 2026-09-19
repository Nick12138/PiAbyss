import { useAppStore } from "../lib/stores/app-store";
import { useT } from "../lib/i18n/use-t";

/** Top bar button for the app self-update flow.
 *
 *  Rendered to the left of the dock toggle in the top bar's right segment and
 *  stays visible ("常驻") for as long as an update is available but not yet
 *  applied. Idle it reads "下载并更新"; after a click it turns into a live
 *  "下载中 0-100%" progress label, and once the download finishes the app
 *  restarts automatically to apply the update — no further interaction. */
export function AppUpdateButton() {
  const t = useT();
  const updatePhase = useAppStore((s) => s.appUpdatePhase);
  const setUpdatePhase = useAppStore((s) => s.setAppUpdatePhase);
  const pushNotification = useAppStore((s) => s.pushNotification);

  if (
    updatePhase.state !== "available" &&
    updatePhase.state !== "downloading" &&
    updatePhase.state !== "installing"
  ) {
    return null;
  }
  const update = updatePhase.update;
  const downloading = updatePhase.state === "downloading";
  const percent =
    downloading && updatePhase.totalBytes !== null && updatePhase.totalBytes > 0
      ? Math.min(100, Math.round((updatePhase.downloadedBytes / updatePhase.totalBytes) * 100))
      : null;
  const label =
    updatePhase.state === "installing"
      ? t("topbarUpdateRestarting")
      : downloading
        ? percent !== null
          ? t("topbarUpdateDownloadingPercent", { percent })
          : t("hostUpdateDownloading")
        : t("topbarUpdateDownload");

  async function downloadAndInstall() {
    if (updatePhase.state !== "available") return;
    setUpdatePhase({ state: "downloading", update, downloadedBytes: 0, totalBytes: null });
    try {
      await update.download((progress) => {
        setUpdatePhase(
          progress.phase === "installing"
            ? { state: "installing", update }
            : {
                state: "downloading",
                update,
                downloadedBytes: progress.downloadedBytes,
                totalBytes: progress.totalBytes,
              },
        );
      });
      // Download complete: restart automatically to apply the update. On
      // success the app relaunches, so this promise never settles visibly.
      setUpdatePhase({ state: "installing", update });
      await update.restart();
    } catch (err) {
      setUpdatePhase({ state: "available", update });
      pushNotification(
        err instanceof Error
          ? `${t("notifUpdateInstallFailed")}: ${err.message}`
          : t("notifUpdateInstallFailed"),
        "error",
      );
    }
  }

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-live="polite"
      data-app-update-button
      className="flex h-6 shrink-0 items-center justify-center rounded-md bg-accent px-2 text-[11px] font-medium leading-none text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => void downloadAndInstall()}
    >
      {downloading && percent === null && (
        <span className="mr-1.5 size-2 animate-pulse rounded-full bg-current" aria-hidden="true" />
      )}
      {label}
    </button>
  );
}
