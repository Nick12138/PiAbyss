import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, LoaderCircle, XCircle } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { sessionPackageContext, workspaceContext } from "../../lib/bridge/host-context";
import { installTelegramPlugin } from "../../lib/bridge/tauri-transport";
import { useT } from "../../lib/i18n/use-t";
import { useTelegramViewStore } from "./telegram-view-store";
import { isTelegramPluginRecord, TELEGRAM_PLUGIN_SOURCE } from "./telegram-plugin";

type InstallPhase = "installing" | "done" | "error";

const MAX_INSTALL_ATTEMPTS = 4;
const BUSY_RETRY_DELAY_MS = 1500;
/** Host error codes that are transient: a stale session revision, an
 *  in-flight package mutation, or a busy service graph all clear on their
 *  own, so the attempt is retried with fresh context. */
const RETRYABLE_ERROR_CODES = new Set([
  "PACKAGE_MUTATION_BUSY",
  "SERVICE_GRAPH_BUSY",
  "STALE_REVISION",
]);

/** Failure shape normalized from both install channels. */
type InstallFailure = { code?: string; message?: string };

function isRetryableFailure(failure: InstallFailure): boolean {
  if (failure.code && RETRYABLE_ERROR_CODES.has(failure.code)) return true;
  // The dedicated-Host channel reports some transient failures without a
  // host error code (transport/hello hiccups while the Host is starting).
  return /busy|stale|timed out/i.test(failure.message ?? "");
}

/**
 * Installs the @llblab/pi-telegram plugin (npm) into the DEDICATED telegram
 * workspace at PROJECT scope — the plugin's tools, commands and skills then
 * load only in that workspace, never in the user's other workspaces. Static
 * copy while running — no progress bar. Package mutations lock globally in
 * the host, so PACKAGE_MUTATION_BUSY is retried automatically; any other
 * failure surfaces with a retry action. On success the token configuration
 * flow opens directly.
 *
 * `mode: "migrate"` is the legacy path for installs that predate project
 * scope: it additionally removes the leftover USER-scope entry from the
 * global agent settings after the project-scope install succeeds.
 */
export function TelegramInstallDialog({
  mode = "install",
  onCancel,
  onInstalled,
}: {
  mode?: "install" | "migrate";
  onCancel: () => void;
  onInstalled: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<InstallPhase>("installing");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  useEffect(() => {
    let alive = true;
    void (async () => {
      for (let round = 1; round <= MAX_INSTALL_ATTEMPTS; round += 1) {
        if (!alive) return;
        // Re-read the latest host state on every attempt: a stale session
        // revision (STALE_REVISION) or an in-flight package mutation is
        // transient, and the retry must carry fresh context.
        const { host, workspace } = useAppStore.getState();
        if (!host) {
          if (alive) {
            setPhase("error");
            setError(t("tgInstallNeedsWorkspace"));
          }
          return;
        }
        const workspacePath = await useTelegramViewStore.getState().ensureTelegramWorkspace();
        if (!workspacePath) {
          if (alive) {
            setPhase("error");
            setError(t("tgInstallNeedsWorkspace"));
          }
          return;
        }

        // 1. Install into the dedicated telegram workspace at project scope.
        //    Runs on a background Host owned by the desktop shell; no active
        //    session context from the renderer's foreground workspace is used.
        const outcome = await installTelegramPlugin(workspacePath, TELEGRAM_PLUGIN_SOURCE);
        if (!alive) return;
        if (!outcome.ok) {
          const failure: InstallFailure = {
            code: outcome.errorCode,
            message: outcome.errorMessage,
          };
          if (isRetryableFailure(failure) && round < MAX_INSTALL_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
            continue;
          }
          setPhase("error");
          setError(failure.message ?? t("tgInstallFailed"));
          return;
        }

        // 2. Migration only: drop the legacy user-scope entry so the plugin
        //    stops loading in every workspace's sessions.
        if (mode === "migrate") {
          if (!workspace) {
            if (alive) {
              setPhase("error");
              setError(t("tgInstallNeedsWorkspace"));
            }
            return;
          }
          // Find the user-scope record in the active workspace's snapshot —
          // removal is addressed by packageId, not source.
          const listRes = await hostClient.request(
            "package.list",
            workspaceContext(host, workspace),
            { scope: "all" },
            60_000,
          );
          if (!alive) return;
          const userRecord = listRes.ok
            ? listRes.result.configured.find(
                (record) => record.scope === "user" && isTelegramPluginRecord(record),
              )
            : undefined;
          if (userRecord) {
            const res = await hostClient.request(
              "package.remove",
              sessionPackageContext(host, workspace),
              { packageId: userRecord.id },
              180_000,
            );
            if (!alive) return;
            if (!res.ok) {
              const failure: InstallFailure = {
                code: res.error.code,
                message: res.error.message,
              };
              if (isRetryableFailure(failure) && round < MAX_INSTALL_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
                continue;
              }
              setPhase("error");
              setError(failure.message ?? t("tgInstallFailed"));
              return;
            }
          }
        }

        setPhase("done");
        // Brief completion flash, then straight into the token flow.
        globalThis.setTimeout(() => {
          if (alive) onInstalledRef.current();
        }, 250);
        return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [t, attempt, mode]);

  return createPortal(
    (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="telegram-install-dialog-title"
          className="theme-floating-surface w-full max-w-md rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md bg-accent/15 p-1.5 text-accent">
              {phase === "error" ? (
                <XCircle size={18} />
              ) : phase === "done" ? (
                <Bot size={18} />
              ) : (
                <LoaderCircle size={18} className="animate-spin" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="telegram-install-dialog-title" className="text-base font-semibold">
                {mode === "migrate" ? t("tgMigrateTitle") : t("tgInstallTitle")}
              </h2>
              <p className="mt-1 text-xs text-muted">
                {mode === "migrate" ? t("tgMigrateSubtitle") : t("tgInstallSubtitle")}
              </p>

              <div className="mt-4">
                {phase === "installing" && (
                  <p className="text-sm text-muted" role="status">
                    {mode === "migrate" ? t("tgMigrateWaiting") : t("tgInstallWaiting")}
                  </p>
                )}
                {phase === "done" && (
                  <p className="text-sm text-success" role="status">
                    {t("tgInstallDone")}
                  </p>
                )}
                {phase === "error" && (
                  <p className="text-xs text-danger" role="status">
                    {error ?? t("tgInstallFailed")}
                  </p>
                )}
              </div>

              <div className="mt-5 flex justify-end gap-2">
                {phase === "error" ? (
                  <>
                    <button
                      type="button"
                      className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                      onClick={onCancel}
                    >
                      {t("commonCancel")}
                    </button>
                    <button
                      type="button"
                      className="interface-density-control inline-flex h-8 items-center justify-center rounded-md bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent-hover"
                      onClick={() => {
                        setPhase("installing");
                        setError(null);
                        setAttempt((current) => current + 1);
                      }}
                    >
                      {t("commonRetry")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                    onClick={onCancel}
                  >
                    {t("tgInstallCancel")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    ) as ReactNode,
    document.body,
  );
}
