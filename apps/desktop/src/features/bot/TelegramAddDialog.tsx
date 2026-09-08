import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Copy, Check, LoaderCircle } from "lucide-react";
import type { TelegramProfileSummary } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { userErrorMessage } from "../../lib/notify-operation-error";
import { editDraft } from "../../lib/draft-persistence";
import { draftTargetFor } from "../../lib/draft-target";
import { useT } from "../../lib/i18n/use-t";
import { useTelegramViewStore } from "../telegram/telegram-view-store";

/**
 * Add-telegram-bot dialog: validates the bot token via the host, then persists
 * the identity into the plugin's telegram.json (`telegram.saveProfile`) and
 * pre-fills `/telegram-connect` in the composer so the plugin starts polling.
 * The plugin owns config persistence and message transport; this dialog is the
 * UI hand-off into it.
 */
export function TelegramAddDialog({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const host = useAppStore((s) => s.host);

  const [token, setToken] = useState("");
  // Preview of the bot identity returned by getMe (auto-filled, read-only).
  const [preview, setPreview] = useState<{
    botId: number | null;
    username: string | null;
    firstName: string | null;
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !focusable().length) return;
      const items = focusable();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function validate(): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t("botAddTelegramTokenRequired"));
      return;
    }
    if (!host) {
      setError(t("notifHostUnavailable", { summary: "" }));
      return;
    }
    setValidating(true);
    setError(null);
    setPreview(null);
    try {
      const res = await hostClient.request(
        "telegram.validateToken",
        hostContext(host),
        { token: trimmed },
        20_000,
      );
      if (!res.ok) {
        setError(res.error.message || t("botAddTelegramValidateFailed"));
        return;
      }
      const result = res.result;
      if (!result.ok) {
        setError(result.description || t("botAddTelegramValidateFailed"));
        return;
      }
      setPreview({
        botId: result.botId ?? null,
        username: result.username ?? null,
        firstName: result.firstName ?? null,
      });
    } catch (err) {
      setError(userErrorMessage(err, t("botAddTelegramValidateFailed")));
    } finally {
      setValidating(false);
    }
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
    } catch {
      /* clipboard unavailable — the text is selectable in the UI */
    }
  }

  async function finish() {
    const hostNow = useAppStore.getState().host;
    if (!hostNow || !preview || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await hostClient.request(
        "telegram.saveProfile",
        hostContext(hostNow),
        {
          token: token.trim(),
          ...(preview.botId !== null ? { botId: preview.botId } : {}),
          ...(preview.username ? { botUsername: preview.username } : {}),
          ...(preview.firstName ? { botName: preview.firstName } : {}),
        },
        15_000,
      );
      if (!res.ok) {
        setError(res.error.message || t("botAddTelegramSaveFailed"));
        return;
      }
      const summary: TelegramProfileSummary = {
        profile: "default",
        configured: true,
        ...(preview.botId !== null ? { botId: preview.botId } : {}),
        ...(preview.username ? { botUsername: preview.username } : {}),
        ...(preview.firstName ? { botName: preview.firstName } : {}),
      };
      useTelegramViewStore.getState().applySavedProfile(summary);
      void useTelegramViewStore.getState().refreshTelegramSessions();
      // The add flow runs inside the dedicated telegram workspace, whose main
      // panel is the read-only history view (no composer). Start the bridge
      // programmatically instead of pre-filling a hidden draft; fall back to
      // the prefilled command only if the programmatic start is unavailable.
      const started = await useTelegramViewStore.getState().startTelegramBridge();
      if (!started) {
        const { workspace, session } = useAppStore.getState();
        const target = draftTargetFor(workspace, session);
        if (target) editDraft(target, "/telegram-connect");
      }
      onCancel();
    } catch (err) {
      setError(userErrorMessage(err, t("botAddTelegramSaveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="telegram-add-dialog-title"
          className="theme-floating-surface w-full max-w-lg overflow-auto rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md bg-accent/15 p-1.5 text-accent">
              <Bot size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="telegram-add-dialog-title" className="text-base font-semibold">
                {t("botAddTelegramTitle")}
              </h2>
              <p className="mt-1 text-xs text-muted">{t("botAddTelegramSubtitle")}</p>

              <form
                className="mt-4 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                }}
              >
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    {t("botAddTelegramTokenLabel")}
                  </span>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        setPreview(null);
                        setError(null);
                      }}
                      placeholder={t("botAddTelegramTokenPlaceholder")}
                      className="h-9 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    />
                    <button
                      type="button"
                      onClick={() => void validate()}
                      disabled={!token.trim() || validating || !host}
                      className="interface-density-control inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {validating ? (
                        <LoaderCircle size={14} className="animate-spin" />
                      ) : (
                        <span>{t("botAddTelegramValidate")}</span>
                      )}
                    </button>
                  </div>
                </label>

                {preview && (
                  <div className="flex flex-col gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm">
                    <div className="flex items-center gap-3">
                      <Bot size={14} className="shrink-0 text-success" />
                      <div className="min-w-0">
                        <span className="block font-medium text-foreground">
                          {preview.username
                            ? `@${preview.username}`
                            : t("botAddTelegramUnknownBot")}
                        </span>
                        {(preview.firstName || preview.username) && (
                          <span className="block truncate text-xs text-muted">
                            {preview.firstName ?? t("botAddTelegramUnknownName")}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted">{t("botAddTelegramGuidance")}</p>
                    {[{ command: "/telegram-connect", label: t("botAddTelegramConnectCmd") }].map(
                      ({ command, label }) => (
                        <div key={command} className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[11px]">
                            {command}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copyCommand(command)}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-1 text-[10px] hover:bg-surface-overlay"
                            aria-label={label}
                          >
                            {copied === command ? (
                              <Check size={11} className="text-success" />
                            ) : (
                              <Copy size={11} />
                            )}
                            <span>{copied === command ? t("commonCopied") : label}</span>
                          </button>
                        </div>
                      ),
                    )}
                  </div>
                )}

                {error && (
                  <p role="status" className="text-xs text-danger">
                    {error}
                  </p>
                )}

                <div className="mt-1 flex justify-end gap-2">
                  <button
                    type="button"
                    className="interface-density-control inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs hover:bg-surface-overlay"
                    onClick={onCancel}
                  >
                    {t("commonCancel")}
                  </button>
                  <button
                    type="button"
                    className="interface-density-control inline-flex h-8 items-center justify-center rounded-md bg-accent px-2.5 text-xs text-accent-foreground hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => void finish()}
                    disabled={!preview || saving}
                  >
                    {saving ? <LoaderCircle size={13} className="animate-spin" /> : t("commonDone")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    ) as ReactNode,
    document.body,
  );
}
