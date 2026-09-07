import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { DesktopInterfaceDensity, DesktopThemeFamily } from "@piabyss/protocol";
import { Minus, Plus } from "lucide-react";
import { Select } from "../../components/Select";
import {
  applyAppearancePreferences,
  MAX_CODE_FONT_SIZE,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
  resolveCodeFontSize,
  resolveConversationFontSize,
  resolveInterfaceDensity,
} from "../../lib/appearance-preferences";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  type DesktopSettingsUpdate,
} from "../../lib/desktop-settings";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { applyTheme } from "../../lib/theme";
import {
  HARD_MAX_CONVERSATION_WIDTH,
  HARD_MIN_CONVERSATION_WIDTH,
  resolveConversationMaxWidth,
  resolveConversationMinWidth,
} from "../chat/conversation-layout";

function FontSizeStepper({
  label,
  value,
  min,
  max,
  decreaseLabel,
  increaseLabel,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  decreaseLabel: string;
  increaseLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <div
      className="interface-density-control flex shrink-0 overflow-hidden rounded-md border border-border bg-surface"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        disabled={value <= min}
        title={decreaseLabel}
        aria-label={decreaseLabel}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={13} />
      </button>
      <output className="flex h-full min-w-14 items-center justify-center border-x border-border px-2 text-xs tabular-nums">
        {value}px
      </output>
      <button
        type="button"
        className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        disabled={value >= max}
        title={increaseLabel}
        aria-label={increaseLabel}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

export function AppearanceSettings() {
  const t = useT();
  const desktopSettings = useAppStore((state) => state.desktopSettings);
  const themeFamily = desktopSettings?.themeFamily ?? "piabyss";
  const interfaceDensity = resolveInterfaceDensity(desktopSettings?.interfaceDensity);
  const conversationMinWidth = resolveConversationMinWidth(desktopSettings?.conversationMinWidth);
  const conversationMaxWidth = resolveConversationMaxWidth(desktopSettings?.conversationMaxWidth);
  const conversationFontSize = resolveConversationFontSize(desktopSettings?.conversationFontSize);
  const [conversationMaxDraft, setConversationMaxDraft] = useState(String(conversationMaxWidth));
  const [conversationMinDraft, setConversationMinDraft] = useState(String(conversationMinWidth));

  useEffect(() => {
    setConversationMaxDraft(String(conversationMaxWidth));
    setConversationMinDraft(String(conversationMinWidth));
  }, [conversationMaxWidth, conversationMinWidth]);

  function commitConversationMax() {
    const parsed = Math.floor(Number(conversationMaxDraft));
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(
      HARD_MAX_CONVERSATION_WIDTH,
      Math.max(HARD_MIN_CONVERSATION_WIDTH, parsed),
    );
    setConversationMaxDraft(String(clamped));
    void patchDesktop({ conversationMaxWidth: clamped });
  }

  function commitConversationMin() {
    const parsed = Math.floor(Number(conversationMinDraft));
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(
      HARD_MAX_CONVERSATION_WIDTH,
      Math.max(HARD_MIN_CONVERSATION_WIDTH, parsed),
    );
    setConversationMinDraft(String(clamped));
    void patchDesktop({ conversationMinWidth: clamped });
  }
  const codeFontSize = resolveCodeFontSize(desktopSettings?.codeFontSize);

  async function patchDesktop(patch: DesktopSettingsUpdate) {
    try {
      await persistDesktopSettings(patch);
      const next = useAppStore.getState().desktopSettings;
      if (next) {
        if (patch.theme || patch.themeFamily) {
          applyTheme(next.theme, { family: next.themeFamily });
        }
        applyAppearancePreferences(next);
      }
      return true;
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
      return false;
    }
  }

  const densityOptions: Array<{
    value: DesktopInterfaceDensity;
    label: string;
  }> = [
    { value: "compact", label: t("appearanceDensityCompact") },
    { value: "standard", label: t("appearanceDensityStandard") },
    { value: "comfortable", label: t("appearanceDensityComfortable") },
  ];
  const themeFamilyOptions: Array<{
    value: DesktopThemeFamily;
    label: string;
  }> = [
    { value: "piabyss", label: t("appearanceThemePiAbyss") },
    { value: "vercel", label: t("appearanceThemeVercel") },
    { value: "apple", label: t("appearanceThemeApple") },
    { value: "transparent", label: t("appearanceThemeTransparent") },
  ];

  const previewStyle = {
    "--conversation-font-size": `${conversationFontSize}px`,
    "--code-font-size": `${codeFontSize}px`,
  } as CSSProperties;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <div className="interface-density-stack mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("appearanceInterfaceGroup")}</h2>
            <div className="interface-density-card flex flex-col gap-4 rounded-lg border border-border p-4">
              <div className="flex flex-col gap-3">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceThemeFamily")}</span>
                  <span className="block text-xs text-muted">{t("appearanceThemeFamilyDesc")}</span>
                </span>
                <div
                  data-ui="theme-family-selector"
                  className="grid grid-cols-3 gap-2"
                  role="group"
                  aria-label={t("appearanceThemeFamily")}
                >
                  {themeFamilyOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={themeFamily === option.value}
                      data-ui="theme-family-option"
                      data-state={themeFamily === option.value ? "active" : "inactive"}
                      className={`min-w-0 rounded-lg border p-1.5 text-xs transition-[border-color,background-color,box-shadow] ${
                        themeFamily === option.value
                          ? "border-focus bg-focus/10 font-medium text-foreground shadow-sm"
                          : "border-border bg-surface-raised text-muted hover:border-border-strong hover:bg-surface-overlay/45 hover:text-foreground"
                      }`}
                      onClick={() => void patchDesktop({ themeFamily: option.value })}
                    >
                      <span
                        className="theme-family-preview"
                        data-theme-preview={option.value}
                        aria-hidden="true"
                      >
                        <span className="theme-family-preview__sidebar">
                          <span className="theme-family-preview__nav" />
                        </span>
                        <span className="theme-family-preview__content">
                          <span className="theme-family-preview__toolbar" />
                          <span className="theme-family-preview__line theme-family-preview__line--wide" />
                          <span className="theme-family-preview__line" />
                          <span className="theme-family-preview__composer" />
                        </span>
                      </span>
                      <span className="mt-1.5 block truncate text-center">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceColorMode")}</span>
                  <span className="block text-xs text-muted">{t("appearanceColorModeDesc")}</span>
                </span>
                <Select
                  className="w-24"
                  ariaLabel={t("appearanceColorMode")}
                  value={desktopSettings?.theme ?? "system"}
                  onChange={(next) =>
                    void patchDesktop({ theme: next as "light" | "dark" | "system" })
                  }
                  options={[
                    { value: "system", label: t("commonSystem") },
                    { value: "light", label: t("generalThemeLight") },
                    { value: "dark", label: t("generalThemeDark") },
                  ]}
                />
              </label>

              <label className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalLanguage")}</span>
                  <span className="block text-xs text-muted">{t("generalLanguageDesc")}</span>
                </span>
                <Select
                  className="w-24"
                  ariaLabel={t("generalLanguage")}
                  value={desktopSettings?.language ?? "system"}
                  onChange={(next) =>
                    void patchDesktop({ language: next as "system" | "en" | "zh" })
                  }
                  options={[
                    { value: "system", label: t("commonSystem") },
                    { value: "en", label: "English" },
                    { value: "zh", label: "中文" },
                  ]}
                />
              </label>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceDensity")}</span>
                  <span className="block text-xs text-muted">{t("appearanceDensityDesc")}</span>
                </span>
                <div
                  data-ui="segmented"
                  className="interface-density-control grid shrink-0 grid-cols-3 overflow-hidden rounded-md border border-border bg-surface"
                  role="group"
                  aria-label={t("appearanceDensity")}
                >
                  {densityOptions.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={interfaceDensity === option.value}
                      data-ui="segmented-item"
                      data-state={interfaceDensity === option.value ? "active" : "inactive"}
                      className={`h-full min-w-16 px-2 text-xs transition-colors ${
                        index > 0 ? "border-l border-border" : ""
                      } ${
                        interfaceDensity === option.value
                          ? "bg-selection font-medium text-selection-foreground"
                          : "text-muted hover:bg-surface-overlay/70 hover:text-foreground"
                      }`}
                      onClick={() => void patchDesktop({ interfaceDensity: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">
              {t("appearanceConversationGroup")}
            </h2>
            <div className="interface-density-card flex flex-col gap-4 rounded-lg border border-border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <label htmlFor="conversation-max-width" className="block text-sm">
                    {t("generalConversationMaxWidth")}
                  </label>
                  <span
                    id="conversation-max-width-description"
                    className="block text-xs text-muted"
                  >
                    {t("generalConversationMaxWidthDesc", {
                      max: HARD_MAX_CONVERSATION_WIDTH,
                    })}
                  </span>
                </span>
                <span className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
                  <span
                    className="interface-density-control flex h-8 shrink-0 overflow-hidden rounded-md border border-border bg-surface"
                    role="group"
                    aria-label={t("generalConversationMaxWidth")}
                  >
                    <button
                      type="button"
                      className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                      title={t("appearanceDecrease", {
                        setting: t("generalConversationMaxWidth"),
                      })}
                      aria-label={t("appearanceDecrease", {
                        setting: t("generalConversationMaxWidth"),
                      })}
                      onClick={() =>
                        setConversationMaxDraft(
                          String(
                            Math.max(
                              HARD_MIN_CONVERSATION_WIDTH,
                              Math.floor(Number(conversationMaxDraft)) - 1,
                            ),
                          ),
                        )
                      }
                    >
                      <Minus size={13} />
                    </button>
                    <span className="flex h-full min-w-8 items-center gap-0.5 border-x border-border px-1.5 text-xs">
                      <input
                        id="conversation-max-width"
                        type="number"
                        min={HARD_MIN_CONVERSATION_WIDTH}
                        max={HARD_MAX_CONVERSATION_WIDTH}
                        step={1}
                        inputMode="numeric"
                        className="w-8 bg-transparent text-center text-xs tabular-nums text-foreground outline-none"
                        value={conversationMaxDraft}
                        aria-describedby="conversation-max-width-description"
                        onChange={(event) => setConversationMaxDraft(event.target.value)}
                        onBlur={commitConversationMax}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          commitConversationMax();
                        }}
                      />
                      <span className="shrink-0 text-muted">px</span>
                    </span>
                    <button
                      type="button"
                      className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                      title={t("appearanceIncrease", {
                        setting: t("generalConversationMaxWidth"),
                      })}
                      aria-label={t("appearanceIncrease", {
                        setting: t("generalConversationMaxWidth"),
                      })}
                      onClick={() =>
                        setConversationMaxDraft(
                          String(
                            Math.min(
                              HARD_MAX_CONVERSATION_WIDTH,
                              Math.floor(Number(conversationMaxDraft)) + 1,
                            ),
                          ),
                        )
                      }
                    >
                      <Plus size={13} />
                    </button>
                  </span>
                </span>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <label htmlFor="conversation-min-width" className="block text-sm">
                    {t("generalConversationMinWidth")}
                  </label>
                  <span
                    id="conversation-min-width-description"
                    className="block text-xs text-muted"
                  >
                    {t("generalConversationMinWidthDesc", {
                      min: HARD_MIN_CONVERSATION_WIDTH,
                    })}
                  </span>
                </span>
                <span className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
                  <span
                    className="interface-density-control flex h-8 shrink-0 overflow-hidden rounded-md border border-border bg-surface"
                    role="group"
                    aria-label={t("generalConversationMinWidth")}
                  >
                    <button
                      type="button"
                      className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                      title={t("appearanceDecrease", {
                        setting: t("generalConversationMinWidth"),
                      })}
                      aria-label={t("appearanceDecrease", {
                        setting: t("generalConversationMinWidth"),
                      })}
                      onClick={() =>
                        setConversationMinDraft(
                          String(
                            Math.max(
                              HARD_MIN_CONVERSATION_WIDTH,
                              Math.floor(Number(conversationMinDraft)) - 1,
                            ),
                          ),
                        )
                      }
                    >
                      <Minus size={13} />
                    </button>
                    <span className="flex h-full min-w-8 items-center gap-0.5 border-x border-border px-1.5 text-xs">
                      <input
                        id="conversation-min-width"
                        type="number"
                        min={HARD_MIN_CONVERSATION_WIDTH}
                        max={HARD_MAX_CONVERSATION_WIDTH}
                        step={1}
                        inputMode="numeric"
                        className="w-8 bg-transparent text-center text-xs tabular-nums text-foreground outline-none"
                        value={conversationMinDraft}
                        aria-describedby="conversation-min-width-description"
                        onChange={(event) => setConversationMinDraft(event.target.value)}
                        onBlur={commitConversationMin}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          commitConversationMin();
                        }}
                      />
                      <span className="shrink-0 text-muted">px</span>
                    </span>
                    <button
                      type="button"
                      className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                      title={t("appearanceIncrease", {
                        setting: t("generalConversationMinWidth"),
                      })}
                      aria-label={t("appearanceIncrease", {
                        setting: t("generalConversationMinWidth"),
                      })}
                      onClick={() =>
                        setConversationMinDraft(
                          String(
                            Math.min(
                              HARD_MAX_CONVERSATION_WIDTH,
                              Math.floor(Number(conversationMinDraft)) + 1,
                            ),
                          ),
                        )
                      }
                    >
                      <Plus size={13} />
                    </button>
                  </span>
                </span>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceConversationFontSize")}</span>
                  <span className="block text-xs text-muted">
                    {t("appearanceConversationFontSizeDesc")}
                  </span>
                </span>
                <FontSizeStepper
                  label={t("appearanceConversationFontSize")}
                  value={conversationFontSize}
                  min={MIN_CONVERSATION_FONT_SIZE}
                  max={MAX_CONVERSATION_FONT_SIZE}
                  decreaseLabel={t("appearanceDecrease", {
                    setting: t("appearanceConversationFontSize"),
                  })}
                  increaseLabel={t("appearanceIncrease", {
                    setting: t("appearanceConversationFontSize"),
                  })}
                  onChange={(value) => void patchDesktop({ conversationFontSize: value })}
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceCodeFontSize")}</span>
                  <span className="block text-xs text-muted">
                    {t("appearanceCodeFontSizeDesc")}
                  </span>
                </span>
                <FontSizeStepper
                  label={t("appearanceCodeFontSize")}
                  value={codeFontSize}
                  min={MIN_CODE_FONT_SIZE}
                  max={MAX_CODE_FONT_SIZE}
                  decreaseLabel={t("appearanceDecrease", {
                    setting: t("appearanceCodeFontSize"),
                  })}
                  increaseLabel={t("appearanceIncrease", {
                    setting: t("appearanceCodeFontSize"),
                  })}
                  onChange={(value) => void patchDesktop({ codeFontSize: value })}
                />
              </div>

              <div
                className="appearance-typography-preview border-t border-border pt-4"
                style={previewStyle}
              >
                <p className="mb-2 text-[11px] font-medium text-muted">{t("appearancePreview")}</p>
                <p className="appearance-preview-copy text-foreground">
                  {t("appearancePreviewText")} <code>const ready = true</code>
                </p>
                <pre className="theme-inset-surface mt-3 overflow-x-auto rounded-md bg-surface-overlay/70 p-3 text-foreground">
                  <code>{'const status = "ready";\nreturn status;'}</code>
                </pre>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
