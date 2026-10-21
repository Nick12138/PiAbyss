import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  Wifi,
} from "lucide-react";
import type {
  RemoteInstallStep,
  RemoteInstallStepId,
  RemotePairStartResult,
  RemoteStatus,
} from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Switch } from "../../components/Switch";

const REFRESH_IDLE_MS = 5_000;
const REFRESH_INSTALLING_MS = 1_200;
const PAIRING_POLL_MS = 1_500;

const STEP_LABEL_KEY: Record<RemoteInstallStepId, MessageKey> = {
  uv: "remoteStepUv",
  python: "remoteStepPython",
  connector: "remoteStepConnector",
  verify: "remoteStepVerify",
};

function statusTone(state: RemoteStatus["connector"]["state"]): string {
  switch (state) {
    case "running":
      return "border-success/40 bg-success/10 text-success";
    case "foreign":
      return "border-warning/40 bg-warning/10 text-warning";
    case "stopped":
      return "border-border bg-surface-overlay/60 text-muted";
    default:
      return "border-border bg-surface-overlay/60 text-muted";
  }
}

function StepIcon({ state }: { state: RemoteInstallStep["state"] }) {
  if (state === "running") return <Loader2 size={14} className="animate-spin text-accent" />;
  if (state === "done") return <Check size={14} className="text-success" />;
  if (state === "failed") return <AlertTriangle size={14} className="text-danger" />;
  if (state === "skipped") return <Check size={14} className="text-muted" />;
  return <span className="block size-3.5 rounded-full border border-border" aria-hidden="true" />;
}

export function RemoteSettings() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [serverDraft, setServerDraft] = useState("");
  const [uvDraft, setUvDraft] = useState("");
  const [pypiDraft, setPypiDraft] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pairing, setPairing] = useState<RemotePairStartResult | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const draftInit = useRef(false);

  const refresh = useCallback(async (): Promise<RemoteStatus | null> => {
    if (!host) return null;
    try {
      const response = await hostClient.request("remote.getStatus", hostContext(host), null);
      if (!response.ok) throw new Error(response.error.message);
      setStatus(response.result);
      setLoadError(null);
      return response.result;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [host]);

  // 第一次拿到状态时同步表单草稿；之后的轮询不覆盖用户正在编辑的内容。
  useEffect(() => {
    if (!status || draftInit.current) return;
    draftInit.current = true;
    setServerDraft(status.settings.serverUrl);
    setUvDraft(status.settings.uvPath ?? "");
    setPypiDraft(status.settings.pypiIndex ?? "");
    setSourceDraft(status.settings.connectorSource);
  }, [status]);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const next = await refresh();
      if (cancelled) return;
      const delay =
        next?.stage === "installing" || next?.pairing === "pending"
          ? REFRESH_INSTALLING_MS
          : REFRESH_IDLE_MS;
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [host, refresh]);

  useEffect(() => {
    if (!pairing || !host) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await hostClient.request("remote.pairPoll", hostContext(host), {
            pairingId: pairing.pairingId,
          });
          if (!response.ok) return;
          if (response.result.state === "claimed") {
            setPairing(null);
            setPairingError(null);
            pushNotification(t("remotePairClaimed"), "success");
            void refresh();
          } else if (response.result.state === "expired" || response.result.state === "failed") {
            setPairingError(response.result.detail ?? t("remotePairExpired"));
            setPairing(null);
          }
        } catch {
          // 轮询失败留在等待态，下一次 tick 再试。
        }
      })();
    }, PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [pairing, host, refresh, pushNotification, t]);

  async function run(label: string, action: () => Promise<RemoteStatus>): Promise<void> {
    if (busy) return;
    setBusy(label);
    setActionError(null);
    try {
      setStatus(await action());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      pushNotification(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function requestStatus(
    method:
      "remote.install" | "remote.uninstall" | "remote.setConnectorRunning" | "remote.configure",
    params: unknown,
  ): Promise<RemoteStatus> {
    if (!host) throw new Error(t("remoteLoadFailed"));
    const response = await hostClient.request(method, hostContext(host), params as never);
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }

  async function enableAndInstall(): Promise<void> {
    await run("install", async () => {
      await requestStatus("remote.configure", { enabled: true });
      return requestStatus("remote.install", null);
    });
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    await run("enabled", () => requestStatus("remote.configure", { enabled }));
  }

  async function saveServer(): Promise<void> {
    await run("server", async () => {
      const next = await requestStatus("remote.configure", { serverUrl: serverDraft });
      pushNotification(t("remoteSaved"), "success");
      return next;
    });
  }

  async function saveAdvanced(): Promise<void> {
    await run("advanced", () =>
      requestStatus("remote.configure", {
        uvPath: uvDraft.trim() ? uvDraft.trim() : null,
        pypiIndex: pypiDraft.trim() ? pypiDraft.trim() : null,
        connectorSource: sourceDraft.trim(),
      }),
    );
  }

  async function toggleConnector(running: boolean): Promise<void> {
    await run("connector", () => requestStatus("remote.setConnectorRunning", { running }));
  }

  async function startPairing(): Promise<void> {
    if (!host || busy) return;
    setBusy("pair");
    setPairingError(null);
    try {
      const response = await hostClient.request("remote.pairStart", hostContext(host), null);
      if (!response.ok) throw new Error(response.error.message);
      setPairing(response.result);
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(response.result.webUrl).catch(() => undefined);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPairingError(message);
      pushNotification(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      pushNotification(t("remotePairCopied"), "success");
    } catch {
      pushNotification(t("remoteActionFailed"), "error");
    }
  }

  async function openExternal(url: string): Promise<void> {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function openPath(path: string): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path });
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : String(error), "error");
    }
  }

  if (!status) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
          <div className="mx-auto max-w-2xl">
            {loadError ? (
              <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
                <p className="mb-2 font-medium">{t("remoteLoadFailed")}</p>
                <p className="mb-3 break-words text-xs text-muted">{loadError}</p>
                <button type="button" className={secondaryButton} onClick={() => void refresh()}>
                  {t("remoteRefresh")}
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted">{t("remoteLoading")}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const gate = !status.settings.enabled;
  const installing = status.stage === "installing";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          {actionError && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-xs text-danger">
              {actionError}
            </div>
          )}

          {gate ? (
            <>
              <section>
                <div className="flex items-start gap-3 rounded-lg border border-border p-4">
                  <div className="mt-0.5 rounded-md bg-accent/10 p-2 text-accent">
                    <Smartphone size={20} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("remoteGateTitle")}</h2>
                    <p className="mt-1 text-sm text-muted">{t("remoteGateBody")}</p>
                  </div>
                </div>
              </section>

              <section>
                <ul className="flex flex-col gap-2 text-sm">
                  <li className="flex items-start gap-2">
                    <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
                    <span className="text-muted">{t("remoteGatePointLocal")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Download size={15} className="mt-0.5 shrink-0 text-accent" />
                    <span className="text-muted">{t("remoteGatePointInstall")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Wifi size={15} className="mt-0.5 shrink-0 text-muted" />
                    <span className="text-muted">{t("remoteGatePointAccount")}</span>
                  </li>
                </ul>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted">{t("remoteDepsTitle")}</h2>
                <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
                  <span>{t("remoteDepsUv")}</span>
                  <span>{t("remoteDepsPython")}</span>
                  <span>{t("remoteDepsConnector")}</span>
                </div>
                <p className="mt-2 text-xs text-muted">{t("remoteGateHintExisting")}</p>
                <p className="mt-1 text-xs text-muted">{t("remoteGateNetworkHint")}</p>
              </section>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy !== null}
                  onClick={() => void enableAndInstall()}
                >
                  {busy === "install" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  {busy === "install" ? t("remoteEnabling") : t("remoteEnableInstall")}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy !== null}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} />
                  {t("remoteRefresh")}
                </button>
              </div>
            </>
          ) : installing ? (
            <section>
              <div className="rounded-lg border border-border p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Loader2 size={16} className="animate-spin text-accent" />
                  {t("remoteInstallingTitle")}
                </div>
                <p className="mb-4 text-xs text-muted">{t("remoteInstallingBody")}</p>
                <ul className="flex flex-col gap-2 text-sm">
                  {status.steps.map((step) => (
                    <li key={step.id} className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <StepIcon state={step.state} />
                        {t(STEP_LABEL_KEY[step.id])}
                      </span>
                      <span
                        className="truncate font-mono text-xs text-muted"
                        title={step.detail ?? ""}
                      >
                        {step.detail ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <InstallLog lines={status.logTail} title={t("remoteInstallLog")} />
            </section>
          ) : (
            <>
              {status.stage === "failed" && (
                <section>
                  <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <AlertTriangle size={16} className="text-danger" />
                      {t("remoteInstallFailedTitle")}
                    </div>
                    {status.error && (
                      <p className="mt-2 break-words text-xs text-muted">{status.error}</p>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={busy !== null}
                        onClick={() =>
                          void run("install", () => requestStatus("remote.install", null))
                        }
                      >
                        <Download size={14} />
                        {t("remoteRetry")}
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => void openPath(status.paths.installDir)}
                      >
                        <FolderOpen size={14} />
                        {t("remoteOpenFolder")}
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => void setEnabled(false)}
                      >
                        {t("remoteDisable")}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted">{t("remoteStatusTitle")}</h2>
                <div className="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${statusTone(status.connector.state)}`}
                    >
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                      {status.connector.state === "running"
                        ? t("remoteConnectorRunning")
                        : status.connector.state === "foreign"
                          ? t("remoteConnectorForeign")
                          : status.connector.state === "stopped"
                            ? t("remoteConnectorStopped")
                            : t("remoteConnectorUnconfigured")}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null || status.connector.state === "foreign"}
                        onClick={() => void toggleConnector(status.connector.state !== "running")}
                      >
                        {status.connector.state === "running" ? (
                          <>
                            <Square size={12} />
                            {t("remoteStop")}
                          </>
                        ) : (
                          <>
                            <Play size={12} />
                            {t("remoteStart")}
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => void refresh()}
                        aria-label={t("remoteRefresh")}
                      >
                        <RefreshCw size={12} />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <span className="shrink-0 text-muted">{t("remoteDeviceId")}</span>
                    <span
                      className="truncate font-mono text-xs"
                      title={status.connector.connectorId ?? ""}
                    >
                      {status.connector.connectorId ?? t("remoteDeviceNone")}
                    </span>
                  </div>
                  {status.connector.pid !== null && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">{t("remoteConnectorPid")}</span>
                      <span className="font-mono text-xs">
                        {status.connector.pid}
                        {status.connector.source ? ` · ${status.connector.source}` : ""}
                      </span>
                    </div>
                  )}

                  <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-3">
                    <span className="min-w-0">
                      <span className="block">{t("remoteServerLabel")}</span>
                      <span className="block text-xs text-muted">{t("remoteServerCloud")}</span>
                    </span>
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        value={serverDraft}
                        onChange={(event) => setServerDraft(event.target.value)}
                        placeholder={t("remoteServerPlaceholder")}
                        className="h-8 w-56 rounded-md border border-border bg-surface px-2 text-xs"
                        aria-label={t("remoteServerLabel")}
                      />
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => void saveServer()}
                      >
                        {t("remoteSave")}
                      </button>
                    </div>
                  </div>

                  <label className="flex items-center justify-between gap-3 border-t border-border pt-3">
                    <span>{t("remoteAutoStart")}</span>
                    <Switch
                      checked={status.settings.autoStart}
                      label={t("remoteAutoStart")}
                      disabled={busy !== null}
                      onChange={(next) =>
                        void run("autoStart", () =>
                          requestStatus("remote.configure", { autoStart: next }),
                        )
                      }
                    />
                  </label>

                  <div className="flex justify-end border-t border-border pt-3">
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={busy !== null}
                      onClick={() => void setEnabled(false)}
                    >
                      {t("remoteDisable")}
                    </button>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted">{t("remotePairTitle")}</h2>
                <div className="rounded-lg border border-border p-4">
                  <p className="text-xs text-muted">{t("remotePairBody")}</p>
                  {pairing ? (
                    <div className="mt-3 flex flex-col gap-3">
                      <div className="flex items-center gap-2">
                        <code className="rounded-md border border-border bg-surface-overlay px-3 py-1.5 font-mono text-base tracking-[0.3em]">
                          {pairing.code}
                        </code>
                        <button
                          type="button"
                          className={secondaryButton}
                          onClick={() => void copyCode(pairing.code)}
                        >
                          <Copy size={12} />
                          {t("remotePairCopy")}
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          onClick={() => void openExternal(pairing.webUrl)}
                        >
                          <ExternalLink size={12} />
                          {t("remotePairOpen")}
                        </button>
                      </div>
                      <p className="flex items-center gap-2 text-xs text-muted">
                        <Loader2 size={12} className="animate-spin" />
                        {t("remotePairWaiting")}
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => void startPairing()}
                      >
                        <Smartphone size={12} />
                        {status.connector.configured ? t("remoteRepair") : t("remotePairStart")}
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => void openExternal(status.activeServerOrigin)}
                      >
                        <ExternalLink size={12} />
                        {t("remotePairOpen")}
                      </button>
                    </div>
                  )}
                  {pairingError && <p className="mt-2 text-xs text-danger">{pairingError}</p>}
                  {status.connector.state === "foreign" && (
                    <p className="mt-2 text-xs text-warning">{t("remoteForeignHint")}</p>
                  )}
                </div>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted">{t("remoteRuntimeTitle")}</h2>
                <div className="rounded-lg border border-border p-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
                        status.runtime === "ready"
                          ? "border-success/40 bg-success/10 text-success"
                          : status.runtime === "install"
                            ? "border-info/40 bg-info/10 text-info"
                            : "border-warning/40 bg-warning/10 text-warning"
                      }`}
                    >
                      {status.runtime === "ready"
                        ? t("remoteRuntimeReady")
                        : status.runtime === "install"
                          ? t("remoteRuntimeInstall")
                          : t("remoteRuntimeMissing")}
                    </span>
                    <span className="text-xs text-muted">
                      {status.runtime === "ready"
                        ? t("remoteRuntimeReadyNote")
                        : status.runtime === "install"
                          ? t("remoteRuntimeInstallNote")
                          : t("remoteRuntimeMissingNote")}
                    </span>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted">{t("remoteVersionsTitle")}</h2>
                <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">uv</span>
                    <span className="font-mono text-xs">
                      {status.versions.uv ?? t("remoteNotInstalled")}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Python</span>
                    <span className="font-mono text-xs">
                      {status.versions.python ?? t("remoteNotInstalled")}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">anywhere-cli</span>
                    <span className="font-mono text-xs">
                      {status.versions.connector ?? t("remoteNotInstalled")}
                    </span>
                  </div>
                  {status.stage === "idle" && (
                    <div className="mt-1">
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={busy !== null}
                        onClick={() =>
                          void run("install", () => requestStatus("remote.install", null))
                        }
                      >
                        <Download size={14} />
                        {t("remoteInstallNow")}
                      </button>
                    </div>
                  )}
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-muted">{t("remoteAdvanced")}</h2>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setShowAdvanced((value) => !value)}
                  >
                    {showAdvanced ? t("remoteHide") : t("remoteShow")}
                  </button>
                </div>
                {showAdvanced && (
                  <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border p-4 text-sm">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t("remoteUvPath")}</span>
                      <input
                        value={uvDraft}
                        onChange={(event) => setUvDraft(event.target.value)}
                        placeholder={t("remoteUvPathPlaceholder")}
                        className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t("remotePypiIndex")}</span>
                      <input
                        value={pypiDraft}
                        onChange={(event) => setPypiDraft(event.target.value)}
                        placeholder={t("remotePypiIndexPlaceholder")}
                        className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t("remoteConnectorSource")}</span>
                      <input
                        value={sourceDraft}
                        onChange={(event) => setSourceDraft(event.target.value)}
                        className="h-8 rounded-md border border-border bg-surface px-2 font-mono text-xs"
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => void saveAdvanced()}
                      >
                        {t("remoteSave")}
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => void openPath(status.paths.dataDir)}
                      >
                        <FolderOpen size={12} />
                        {t("remoteOpenDataDir")}
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/40 px-2.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
                        disabled={busy !== null || installing}
                        onClick={() => setConfirmUninstall(true)}
                      >
                        <Trash2 size={12} />
                        {t("remoteUninstall")}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <InstallLog lines={status.logTail} title={t("remoteInstallLog")} />
            </>
          )}
        </div>
      </div>

      {confirmUninstall && (
        <Dialog
          title={t("remoteUninstallTitle")}
          confirmLabel={t("remoteUninstallConfirm")}
          tone="danger"
          onCancel={() => setConfirmUninstall(false)}
          onConfirm={() => {
            setConfirmUninstall(false);
            void run("uninstall", () => requestStatus("remote.uninstall", null));
          }}
        >
          <p>{t("remoteUninstallBody")}</p>
        </Dialog>
      )}
    </div>
  );
}

function InstallLog({ lines, title }: { lines: string[]; title: string }) {
  if (lines.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-muted">{title}</h2>
      <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-surface-overlay/50 p-3 font-mono text-[11px] leading-5 text-muted">
        {lines.join("\n")}
      </pre>
    </section>
  );
}
