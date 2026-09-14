import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, LoaderCircle, XCircle } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { sessionPackageContext } from "../../lib/bridge/host-context";
import { useT } from "../../lib/i18n/use-t";
import { TELEGRAM_PLUGIN_SOURCE } from "./telegram-plugin";

type InstallPhase = "installing" | "done" | "error";

const MAX_INSTALL_ATTEMPTS = 4;
const BUSY_RETRY_DELAY_MS = 1500;

/**
 * Installs the @llblab/pi-telegram plugin (npm). Static copy while running —
 * no progress bar. Package mutations lock globally in the host, so
 * PACKAGE_MUTATION_BUSY is retried automatically; any other failure surfaces
 * with a retry action. On success the token configuration flow opens directly.
 */
export function TelegramInstallDialog({
  onCancel,
  onInstalled,
}: {
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
        if (!host || !workspace) {
          if (alive) {
            setPhase("error");
            setError(t("tgInstallNeedsWorkspace"));
          }
          return;
        }
        const res = await hostClient.request(
          "package.install",
          sessionPackageContext(host, workspace),
          { source: TELEGRAM_PLUGIN_SOURCE, scope: "user" },
          615_000,
        );
        if (!alive) return;
        if (res.ok) {
          setPhase("done");
          // Brief completion flash, then straight into the token flow.
          globalThis.setTimeout(() => {
            if (alive) onInstalledRef.current();
          }, 250);
          return;
        }
        const retryable =
          res.error.code === "PACKAGE_MUTATION_BUSY" ||
          res.error.code === "SERVICE_GRAPH_BUSY" ||
          res.error.code === "STALE_REVISION";
        if (retryable && round < MAX_INSTALL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
          continue;
        }
        setPhase("error");
        setError(res.error.message ?? t("tgInstallFailed"));
        return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [t, attempt]);

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
                {t("tgInstallTitle")}
              </h2>
              <p className="mt-1 text-xs text-muted">{t("tgInstallSubtitle")}</p>

              <div className="mt-4">
                {phase === "installing" && (
                  <p className="text-sm text-muted" role="status">
                    {t("tgInstallWaiting")}
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
