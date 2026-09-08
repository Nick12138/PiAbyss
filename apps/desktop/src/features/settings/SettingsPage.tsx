import { useEffect, useRef, useState, useContext } from "react";
import { useAppStore, type SettingsSection } from "../../lib/stores/app-store";
import {
  ChartColumn,
  Keyboard,
  KeyRound,
  Package,
  Palette,
  Puzzle,
  RefreshCw,
  ServerCog,
  Settings2,
  Wand2,
} from "lucide-react";
import type {
  BusySendBehavior,
  ExtensionDecisionPresentation,
  TerminalProfileId,
} from "@piabyss/protocol";
import { Dialog, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";
import type { MessageKey } from "../../lib/i18n";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  type DesktopSettingsUpdate,
} from "../../lib/desktop-settings";
import { HostSettings } from "./HostSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { SkillsSettings } from "../skills/SkillsSettings";
import { PackagesPage } from "../packages/PackagesPage";
import { PluginLibraryPage } from "../plugin-library/PluginLibraryPage";
import { UsageSettings } from "./UsageSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { PiSettings } from "./PiSettings";
import { RestartHostButton } from "./restart-host";
import { hostClient } from "../../lib/bridge/host-client";
import { SettingsTopBarActionsContext, SETTINGS_SECTION_META } from "./settings-top-bar";

type ShellProfileSummary = {
  id: TerminalProfileId;
  label: string;
  path: string;
};

type ShellProfileCatalog = {
  profiles: ShellProfileSummary[];
  automaticProfile: ShellProfileSummary;
};

function GeneralSettings() {
  const t = useT();
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [shellCatalog, setShellCatalog] = useState<ShellProfileCatalog | null>(null);
  const [shellCatalogLoading, setShellCatalogLoading] = useState(false);
  const [shellCatalogError, setShellCatalogError] = useState<string | null>(null);
  const [decisionPresentationSaving, setDecisionPresentationSaving] = useState(false);

  async function openSettingsFile() {
    if (!host?.agentDir) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path: `${host.agentDir}/settings.json` });
    } catch (err) {
      pushNotification(
        err instanceof Error ? err.message : t("notifSettingsFileOpenFailed"),
        "error",
      );
    }
  }

  async function loadShellProfiles() {
    setShellCatalogLoading(true);
    setShellCatalogError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setShellCatalog(await invoke<ShellProfileCatalog>("shell_terminal_profiles"));
    } catch (error) {
      setShellCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setShellCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadShellProfiles();
  }, []);

  async function patchDesktop(patch: DesktopSettingsUpdate) {
    try {
      await persistDesktopSettings(patch);
      return true;
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
      return false;
    }
  }

  async function patchExtensionDecisionPresentation(next: ExtensionDecisionPresentation) {
    const previous =
      useAppStore.getState().desktopSettings?.extensionDecisionPresentation ?? "auto";
    if (next === previous || decisionPresentationSaving) return;

    const hostAtStart = useAppStore.getState().host;
    let configuredHost = false;
    setDecisionPresentationSaving(true);
    try {
      if (hostAtStart) {
        const response = await hostClient.request(
          "extensionUi.configure",
          { expectedHostInstanceId: hostAtStart.hostInstanceId },
          { extensionDecisionPresentation: next },
        );
        if (!response.ok) throw new Error(response.error.message);
        configuredHost = true;
      }
      await persistDesktopSettings({ extensionDecisionPresentation: next });
    } catch (error) {
      const currentHost = useAppStore.getState().host;
      const currentHostId = currentHost?.hostInstanceId;
      if (configuredHost && currentHostId && currentHostId === hostAtStart?.hostInstanceId) {
        try {
          await hostClient.request(
            "extensionUi.configure",
            { expectedHostInstanceId: currentHostId },
            { extensionDecisionPresentation: previous },
          );
        } catch {
          // The next hello re-applies the persisted value after a Host epoch change.
        }
      }
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setDecisionPresentationSaving(false);
    }
  }

  const decisionPresentation = desktopSettings?.extensionDecisionPresentation ?? "auto";
  const decisionPresentationOptions: Array<{
    value: ExtensionDecisionPresentation;
    label: MessageKey;
    description: MessageKey;
  }> = [
    {
      value: "legacy-modal",
      label: "generalExtensionDecisionLegacy",
      description: "generalExtensionDecisionLegacyDesc",
    },
    {
      value: "auto",
      label: "generalExtensionDecisionAuto",
      description: "generalExtensionDecisionAutoDesc",
    },
    {
      value: "inline-first",
      label: "generalExtensionDecisionInlineFirst",
      description: "generalExtensionDecisionInlineFirstDesc",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">{t("generalStartupGroup")}</h2>
            <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalRestoreSession")}</span>
                  <span className="block text-xs text-muted">{t("generalRestoreSessionDesc")}</span>
                </span>
                <Switch
                  checked={desktopSettings?.restoreLastSession ?? true}
                  label={t("generalRestoreSession")}
                  onChange={(next) => void patchDesktop({ restoreLastSession: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalAutoStartOnBoot")}</span>
                  <span className="block text-xs text-muted">
                    {t("generalAutoStartOnBootDesc")}
                  </span>
                </span>
                <Switch
                  checked={desktopSettings?.autoStartOnBoot ?? false}
                  label={t("generalAutoStartOnBoot")}
                  onChange={(next) => void patchDesktop({ autoStartOnBoot: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalAutoRestart")}</span>
                  <span className="block text-xs text-muted">{t("generalAutoRestartDesc")}</span>
                </span>
                <Switch
                  checked={desktopSettings?.autoRestartHostOnce ?? true}
                  label={t("generalAutoRestart")}
                  onChange={(next) => void patchDesktop({ autoRestartHostOnce: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalSystemNotifications")}</span>
                  <span className="block text-xs text-muted">
                    {t("generalSystemNotificationsDesc")}
                  </span>
                </span>
                <Switch
                  checked={desktopSettings?.systemNotificationsEnabled ?? true}
                  label={t("generalSystemNotifications")}
                  onChange={(next) => void patchDesktop({ systemNotificationsEnabled: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="idle-session-cache-limit" className="min-w-0">
                  <span className="block text-sm">{t("generalIdleSessionCacheLimit")}</span>
                  <span className="block text-xs text-muted">
                    {t("generalIdleSessionCacheLimitDesc")}
                  </span>
                </label>
                <input
                  id="idle-session-cache-limit"
                  type="number"
                  min={1}
                  max={20}
                  value={desktopSettings?.idleSessionCacheLimit ?? 5}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1 && value <= 20) {
                      void patchDesktop({ idleSessionCacheLimit: value });
                    }
                  }}
                  className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-sm"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="idle-session-timeout" className="min-w-0">
                  <span className="block text-sm">{t("generalIdleSessionTimeout")}</span>
                  <span className="block text-xs text-muted">
                    {t("generalIdleSessionTimeoutDesc")}
                  </span>
                </label>
                <input
                  id="idle-session-timeout"
                  type="number"
                  min={1}
                  max={1440}
                  value={desktopSettings?.idleSessionTimeoutMinutes ?? 30}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1 && value <= 1440) {
                      void patchDesktop({ idleSessionTimeoutMinutes: value });
                    }
                  }}
                  className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-sm"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalSharedHostMode")}</span>
                  <span className="block text-xs text-muted">{t("generalSharedHostModeDesc")}</span>
                </span>
                <Switch
                  checked={desktopSettings?.sharedHostMode ?? true}
                  label={t("generalSharedHostMode")}
                  onChange={(next) => void patchDesktop({ sharedHostMode: next })}
                />
              </div>
            </div>
          </section>

          <PiSettings />

          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">{t("generalBusySendGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="busy-send-behavior" className="min-w-0 text-sm">
                  <span className="block">{t("generalBusySend")}</span>
                  <span id="busy-send-behavior-help" className="block text-xs text-muted">
                    {t("generalBusySendDesc")}
                  </span>
                </label>
                <Select
                  className="min-w-40"
                  ariaLabel={t("generalBusySend")}
                  value={desktopSettings?.busySendBehavior ?? "followUp"}
                  onChange={(value) =>
                    void patchDesktop({
                      busySendBehavior: value as BusySendBehavior,
                    })
                  }
                  options={[
                    { value: "followUp", label: t("generalBusySendFollowUp") },
                    { value: "steer", label: t("generalBusySendSteer") },
                  ]}
                />
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">
              {t("generalExtensionDecisionGroup")}
            </h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div>
                <p className="text-sm">{t("generalExtensionDecision")}</p>
                <p id="extension-decision-presentation-help" className="text-xs text-muted">
                  {t("generalExtensionDecisionDesc")}
                </p>
              </div>
              <fieldset
                data-ui="segmented"
                className="grid overflow-hidden rounded-md border border-border sm:grid-cols-3"
                aria-describedby="extension-decision-presentation-help"
                disabled={decisionPresentationSaving}
              >
                <legend className="sr-only">{t("generalExtensionDecision")}</legend>
                {decisionPresentationOptions.map((option, index) => {
                  const selected = decisionPresentation === option.value;
                  return (
                    <label
                      key={option.value}
                      data-ui="segmented-item"
                      data-state={selected ? "active" : "inactive"}
                      className={`relative flex min-h-20 flex-col gap-1 px-3 py-2.5 transition-colors ${
                        index > 0 ? "border-t border-border sm:border-l sm:border-t-0" : ""
                      } ${decisionPresentationSaving ? "cursor-wait opacity-60" : "cursor-pointer"} ${
                        selected
                          ? "bg-selection text-selection-foreground"
                          : "text-muted hover:bg-surface-overlay/60 hover:text-foreground"
                      }`}
                    >
                      <input
                        className="peer sr-only"
                        type="radio"
                        name="extension-decision-presentation"
                        value={option.value}
                        checked={selected}
                        onChange={() => void patchExtensionDecisionPresentation(option.value)}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-focus opacity-0 peer-focus-visible:opacity-100"
                      />
                      <span className="text-xs font-medium">{t(option.label)}</span>
                      <span className="text-[11px] leading-4 text-muted">
                        {t(option.description)}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <span className="sr-only" role="status" aria-live="polite">
                {decisionPresentationSaving ? t("generalExtensionDecisionSaving") : ""}
              </span>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">{t("generalTerminalGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-4">
                <label htmlFor="default-shell" className="min-w-0 text-sm">
                  <span className="block">{t("generalDefaultShell")}</span>
                  <span className="block text-xs text-muted">{t("generalDefaultShellDesc")}</span>
                </label>
                <div className="flex min-w-0 items-center gap-1.5">
                  <Select
                    className="min-w-44 max-w-72"
                    ariaLabel={t("generalDefaultShell")}
                    value={desktopSettings?.terminalProfile ?? "auto"}
                    disabled={shellCatalogLoading && !shellCatalog}
                    onChange={(next) =>
                      void patchDesktop({ terminalProfile: next as TerminalProfileId })
                    }
                    options={[
                      {
                        value: "auto",
                        label:
                          t("generalShellAutomatic") +
                          (shellCatalog ? ` (${shellCatalog.automaticProfile.label})` : ""),
                      },
                      ...(shellCatalog?.profiles.map((profile) => ({
                        value: profile.id,
                        label: profile.label,
                      })) ?? []),
                      ...(desktopSettings?.terminalProfile &&
                      desktopSettings.terminalProfile !== "auto" &&
                      !shellCatalog?.profiles.some(
                        (profile) => profile.id === desktopSettings.terminalProfile,
                      )
                        ? [
                            {
                              value: desktopSettings.terminalProfile,
                              label: t("generalShellUnavailable", {
                                id: desktopSettings.terminalProfile,
                              }),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <button
                    type="button"
                    title={t("generalDetectShells")}
                    aria-label={t("generalDetectShells")}
                    disabled={shellCatalogLoading}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                    onClick={() => void loadShellProfiles()}
                  >
                    <RefreshCw size={14} className={shellCatalogLoading ? "animate-spin" : ""} />
                  </button>
                </div>
              </div>
              {shellCatalogError && (
                <p role="status" className="text-xs text-warning">
                  {shellCatalogError}
                </p>
              )}
              {shellCatalog && (
                <p className="truncate text-right font-mono text-[11px] text-muted">
                  {desktopSettings?.terminalProfile === "auto" || !desktopSettings?.terminalProfile
                    ? shellCatalog.automaticProfile.path
                    : shellCatalog.profiles.find(
                        (profile) => profile.id === desktopSettings.terminalProfile,
                      )?.path}
                </p>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-medium text-muted">{t("generalAdvancedGroup")}</h2>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-sm text-muted">{t("generalAdvancedDesc")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={!host?.agentDir}
                  onClick={() => void openSettingsFile()}
                >
                  {t("generalAdvancedOpenFile")}
                </button>
                <RestartHostButton />
              </div>
              <p className="text-xs text-muted">{t("generalAdvancedRestartHint")}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export type { SettingsSection };

const SETTINGS_NAV: Array<{
  id: SettingsSection;
  label: MessageKey;
  icon: typeof Settings2;
}> = [
  { id: "general", label: "navGeneral", icon: Settings2 },
  { id: "appearance", label: "navAppearance", icon: Palette },
  { id: "providers", label: "navProviders", icon: KeyRound },
  { id: "skills", label: "navSkills", icon: Wand2 },
  { id: "plugins", label: "navPlugins", icon: Puzzle },
  { id: "packages", label: "navPackages", icon: Package },
  { id: "usage", label: "navUsage", icon: ChartColumn },
  { id: "host", label: "navHost", icon: ServerCog },
  { id: "shortcuts", label: "navShortcuts", icon: Keyboard },
];

export function SettingsPage({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose?: () => void;
}) {
  const t = useT();
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const outerTarget = useContext(SettingsTopBarActionsContext);
  const hasTopBar = outerTarget !== null;
  // When AppTopBar is absent (standalone render), a fallback header below renders
  // the title and an actions slot. inlineSlot is that slot once mounted, fed
  // back via the inner Provider so section components portal their action
  // buttons into it instead of rendering a duplicate inline header.
  const [inlineSlot, setInlineSlot] = useState<HTMLElement | null>(null);
  const innerTarget = hasTopBar ? outerTarget : inlineSlot;
  const [localSection, setLocalSection] = useState<SettingsSection>(initialSection);
  // Live mirrors for the scroll/persist handlers so they never read a stale
  // section after a nav click.
  const sectionRef = useRef(localSection);
  sectionRef.current = localSection;
  const scrollRef = useRef<Partial<Record<SettingsSection, number>>>({});
  const contentRef = useRef<HTMLElement | null>(null);
  const providersDirty = useAppStore((s) => s.providersDirty);
  const [pendingSection, setPendingSection] = useState<SettingsSection | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    setLocalSection(initialSection);
  }, [initialSection]);

  // Mirrors the active section into the store so the app-level AppTopBar can
  // read it. The App dispatches section switches back via setSettingsSection.
  useEffect(() => {
    setSettingsSection(localSection);
  }, [localSection, setSettingsSection]);

  // Remember where the user left off (section + per-section scroll offsets)
  // when Settings unmounts, so the next generic open restores it while the
  // cache stays fresh (SETTINGS_NAV_CACHE_TTL_MS, same workspace).
  // The cleanup runs at unmount and must snapshot the LATEST section/scroll
  // values — the one case where reading ref.current in a cleanup is the
  // intent, so the section/scroll refs are deliberately not deps.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    return () => {
      const workspaceId = useAppStore.getState().workspace?.id;
      if (!workspaceId) return;
      useAppStore.getState().setSettingsNavCache({
        workspaceId,
        section: sectionRef.current,
        scroll: { ...scrollRef.current },
        savedAt: Date.now(),
      });
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Restore the remembered scroll offset of the active section once its
  // content has laid out: on mount from the previous visit, on section switch
  // from the in-visit offset collected via the scroll listener below.
  useEffect(() => {
    const inVisit = scrollRef.current[localSection];
    const cached = useAppStore.getState().settingsNavCache?.scroll[localSection];
    const target = inVisit ?? cached;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const scrollEl = contentRef.current?.querySelector<HTMLElement>("[data-settings-scroll]");
      if (scrollEl) scrollEl.scrollTop = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [localSection]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      // Dialogs inside Settings consume their own Escape before it reaches window.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (useAppStore.getState().providersDirty) {
        setConfirmClose(true);
        return;
      }
      onClose?.();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function requestSection(next: SettingsSection) {
    if (next === localSection) return;
    if (providersDirty) {
      setPendingSection(next);
      return;
    }
    setLocalSection(next);
  }

  return (
    <SettingsTopBarActionsContext.Provider value={innerTarget}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface" data-settings-shell>
        {!hasTopBar && (
          <header
            className="flex min-h-16 shrink-0 items-center gap-3 px-6 pb-2 pt-3"
            data-settings-section-header
            data-tauri-drag-region
          >
            <div className="flex min-w-0 items-center gap-2">
              {(() => {
                const Icon = SETTINGS_SECTION_META[localSection].icon;
                return <Icon size={16} className="shrink-0 text-muted" aria-hidden />;
              })()}
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">
                  {t(SETTINGS_SECTION_META[localSection].title)}
                </h1>
                {SETTINGS_SECTION_META[localSection].subtitle && (
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {t(SETTINGS_SECTION_META[localSection].subtitle)}
                  </p>
                )}
              </div>
            </div>
            <div
              className="ml-auto flex shrink-0 items-center gap-2"
              data-settings-header-actions
              ref={setInlineSlot}
            />
          </header>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)]">
          <aside
            className="flex w-[150px] shrink-0 flex-col border-r border-border bg-surface"
            data-settings-sidebar
          >
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {SETTINGS_NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  data-ui="nav-item"
                  data-state={localSection === id ? "active" : "inactive"}
                  className={`theme-nav-item interface-density-nav-row mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors ${
                    localSection === id
                      ? "theme-nav-active bg-nav-active font-medium text-nav-active-foreground"
                      : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
                  }`}
                  aria-current={localSection === id ? "page" : undefined}
                  onClick={() => requestSection(id)}
                >
                  <Icon size={16} />
                  <span className="truncate">{t(label)}</span>
                </button>
              ))}
            </nav>
          </aside>

          <main
            className="flex min-h-0 min-w-0 flex-1"
            data-settings-content
            ref={contentRef}
            onScrollCapture={(event) => {
              // Scroll events do not bubble, but they do capture, so every
              // section's inner scroll container reaches this listener.
              scrollRef.current[sectionRef.current] = (event.target as HTMLElement).scrollTop;
            }}
          >
            {localSection === "general" ? (
              <GeneralSettings />
            ) : localSection === "appearance" ? (
              <AppearanceSettings />
            ) : localSection === "shortcuts" ? (
              <ShortcutsSettings />
            ) : localSection === "providers" ? (
              <ProvidersSettings />
            ) : localSection === "skills" ? (
              <SkillsSettings />
            ) : localSection === "packages" ? (
              <PackagesPage />
            ) : localSection === "plugins" ? (
              <PluginLibraryPage />
            ) : localSection === "host" ? (
              <HostSettings />
            ) : (
              <UsageSettings />
            )}
          </main>
          {pendingSection && (
            <Dialog
              title={t("settingsDiscardTitle")}
              confirmLabel={t("settingsDiscardConfirm")}
              tone="warning"
              onCancel={() => setPendingSection(null)}
              onConfirm={() => {
                setLocalSection(pendingSection);
                setPendingSection(null);
              }}
            >
              <p>{t("settingsDiscardNavBody")}</p>
            </Dialog>
          )}
          {confirmClose && onClose && (
            <Dialog
              title={t("settingsDiscardTitle")}
              confirmLabel={t("settingsDiscardConfirm")}
              tone="warning"
              onCancel={() => setConfirmClose(false)}
              onConfirm={() => {
                setConfirmClose(false);
                onClose();
              }}
            >
              <p>{t("settingsDiscardCloseBody")}</p>
            </Dialog>
          )}
        </div>
      </div>
    </SettingsTopBarActionsContext.Provider>
  );
}
