import { useState } from "react";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { SettingsTopBarActions } from "./settings-top-bar";
import { resolveWindowControlsPlatform } from "../../components/WindowControls";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";
import { formatCommandChord } from "../../lib/commands/keymap";
import { appCommands, type AppCommand } from "../../lib/commands/registry";
import {
  captureShortcutChord,
  findShortcutConflict,
  hasShortcutOverride,
  resetShortcutOverride,
  resolveCommandChord,
  updateShortcutOverride,
  type ShortcutOverrides,
} from "../../lib/commands/shortcut-bindings";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";

type ShortcutError = {
  commandId: string;
  message: string;
};

const shortcutCommands = appCommands.filter((command) => command.chord);

export function ShortcutsSettings() {
  const t = useT();
  const shortcutOverrides = useAppStore((state) => state.desktopSettings?.shortcutOverrides);
  const isMac = resolveWindowControlsPlatform() === "macos";
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<ShortcutError | null>(null);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const hasAnyOverrides = Object.keys(shortcutOverrides ?? {}).length > 0;

  async function saveOverrides(next: ShortcutOverrides, savingTarget: string): Promise<void> {
    setSavingId(savingTarget);
    try {
      await persistDesktopSettings({ shortcutOverrides: next });
      setRecordingId(null);
      setError(null);
    } catch (saveError) {
      notifyDesktopSettingsSaveFailure(saveError);
    } finally {
      setSavingId(null);
    }
  }

  function beginRecording(commandId: string) {
    if (savingId) return;
    setRecordingId(commandId);
    setError(null);
  }

  function handleRecorderKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    command: AppCommand,
  ) {
    const capture = captureShortcutChord(event.nativeEvent, isMac);
    if (capture.kind === "passthrough") return;
    event.preventDefault();
    event.stopPropagation();

    if (capture.kind === "waiting") {
      setError(null);
      return;
    }
    if (capture.kind === "cancel") {
      setRecordingId(null);
      setError(null);
      return;
    }
    if (capture.kind === "clear") {
      void saveOverrides(updateShortcutOverride(shortcutOverrides, command, null), command.id);
      return;
    }
    if (capture.kind === "invalid") {
      setError({
        commandId: command.id,
        message:
          capture.reason === "modifier-required"
            ? t("shortcutsModifierRequired", { modifier: isMac ? "⌘" : "Ctrl" })
            : t("shortcutsUnsupported"),
      });
      return;
    }

    const conflict = findShortcutConflict(
      command.id,
      capture.chord,
      shortcutCommands,
      shortcutOverrides,
    );
    if (conflict) {
      setError({
        commandId: command.id,
        message: t("shortcutsConflict", {
          shortcut: formatCommandChord(capture.chord, isMac),
          command: t(conflict.titleKey, conflict.titleParams),
        }),
      });
      return;
    }
    void saveOverrides(
      updateShortcutOverride(shortcutOverrides, command, capture.chord),
      command.id,
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SettingsTopBarActions title={t("shortcutsTitle")} subtitle={t("shortcutsSubtitle")}>
        <button
          type="button"
          className={secondaryButton}
          disabled={!hasAnyOverrides || savingId !== null}
          onClick={() => setResetAllOpen(true)}
        >
          <RotateCcw size={13} />
          {t("shortcutsResetAll")}
        </button>
      </SettingsTopBarActions>
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <ul
          className="mx-auto max-w-2xl overflow-hidden rounded-lg border border-border"
          aria-label={t("shortcutsTitle")}
        >
          {shortcutCommands.map((command) => {
            const title = t(command.titleKey, command.titleParams);
            const chord = resolveCommandChord(command, shortcutOverrides);
            const recording = recordingId === command.id;
            const saving = savingId === command.id;
            const rowError = error?.commandId === command.id ? error.message : null;
            const errorId = `shortcut-error-${command.id}`;
            return (
              <li
                key={command.id}
                className="interface-density-list-row flex min-h-14 flex-col gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <span className="text-sm text-foreground">{title}</span>
                  {rowError && (
                    <p id={errorId} role="alert" className="mt-1 text-[11px] leading-4 text-danger">
                      {rowError}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
                  <button
                    type="button"
                    data-shortcut-recorder
                    aria-label={t("shortcutsRecord", { command: title })}
                    aria-pressed={recording}
                    aria-describedby={rowError ? errorId : undefined}
                    title={
                      recording
                        ? t("shortcutsRecordingHint")
                        : t("shortcutsRecord", { command: title })
                    }
                    disabled={savingId !== null}
                    className={`interface-density-control inline-flex h-8 min-w-28 items-center justify-center rounded-md border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 ${
                      recording
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-surface-overlay text-muted hover:text-foreground"
                    }`}
                    onClick={() => beginRecording(command.id)}
                    onKeyDown={(event) => handleRecorderKeyDown(event, command)}
                    onBlur={() => {
                      if (recordingId === command.id) setRecordingId(null);
                    }}
                  >
                    {saving ? (
                      <span className="inline-flex items-center gap-1.5">
                        <LoaderCircle size={12} className="animate-spin" />
                        {t("shortcutsSaving")}
                      </span>
                    ) : recording ? (
                      t("shortcutsRecording")
                    ) : chord ? (
                      <kbd className="font-mono text-[11px] leading-none">
                        {formatCommandChord(chord, isMac)}
                      </kbd>
                    ) : (
                      t("shortcutsUnassigned")
                    )}
                  </button>
                  <button
                    type="button"
                    title={t("shortcutsClear", { command: title })}
                    aria-label={t("shortcutsClear", { command: title })}
                    disabled={!chord || savingId !== null}
                    className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() =>
                      void saveOverrides(
                        updateShortcutOverride(shortcutOverrides, command, null),
                        command.id,
                      )
                    }
                  >
                    <X size={14} />
                  </button>
                  <button
                    type="button"
                    title={t("shortcutsReset", { command: title })}
                    aria-label={t("shortcutsReset", { command: title })}
                    disabled={
                      !hasShortcutOverride(shortcutOverrides, command.id) || savingId !== null
                    }
                    className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() =>
                      void saveOverrides(
                        resetShortcutOverride(shortcutOverrides, command.id),
                        command.id,
                      )
                    }
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {resetAllOpen && (
        <Dialog
          title={t("shortcutsResetAllTitle")}
          confirmLabel={t("shortcutsResetAllConfirm")}
          icon={RotateCcw}
          onCancel={() => setResetAllOpen(false)}
          onConfirm={() => {
            setResetAllOpen(false);
            void saveOverrides({}, "all");
          }}
        >
          <p>{t("shortcutsResetAllBody")}</p>
        </Dialog>
      )}
    </div>
  );
}
