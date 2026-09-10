import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import {
  activeSessionContext,
  captureRequestGeneration,
  isCurrentRequestGeneration,
} from "./bridge/host-context";
import { requestWithRetry } from "./bridge/request-retry";
import { tCurrent } from "./i18n/use-t";
import { hostErrorLevel, localizeHostError } from "./bridge/localize-host-error";

export type ExportFormat = "html" | "jsonl";

export function exportFileName(
  name: string | undefined,
  sessionId: string,
  format: ExportFormat,
): string {
  const base = (name?.trim() || `session-${sessionId.slice(0, 8)}`).replace(/[\\/:*?"<>|]/g, "-");
  return `${base}.${format}`;
}

/**
 * Export the active session through a native save dialog. Surfaces the
 * outcome via notifications and reveals the file on success. Returns true
 * when the export completed.
 */
export async function requestExport(format: ExportFormat): Promise<boolean> {
  const { host, workspace, session, pushNotification } = useAppStore.getState();
  if (!host || !workspace || !session) return false;
  if (!session.isIdle) {
    pushNotification(tCurrent("notifExportWait"), "info");
    return false;
  }
  let targetPath: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    targetPath = await save({
      defaultPath: exportFileName(session.name, session.sessionId, format),
      filters: [
        format === "html"
          ? { name: "HTML", extensions: ["html"] }
          : { name: "JSONL", extensions: ["jsonl"] },
      ],
    });
  } catch (error) {
    pushNotification(
      error instanceof Error ? error.message : tCurrent("notifSaveDialogUnavailable"),
      "error",
    );
    return false;
  }
  if (!targetPath) return false; // user cancelled the dialog
  const generation = captureRequestGeneration(host);
  try {
    // Export writes a file from the full session; no client-side timeout.
    const res = await requestWithRetry(() =>
      hostClient.request(
        "session.export",
        activeSessionContext(host, workspace, session),
        { format, path: targetPath },
        null,
      ),
    );
    if (!res) return false;
    if (
      !isCurrentRequestGeneration(useAppStore.getState().host, generation, {
        session: true,
      })
    ) {
      return false;
    }
    if (!res.ok) {
      pushNotification(
        res.error ? localizeHostError(res.error, tCurrent) : tCurrent("notifExportFailed"),
        hostErrorLevel(res.error),
      );
      return false;
    }
    pushNotification(tCurrent("notifExported", { path: res.result.path }), "info");
    void revealExportedFile(res.result.path);
    return true;
  } catch (error) {
    pushNotification(
      error instanceof Error ? error.message : tCurrent("notifExportFailed"),
      "error",
    );
    return false;
  }
}

async function revealExportedFile(path: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("desktop_open_path", { path });
  } catch {
    /* Reveal is best-effort; the notification already carries the path. */
  }
}
