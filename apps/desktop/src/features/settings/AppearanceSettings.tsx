import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DesktopInterfaceDensity,
  DesktopInterfaceFont,
  DesktopSettings,
  DesktopThemeFamily,
} from "@piabyss/protocol";
import { Minus, Pipette, Plus } from "lucide-react";
import { AccentColorWheel } from "./AccentColorWheel";
import { Select } from "../../components/Select";
import {
  ACCENT_COLOR_PICKER_PALETTE,
  ACCENT_COLOR_PRESETS,
  applyAppearancePreferences,
  CONVERSATION_LINE_HEIGHT_STEP,
  DEFAULT_CONVERSATION_LINE_HEIGHT,
  MAX_CODE_FONT_SIZE,
  MAX_CONVERSATION_FONT_SIZE,
  MAX_CONVERSATION_LINE_HEIGHT,
  MIN_CODE_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
  MIN_CONVERSATION_LINE_HEIGHT,
  resolveAccentColor,
  resolveCodeFontSize,
  resolveConversationFontSize,
  resolveConversationLineHeight,
  resolveInterfaceDensity,
  resolveInterfaceFont,
  THEME_DEFAULT_ACCENTS,
} from "../../lib/appearance-preferences";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
  type DesktopSettingsUpdate,
} from "../../lib/desktop-settings";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { applyTheme, resolveEffectiveTheme } from "../../lib/theme";
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
  step = 1,
  formatValue = (nextValue) => `${nextValue}px`,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue?: (value: number) => string;
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
        onClick={() => onChange(Number((value - step).toFixed(2)))}
      >
        <Minus size={13} />
      </button>
      <output className="flex h-full min-w-14 items-center justify-center border-x border-border px-2 text-xs tabular-nums">
        {formatValue(value)}
      </output>
      <button
        type="button"
        className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        disabled={value >= max}
        title={increaseLabel}
        aria-label={increaseLabel}
        onClick={() => onChange(Number((value + step).toFixed(2)))}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function ColorModePreview({ mode }: { mode: "light" | "dark" | "system" }) {
  const pane = (className: string) => (
    <span className={`color-mode-preview__pane ${className}`}>
      <span className="color-mode-preview__line color-mode-preview__line--wide" />
      <span className="color-mode-preview__line" />
      <span className="color-mode-preview__composer" />
    </span>
  );
  return (
    <span className="color-mode-preview" data-color-preview={mode} aria-hidden="true">
      {mode === "system" ? (
        <>
          {pane("color-mode-preview__pane--light")}
          {pane("color-mode-preview__pane--dark")}
        </>
      ) : (
        pane(mode === "dark" ? "color-mode-preview__pane--dark" : "color-mode-preview__pane--light")
      )}
    </span>
  );
}

const ACCENT_PICKER_PANEL_WIDTH = 192;
const ACCENT_PICKER_VIEWPORT_MARGIN = 8;
const ACCENT_PICKER_TRIGGER_GAP = 6;
const ACCENT_PICKER_PANEL_HEIGHT_FALLBACK = 320;

/** Custom accent color entry: a pipette swatch that opens an in-app popover
 *  (rounded floating surface) with a circular color wheel, an extended
 *  palette, and a hex input. The native <input type="color"> dialog is
 *  intentionally not used — its OS chrome cannot follow the app's rounded
 *  design language. */
function AccentCustomColorPicker({
  value,
  active,
  fallback,
  onApply,
}: {
  /** Current canonical accent, or null when the theme default applies. */
  value: string | null;
  /** True when the current accent is a non-preset (custom) color. */
  active: boolean;
  /** Color the wheel starts from when the theme default is active. */
  fallback: string;
  onApply: (hex: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [previewHex, setPreviewHexState] = useState<string | null>(null);
  const [hexDraft, setHexDraft] = useState(value ?? "");
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previewHexRef = useRef<string | null>(null);
  // Color shown while a wheel drag is in flight — falls back to the applied
  // value, then to the theme default so the wheel starts somewhere sensible.
  const effectiveHex = previewHex ?? value ?? fallback;
  const resolvedDraft = resolveAccentColor(hexDraft);
  const panelId = "accent-color-picker-panel";

  function setPreview(hex: string | null) {
    previewHexRef.current = hex;
    setPreviewHexState(hex);
  }

  // Keep the draft in sync with the shown color (palette clicks, resets,
  // and live wheel drags).
  useEffect(() => {
    setHexDraft(effectiveHex);
  }, [effectiveHex]);

  function closePopover() {
    // A wheel drag that was never committed (Escape, outside click, scroll)
    // is rolled back by re-applying the persisted settings.
    if (previewHexRef.current !== null) {
      setPreview(null);
      applyAppearancePreferences(useAppStore.getState().desktopSettings);
    }
    setOpen(false);
  }

  function handleWheelChange(hex: string, phase: "drag" | "commit") {
    if (phase === "drag") {
      // Live preview only: the accent CSS variables update in place and the
      // choice is persisted once the pointer is released.
      setPreview(hex);
      const settings = useAppStore.getState().desktopSettings;
      applyAppearancePreferences(
        settings ? { ...settings, accentColor: hex } : ({ accentColor: hex } as DesktopSettings),
      );
      return;
    }
    setPreview(null);
    onApply(hex);
  }

  // Dismiss like the app's other popovers: outside pointer-down, Escape
  // (returning focus to the trigger), and any scroll or resize.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closePopover();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePopover();
      triggerRef.current?.focus();
    };
    const close = () => closePopover();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closePopover reads live state via refs
  }, [open]);

  // Float the rounded popover below the trigger, or above it when the space
  // below is tight; clamp horizontally into the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(
        ACCENT_PICKER_PANEL_WIDTH,
        window.innerWidth - ACCENT_PICKER_VIEWPORT_MARGIN * 2,
      );
      const left = Math.min(
        Math.max(ACCENT_PICKER_VIEWPORT_MARGIN, rect.left),
        Math.max(
          ACCENT_PICKER_VIEWPORT_MARGIN,
          window.innerWidth - width - ACCENT_PICKER_VIEWPORT_MARGIN,
        ),
      );
      const below = rect.bottom + ACCENT_PICKER_TRIGGER_GAP;
      const panelHeight = panelRef.current?.offsetHeight ?? ACCENT_PICKER_PANEL_HEIGHT_FALLBACK;
      if (window.innerHeight - below >= panelHeight + ACCENT_PICKER_VIEWPORT_MARGIN) {
        setPanelStyle({ left, top: below, width });
      } else {
        setPanelStyle({
          left,
          bottom: window.innerHeight - rect.top + ACCENT_PICKER_TRIGGER_GAP,
          width,
        });
      }
    };
    updatePosition();
  }, [open]);

  // Focus the hex input once the popover has been positioned.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-ui="accent-color-custom"
      data-state={active || previewHex !== null ? "active" : "inactive"}
      title={t("appearanceAccentCustom")}
      aria-label={t("appearanceAccentCustom")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((previous) => !previous)}
      className={`relative inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border transition-[border-color,box-shadow,outline-color] ${
        active
          ? "border-focus outline outline-2 outline-offset-2 outline-focus"
          : "border-border hover:border-border-strong"
      }`}
    >
      <span
        className="absolute inset-0"
        style={{
          backgroundColor:
            previewHex ?? (active && value ? value : "var(--color-surface-overlay)"),
        }}
        aria-hidden="true"
      />
      <Pipette
        size={11}
        className={`relative ${active || previewHex ? "text-accent-foreground" : "text-muted"}`}
        aria-hidden="true"
      />
    </button>
  );

  const panel =
    open && panelStyle ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label={t("appearanceAccentPickerTitle")}
        data-ui="accent-color-picker"
        className="theme-floating-surface fixed z-50 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
        style={panelStyle}
      >
        <div className="flex min-h-8 items-center gap-2 border-b border-border px-3 py-1.5">
          <Pipette size={13} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {t("appearanceAccentPickerTitle")}
          </span>
          {effectiveHex && (
            <span className="shrink-0 font-mono text-[10px] uppercase text-muted">
              {effectiveHex}
            </span>
          )}
        </div>
        <div className="px-3 pt-3 pb-2">
          <AccentColorWheel
            value={effectiveHex}
            hueLabel={t("appearanceAccentHueLabel")}
            toneLabel={t("appearanceAccentToneLabel")}
            onChange={handleWheelChange}
          />
        </div>
        <div
          className="grid grid-cols-8 gap-1 px-3 pb-2"
          role="group"
          aria-label={t("appearanceAccentPaletteLabel")}
        >
          {ACCENT_COLOR_PICKER_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-pressed={effectiveHex === color}
              title={t("appearanceAccentOption", { value: color.toUpperCase() })}
              aria-label={t("appearanceAccentOption", { value: color.toUpperCase() })}
              data-ui="accent-color-picker-swatch"
              data-state={effectiveHex === color ? "active" : "inactive"}
              className={`h-4 w-4 rounded-md border transition-[border-color,box-shadow,outline-color] hover:border-border-strong ${
                effectiveHex === color
                  ? "border-focus outline outline-2 outline-offset-1 outline-focus"
                  : "border-border"
              }`}
              style={{ backgroundColor: color }}
              onClick={() => onApply(color)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span
            className="h-4 w-4 shrink-0 rounded-md border border-border"
            style={{ backgroundColor: resolvedDraft ?? "var(--color-surface-overlay)" }}
            aria-hidden="true"
          />
          <input
            type="text"
            spellCheck={false}
            maxLength={7}
            value={hexDraft}
            data-interface-height-auto="true"
            aria-label={t("appearanceAccentHexLabel")}
            placeholder="#RRGGBB"
            className="h-6 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus"
            onChange={(event) => setHexDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !resolvedDraft) return;
              event.preventDefault();
              onApply(resolvedDraft);
              closePopover();
              triggerRef.current?.focus();
            }}
          />
          <button
            type="button"
            disabled={!resolvedDraft}
            className="h-6 shrink-0 rounded-md border border-border px-1.5 text-xs text-foreground transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              if (!resolvedDraft) return;
              onApply(resolvedDraft);
              closePopover();
              triggerRef.current?.focus();
            }}
          >
            {t("appearanceAccentApply")}
          </button>
        </div>
        {hexDraft !== "" && !resolvedDraft && (
          <p className="border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-danger">
            {t("appearanceAccentInvalidHex")}
          </p>
        )}
      </div>
    ) : null;

  return (
    <>
      {trigger}
      {typeof document === "undefined" || !panel ? null : createPortal(panel, document.body)}
    </>
  );
}

export function AppearanceSettings() {
  const t = useT();
  const desktopSettings = useAppStore((state) => state.desktopSettings);
  const themeFamily = desktopSettings?.themeFamily ?? "piabyss";
  const themeMode = desktopSettings?.theme ?? "system";
  const interfaceDensity = resolveInterfaceDensity(desktopSettings?.interfaceDensity);
  const interfaceFont = resolveInterfaceFont(desktopSettings?.interfaceFont) ?? "default";
  const conversationMinWidth = resolveConversationMinWidth(desktopSettings?.conversationMinWidth);
  const conversationMaxWidth = resolveConversationMaxWidth(desktopSettings?.conversationMaxWidth);
  const conversationFontSize = resolveConversationFontSize(desktopSettings?.conversationFontSize);
  const conversationLineHeight = resolveConversationLineHeight(
    desktopSettings?.conversationLineHeight ?? DEFAULT_CONVERSATION_LINE_HEIGHT,
  );
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
  const accentColor = resolveAccentColor(desktopSettings?.accentColor);
  const isCustomAccent =
    accentColor !== null && !(ACCENT_COLOR_PRESETS as readonly string[]).includes(accentColor);
  const defaultAccentPreview = THEME_DEFAULT_ACCENTS[themeFamily][resolveEffectiveTheme(themeMode)];

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
  const colorModeOptions: Array<{
    value: "light" | "dark" | "system";
    label: string;
  }> = [
    { value: "system", label: t("commonSystem") },
    { value: "light", label: t("generalThemeLight") },
    { value: "dark", label: t("generalThemeDark") },
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
    "--conversation-line-height": String(conversationLineHeight),
    "--code-font-size": `${codeFontSize}px`,
  } as CSSProperties;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-6" data-settings-scroll>
        <div className="interface-density-stack mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted">{t("appearanceInterfaceGroup")}</h2>
            <div className="interface-density-card flex flex-col gap-4 rounded-lg border border-border p-4">
              <div className="flex flex-col gap-3">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceThemeFamily")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceThemeFamilyDesc")}
                  </span>
                </span>
                <div
                  data-ui="theme-family-selector"
                  className="grid grid-cols-2 gap-2 @min-[32rem]:grid-cols-4"
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

              <div className="flex flex-col gap-3">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceColorMode")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceColorModeDesc")}
                  </span>
                </span>
                <div
                  data-ui="color-mode-selector"
                  className="grid grid-cols-3 gap-2"
                  role="group"
                  aria-label={t("appearanceColorMode")}
                >
                  {colorModeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={themeMode === option.value}
                      data-ui="color-mode-option"
                      data-state={themeMode === option.value ? "active" : "inactive"}
                      className={`min-w-0 rounded-lg border p-1.5 text-xs transition-[border-color,background-color,box-shadow] ${
                        themeMode === option.value
                          ? "border-focus bg-focus/10 font-medium text-foreground shadow-sm"
                          : "border-border bg-surface-raised text-muted hover:border-border-strong hover:bg-surface-overlay/45 hover:text-foreground"
                      }`}
                      onClick={() => void patchDesktop({ theme: option.value })}
                    >
                      <ColorModePreview mode={option.value} />
                      <span className="mt-1.5 block truncate text-center">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceAccentColor")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceAccentColorDesc")}
                  </span>
                </span>
                <div
                  data-ui="accent-color-selector"
                  className="flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label={t("appearanceAccentColor")}
                >
                  <button
                    type="button"
                    aria-pressed={accentColor === null}
                    data-ui="accent-color-option"
                    data-value="default"
                    data-state={accentColor === null ? "active" : "inactive"}
                    title={t("appearanceAccentDefault")}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-xs transition-[border-color,background-color,box-shadow] ${
                      accentColor === null
                        ? "border-focus bg-focus/10 font-medium text-foreground shadow-sm"
                        : "border-border bg-surface-raised text-muted hover:border-border-strong hover:text-foreground"
                    }`}
                    onClick={() => void patchDesktop({ accentColor: null })}
                  >
                    <span
                      className="accent-chip-swatch"
                      style={{ backgroundColor: defaultAccentPreview }}
                      aria-hidden="true"
                    />
                    {t("appearanceAccentDefault")}
                  </button>
                  {ACCENT_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={accentColor === preset}
                      data-ui="accent-color-option"
                      data-value={preset}
                      data-state={accentColor === preset ? "active" : "inactive"}
                      title={t("appearanceAccentOption", { value: preset.toUpperCase() })}
                      aria-label={t("appearanceAccentOption", { value: preset.toUpperCase() })}
                      className={`h-6 w-6 rounded-full border transition-[border-color,box-shadow,outline-color] hover:border-border-strong ${
                        accentColor === preset
                          ? "border-focus outline outline-2 outline-offset-2 outline-focus"
                          : "border-border"
                      }`}
                      style={{ backgroundColor: preset }}
                      onClick={() => void patchDesktop({ accentColor: preset })}
                    />
                  ))}
                  <AccentCustomColorPicker
                    value={accentColor}
                    active={isCustomAccent}
                    fallback={defaultAccentPreview}
                    onApply={(hex) => void patchDesktop({ accentColor: hex })}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("generalLanguage")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("generalLanguageDesc")}
                  </span>
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
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceDensity")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceDensityDesc")}
                  </span>
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

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceFont")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceFontDesc")}
                  </span>
                </span>
                <Select
                  className="w-32"
                  ariaLabel={t("appearanceFont")}
                  value={interfaceFont}
                  onChange={(next) =>
                    void patchDesktop({ interfaceFont: next as DesktopInterfaceFont })
                  }
                  options={[
                    { value: "default", label: t("appearanceFontDefault") },
                    { value: "system", label: t("appearanceFontSystem") },
                  ]}
                />
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
                    className="mt-1 block text-xs leading-relaxed text-muted"
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
                    className="mt-1 block text-xs leading-relaxed text-muted"
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
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
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
                  <span className="block text-sm">{t("appearanceConversationLineHeight")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t("appearanceConversationLineHeightDesc")}
                  </span>
                </span>
                <FontSizeStepper
                  label={t("appearanceConversationLineHeight")}
                  value={conversationLineHeight}
                  min={MIN_CONVERSATION_LINE_HEIGHT}
                  max={MAX_CONVERSATION_LINE_HEIGHT}
                  step={CONVERSATION_LINE_HEIGHT_STEP}
                  formatValue={(value) =>
                    `${value.toFixed(1)}${t("appearanceConversationLineHeightUnit")}`
                  }
                  decreaseLabel={t("appearanceDecrease", {
                    setting: t("appearanceConversationLineHeight"),
                  })}
                  increaseLabel={t("appearanceIncrease", {
                    setting: t("appearanceConversationLineHeight"),
                  })}
                  onChange={(value) => void patchDesktop({ conversationLineHeight: value })}
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="block text-sm">{t("appearanceCodeFontSize")}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
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
