import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, LoaderCircle, Trash2 } from "lucide-react";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { editDraft } from "../../lib/draft-persistence";
import { draftTargetFor } from "../../lib/draft-target";
import { useT } from "../../lib/i18n/use-t";
import {
  loadTelegramBridgePrefEnabled,
  saveTelegramBridgePrefEnabled,
  useTelegramViewStore,
} from "./telegram-view-store";

/** Fallback when the programmatic bridge command cannot run: pre-fill the
 *  slash command into the current composer so the user can run it manually. */
function prefilledCommand(command: string): void {
  const { workspace, session } = useAppStore.getState();
  const target = draftTargetFor(workspace, session);
  if (target) editDraft(target, command);
}

/**
 * Telegram workspace settings: re-configure the bot token (masked current
 * value + bound account status), tune the plugin's assistant/voice/threads
 * options (0.39.x telegram.json schema), toggle the bridge via a header
 * switch, and delete everything telegram-related (config + temp state +
 * workspace dir + sessions; the plugin package stays installed).
 */
export function TelegramSettingsDialog({
  onCancel,
  onChanged,
}: {
  onCancel: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const profile = useTelegramViewStore((s) => s.profile);
  const tokenMasked = useTelegramViewStore((s) => s.tokenMasked);
  const bound = useTelegramViewStore((s) => s.bound);
  const assistant = useTelegramViewStore((s) => s.assistant);
  const voice = useTelegramViewStore((s) => s.voice);
  const threads = useTelegramViewStore((s) => s.threads);
  const applyConfig = useTelegramViewStore((s) => s.applyTelegramConfig);
  const refreshConfig = useTelegramViewStore((s) => s.refreshTelegramConfig);
  const bridgeStatus = useTelegramViewStore((s) => s.bridgeStatus);
  const bridgeLoading = useTelegramViewStore((s) => s.bridgeLoading);
  const refreshBridgeStatus = useTelegramViewStore((s) => s.refreshBridgeStatus);
  const startTelegramBridgeInBackground = useTelegramViewStore(
    (s) => s.startTelegramBridgeInBackground,
  );
  const stopTelegramBridge = useTelegramViewStore((s) => s.stopTelegramBridge);
  const exitTelegramWorkspace = useTelegramViewStore((s) => s.exitTelegramWorkspace);

  // --- token reconfiguration ---
  const [token, setToken] = useState("");
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);

  // --- plugin option form ---
  const [rendering, setRendering] = useState(assistant?.rendering ?? "");
  const [activity, setActivity] = useState(assistant?.activity ?? "");
  const [timeInjection, setTimeInjection] = useState(assistant?.timeInjection ?? "");
  const [proactivePush, setProactivePush] = useState(assistant?.proactivePush ?? false);
  const [replyMode, setReplyMode] = useState(voice?.replyMode ?? "");
  const [automaticCleanup, setAutomaticCleanup] = useState(threads?.automaticCleanup ?? false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSaved, setConfigSaved] = useState(false);

  // --- bridge switch + delete ---
  // The switch mirrors the real bridge state (owners.json); before any status
  // arrives, fall back to the stored user preference.
  const [prefBridgeOn, setPrefBridgeOn] = useState(() => loadTelegramBridgePrefEnabled());
  const bridgeOn = bridgeStatus?.connected ?? prefBridgeOn;
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Fresh status when the dialog opens, so the switch shows the live bridge.
  useEffect(() => {
    void refreshBridgeStatus();
    void refreshConfig();
  }, [refreshBridgeStatus, refreshConfig]);

  async function toggleBridge(next: boolean) {
    if (bridgeBusy) return;
    setBridgeBusy(true);
    // The bridge belongs to the dedicated Telegram Host, regardless of the
    // currently selected foreground workspace.
    const ok = next ? await startTelegramBridgeInBackground() : await stopTelegramBridge();
    setBridgeBusy(false);
    if (!ok) {
      prefilledCommand(next ? "/telegram-connect" : "/telegram-disconnect");
      return;
    }
    saveTelegramBridgePrefEnabled(next);
    setPrefBridgeOn(next);
    // Polling starts/stops asynchronously inside the host; refresh the owners
    // file shortly after so the switch reflects the actual state.
    globalThis.setTimeout(() => void refreshBridgeStatus(), 1200);
    onChanged();
  }

  async function validateToken() {
    const trimmed = token.trim();
    if (!trimmed || !host) {
      setTokenError(t("botAddTelegramTokenRequired"));
      return;
    }
    setValidating(true);
    setTokenError(null);
    setTokenPreview(null);
    try {
      const res = await hostClient.request(
        "telegram.validateToken",
        hostContext(host),
        { token: trimmed },
        20_000,
      );
      if (!res.ok || !res.result.ok) {
        setTokenError(
          res.ok
            ? (res.result.description ?? t("botAddTelegramValidateFailed"))
            : res.error.message,
        );
        return;
      }
      setTokenPreview(res.result.username ?? res.result.firstName ?? t("botAddTelegramUnknownBot"));
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : t("botAddTelegramValidateFailed"));
    } finally {
      setValidating(false);
    }
  }

  async function saveToken() {
    const trimmed = token.trim();
    if (!host || !tokenPreview) return;
    setTokenSaving(true);
    setTokenError(null);
    try {
      const res = await hostClient.request(
        "telegram.saveProfile",
        hostContext(host),
        { token: trimmed },
        15_000,
      );
      if (!res.ok) {
        setTokenError(res.error.message ?? t("botAddTelegramSaveFailed"));
        return;
      }
      setToken("");
      setTokenSaved(true);
      void refreshConfig(); // refresh the masked value + bound account
      onChanged();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : t("botAddTelegramSaveFailed"));
    } finally {
      setTokenSaving(false);
    }
  }

  async function saveConfig() {
    setConfigSaving(true);
    setConfigError(null);
    setConfigSaved(false);
    const assistantPatch: NonNullable<Parameters<typeof applyConfig>[0]> = { proactivePush };
    if (rendering) assistantPatch.rendering = rendering as "rich" | "html";
    if (activity) assistantPatch.activity = activity as "quiet" | "thinking" | "tools" | "verbose";
    if (timeInjection) {
      assistantPatch.timeInjection = timeInjection as "hidden" | "always" | "interval";
    }
    const voicePatch = replyMode
      ? { replyMode: replyMode as "manual" | "hidden" | "mirror" | "always" }
      : null;
    const threadsPatch = { automaticCleanup };
    const ok = await applyConfig(assistantPatch, voicePatch, threadsPatch);
    setConfigSaving(false);
    if (!ok) {
      setConfigError(t("tgSettingsConfigSaveFailed"));
      return;
    }
    setConfigSaved(true);
    onChanged();
  }

  async function deleteAll() {
    if (!host || deleting) return;
    setDeleting(true);
    try {
      const res = await hostClient.request("telegram.reset", hostContext(host), null, 15_000);
      if (!res.ok) {
        setConfirmDeleteOpen(false);
        return;
      }
      exitTelegramWorkspace();
      onChanged();
      onCancel();
    } catch {
      setConfirmDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  const label = profile?.botUsername ? `@${profile.botUsername}` : "Telegram";
  const boundLabel = bound
    ? [bound.name, bound.username ? `@${bound.username}` : undefined].filter(Boolean).join(" · ") ||
      t("tgSettingsBoundLabel")
    : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="telegram-settings-dialog-title"
        className="theme-floating-surface max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
      >
        {/* Header: title left, bridge switch right */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-md bg-accent/15 p-1.5 text-accent">
              <Bot size={18} />
            </div>
            <h2 id="telegram-settings-dialog-title" className="truncate text-base font-semibold">
              {t("tgSettingsTitle", { name: label })}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {(bridgeBusy || bridgeLoading) && (
              <LoaderCircle size={14} className="animate-spin text-muted" />
            )}
            <Switch
              checked={bridgeOn}
              onChange={toggleBridge}
              label={t("tgSettingsBridgeSwitch")}
            />
          </div>
        </div>

        {/* Token + bound account */}
        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("tgSettingsTokenTitle")}
          </h3>
          {tokenMasked && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <span className="shrink-0 text-[11px] text-muted">{t("tgSettingsTokenCurrent")}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{tokenMasked}</span>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setTokenPreview(null);
                setTokenSaved(false);
                setTokenError(null);
              }}
              placeholder={t("botAddTelegramTokenPlaceholder")}
              className="h-9 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
            <button
              type="button"
              onClick={() => void validateToken()}
              disabled={!token.trim() || validating || !host}
              className="interface-density-control inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            >
              {validating ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <span>{t("botAddTelegramValidate")}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void saveToken()}
              disabled={!tokenPreview || tokenSaving}
              className="interface-density-control inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            >
              {tokenSaving ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : (
                <span>{t("tgSettingsTokenSave")}</span>
              )}
            </button>
          </div>
          {tokenPreview && (
            <p className="mt-1.5 text-xs text-success">
              {t("tgSettingsTokenValidated", { bot: tokenPreview })}
            </p>
          )}
          {tokenSaved && <p className="mt-1.5 text-xs text-success">{t("tgSettingsTokenSaved")}</p>}
          {tokenError && <p className="mt-1.5 text-xs text-danger">{tokenError}</p>}

          {/* Bound account */}
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
            <span className="shrink-0 text-[11px] text-muted">{t("tgSettingsBoundTitle")}</span>
            {bound ? (
              <span className="min-w-0 flex-1 truncate text-xs">
                {boundLabel}（{t("tgSettingsBoundId", { id: bound.userId })}）
              </span>
            ) : (
              <span className="min-w-0 flex-1 text-xs text-muted">{t("tgSettingsBoundNone")}</span>
            )}
          </div>
        </section>

        {/* Plugin options */}
        <section className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("tgSettingsOptionsTitle")}
          </h3>
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptRendering")}</span>
              <Select
                value={rendering}
                onChange={setRendering}
                ariaLabel={t("tgOptRendering")}
                options={[
                  { value: "", label: t("tgOptDefault") },
                  { value: "rich", label: t("tgOptRich") },
                  { value: "html", label: t("tgOptHtml") },
                ]}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptRenderingHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptActivity")}</span>
              <Select
                value={activity}
                onChange={setActivity}
                ariaLabel={t("tgOptActivity")}
                options={[
                  { value: "", label: t("tgOptDefault") },
                  { value: "quiet", label: t("tgOptQuiet") },
                  { value: "thinking", label: t("tgOptThinking") },
                  { value: "tools", label: t("tgOptTools") },
                  { value: "verbose", label: t("tgOptVerbose") },
                ]}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptActivityHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptTimeInjection")}</span>
              <Select
                value={timeInjection}
                onChange={setTimeInjection}
                ariaLabel={t("tgOptTimeInjection")}
                options={[
                  { value: "", label: t("tgOptDefault") },
                  { value: "hidden", label: t("tgOptHiddenOption") },
                  { value: "always", label: t("tgOptAlways") },
                  { value: "interval", label: t("tgOptInterval") },
                ]}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptTimeInjectionHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptProactivePush")}</span>
              <Switch
                checked={proactivePush}
                onChange={setProactivePush}
                label={t("tgOptProactivePush")}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptProactivePushHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptReplyMode")}</span>
              <Select
                value={replyMode}
                onChange={setReplyMode}
                ariaLabel={t("tgOptReplyMode")}
                options={[
                  { value: "", label: t("tgOptDefault") },
                  { value: "manual", label: t("tgOptManual") },
                  { value: "hidden", label: t("tgOptHiddenOption") },
                  { value: "mirror", label: t("tgOptMirror") },
                  { value: "always", label: t("tgOptAlways") },
                ]}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptReplyModeHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground/80">{t("tgOptAutoCleanup")}</span>
              <Switch
                checked={automaticCleanup}
                onChange={setAutomaticCleanup}
                label={t("tgOptAutoCleanup")}
              />
            </div>
            <p className="-mt-1 text-[11px] text-muted">{t("tgOptAutoCleanupHint")}</p>
          </div>
          {configError && <p className="mt-2 text-xs text-danger">{configError}</p>}
          {configSaved && <p className="mt-2 text-xs text-success">{t("tgSettingsConfigSaved")}</p>}
        </section>

        {/* Footer: delete (left) + save options / close (right) */}
        <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setConfirmDeleteOpen(true)}
            className="interface-density-control inline-flex h-8 items-center gap-1.5 rounded-md bg-danger px-2.5 text-xs text-white hover:bg-danger/85"
          >
            <Trash2 size={13} />
            {t("tgSettingsDeleteButton")}
          </button>
          <div className="flex items-center gap-2">
            {configSaving && <LoaderCircle size={13} className="animate-spin text-muted" />}
            <button
              type="button"
              onClick={() => void saveConfig()}
              disabled={configSaving}
              className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("tgSettingsConfigSave")}
            </button>
            <button
              type="button"
              className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
              onClick={onCancel}
            >
              {t("commonClose")}
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDeleteOpen &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="telegram-delete-dialog-title"
              className="theme-floating-surface w-full max-w-md rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
            >
              <h3
                id="telegram-delete-dialog-title"
                className="flex items-center gap-2 text-base font-semibold text-danger"
              >
                <Trash2 size={16} />
                {t("tgSettingsDeleteTitle")}
              </h3>
              <p className="mt-2 text-sm text-muted">{t("tgSettingsDeleteBody")}</p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                  onClick={() => setConfirmDeleteOpen(false)}
                >
                  {t("commonCancel")}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => void deleteAll()}
                  className="interface-density-control inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-danger px-2.5 text-xs text-white hover:bg-danger/85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {deleting ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  {t("tgSettingsDeleteConfirmAction2")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>,
    document.body,
  );
}
