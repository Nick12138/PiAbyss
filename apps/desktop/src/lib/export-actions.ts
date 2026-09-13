import { useAppStore } from "./stores/app-store";
import { hostClient } from "./bridge/host-client";
import {
  captureRequestGeneration,
  isCurrentRequestGeneration,
  workspaceContext,
} from "./bridge/host-context";
import { requestWithRetry } from "./bridge/request-retry";
import { tCurrent } from "./i18n/use-t";
import { hostErrorLevel, localizeHostError } from "./bridge/localize-host-error";

export type ExportFormat = "html" | "jsonl";

/** Identity of the Session to export; omit it to export the active Session. */
export type ExportTarget =
  { kind: "active" } | { kind: "session"; sessionId: string; sessionPath: string };

/** Default target for every export entry point. */
const ACTIVE_EXPORT_TARGET: ExportTarget = { kind: "active" };

export function exportFileName(
  name: string | undefined,
  sessionId: string,
  format: ExportFormat,
): string {
  const base = (name?.trim() || `session-${sessionId.slice(0, 8)}`).replace(/[\\/:*?"<>|]/g, "-");
  return `${base}.${format}`;
}

/**
 * Export a Session through a native save dialog. Defaults to the active
 * Session; a `session` target exports that Session file instead. Surfaces the
 * outcome via notifications and reveals the file on success.
 */
export async function requestExport(
  format: ExportFormat,
  target: ExportTarget = ACTIVE_EXPORT_TARGET,
): Promise<boolean> {
  const { host, workspace, session, pushNotification } = useAppStore.getState();
  if (!host || !workspace) return false;
  const exportSessionId = target.kind === "session" ? target.sessionId : session?.sessionId;
  const exportName =
    target.kind === "session"
      ? target.sessionPath.replace(/^.*[\\/]/, "").replace(/\.jsonl$/i, "")
      : session?.name;
  if (!exportSessionId) return false;
  const isActiveTarget = target.kind === "active";
  if (isActiveTarget && !session) return false;
  if (isActiveTarget && !session?.isIdle) {
    pushNotification(tCurrent("notifExportWait"), "info");
    return false;
  }
  let targetPath: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    targetPath = await save({
      defaultPath: exportFileName(exportName, exportSessionId, format),
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
        workspaceContext(host, workspace),
        {
          format,
          path: targetPath,
          ...(target.kind === "session"
            ? { sessionId: target.sessionId, sessionPath: target.sessionPath }
            : {}),
        },
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
