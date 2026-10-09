import {
  DESKTOP_INTERFACE_DENSITIES,
  DESKTOP_INTERFACE_FONTS,
  type DesktopInterfaceDensity,
  type DesktopInterfaceFont,
  type DesktopSettings,
  type DesktopThemeFamily,
} from "@piabyss/protocol";

const DEFAULT_INTERFACE_DENSITY: DesktopInterfaceDensity = "standard";
const DEFAULT_CONVERSATION_FONT_SIZE = 15;
export const MIN_CONVERSATION_FONT_SIZE = 12;
export const MAX_CONVERSATION_FONT_SIZE = 18;
export const DEFAULT_CONVERSATION_LINE_HEIGHT = 1.7;
export const MIN_CONVERSATION_LINE_HEIGHT = 1;
export const MAX_CONVERSATION_LINE_HEIGHT = 2.5;
export const CONVERSATION_LINE_HEIGHT_STEP = 0.1;
const DEFAULT_CODE_FONT_SIZE = 12;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;

/** Selectable accent presets shown in Appearance → Interface. */
export const ACCENT_COLOR_PRESETS = [
  "#df6b35", // PiAbyss orange
  "#0068d9", // blue
  "#8b5cf6", // violet
  "#22c55e", // green
  "#14b8a6", // teal
  "#ec4899", // pink
  "#ef4444", // red
  "#f59e0b", // amber
] as const;

/** Extended swatch grid shown inside the custom accent picker popover. */
export const ACCENT_COLOR_PICKER_PALETTE: readonly string[] = [
  ...ACCENT_COLOR_PRESETS,
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // purple
  "#eab308", // yellow
  "#84cc16", // lime
  "#10b981", // emerald
  "#f97316", // orange
  "#64748b", // slate
];

/** Per-family accent a fresh install uses (for the "theme default" swatch preview). */
export const THEME_DEFAULT_ACCENTS: Record<DesktopThemeFamily, { light: string; dark: string }> = {
  piabyss: { light: "#d45d2d", dark: "#df6b35" },
  vercel: { light: "#1c1c1c", dark: "#ededed" },
  apple: { light: "#0068d9", dark: "#0068d9" },
  transparent: { light: "#0068d9", dark: "#0068d9" },
};

/** Type guard for the canonical stored form: lowercase `#rrggbb`. */
export function isAccentColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
}

/** Accepts `#rgb` / `#rrggbb` (any case) and returns canonical `#rrggbb`, or
 *  null when the value cannot be interpreted as an accent color. */
export function resolveAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const digits =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return `#${digits}`;
}

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** WCAG relative luminance of an sRGB hex color (0–1). */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function mixHex(hex: string, target: Rgb, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (channel: number, targetChannel: number) =>
    Math.round(channel + (targetChannel - channel) * amount);
  return `#${[mix(r, target.r), mix(g, target.g), mix(b, target.b)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Hover shade: accents darken like the built-in themes; very dark accents
 *  (e.g. Vercel's near-black light accent) lighten instead. */
function accentHoverColor(hex: string, luminance: number): string {
  return luminance <= 0.08
    ? mixHex(hex, { r: 255, g: 255, b: 255 }, 0.18)
    : mixHex(hex, { r: 0, g: 0, b: 0 }, 0.15);
}

/** Readable text on the accent: the built-in palettes keep white on everything
 *  but near-white accents, so the cutoff sits well above the WCAG crossover. */
function accentForegroundColor(luminance: number): string {
  return luminance > 0.4 ? "#17171b" : "#ffffff";
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function resolveInterfaceDensity(value: unknown): DesktopInterfaceDensity {
  return typeof value === "string" &&
    DESKTOP_INTERFACE_DENSITIES.includes(value as DesktopInterfaceDensity)
    ? (value as DesktopInterfaceDensity)
    : DEFAULT_INTERFACE_DENSITY;
}

export function resolveInterfaceFont(value: unknown): DesktopInterfaceFont | undefined {
  return typeof value === "string" &&
    DESKTOP_INTERFACE_FONTS.includes(value as DesktopInterfaceFont)
    ? (value as DesktopInterfaceFont)
    : undefined;
}

/** Stacks for each selectable interface font; "default" clears the override
 *  so the active theme's own stack applies. */
const INTERFACE_FONT_STACKS: Record<Exclude<DesktopInterfaceFont, "default">, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
};

function applyFontOverride(style: CSSStyleDeclaration, stack: string | null): void {
  if (stack === null) style.removeProperty("--font-sans");
  else style.setProperty("--font-sans", stack);
}

export function resolveConversationFontSize(value: unknown): number {
  return clampInteger(
    value,
    DEFAULT_CONVERSATION_FONT_SIZE,
    MIN_CONVERSATION_FONT_SIZE,
    MAX_CONVERSATION_FONT_SIZE,
  );
}

export function resolveCodeFontSize(value: unknown): number {
  return clampInteger(value, DEFAULT_CODE_FONT_SIZE, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
}

export function resolveConversationLineHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONVERSATION_LINE_HEIGHT;
  }
  const clamped = Math.min(
    MAX_CONVERSATION_LINE_HEIGHT,
    Math.max(MIN_CONVERSATION_LINE_HEIGHT, value),
  );
  return Number(
    (Math.round(clamped / CONVERSATION_LINE_HEIGHT_STEP) * CONVERSATION_LINE_HEIGHT_STEP).toFixed(
      1,
    ),
  );
}

export function applyAppearancePreferences(settings: DesktopSettings | null | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.interfaceDensity = resolveInterfaceDensity(settings?.interfaceDensity);
  const font = resolveInterfaceFont(settings?.interfaceFont);
  applyFontOverride(
    root.style,
    font === undefined || font === "default" ? null : INTERFACE_FONT_STACKS[font],
  );
  root.style.setProperty(
    "--conversation-font-size",
    `${resolveConversationFontSize(settings?.conversationFontSize)}px`,
  );
  root.style.setProperty(
    "--conversation-line-height",
    String(resolveConversationLineHeight(settings?.conversationLineHeight)),
  );
  root.style.setProperty("--code-font-size", `${resolveCodeFontSize(settings?.codeFontSize)}px`);
  const accent = resolveAccentColor(settings?.accentColor);
  if (accent) {
    const luminance = relativeLuminance(hexToRgb(accent));
    root.style.setProperty("--color-accent", accent);
    root.style.setProperty("--color-accent-hover", accentHoverColor(accent, luminance));
    root.style.setProperty("--color-accent-foreground", accentForegroundColor(luminance));
  } else {
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-hover");
    root.style.removeProperty("--color-accent-foreground");
  }
}
