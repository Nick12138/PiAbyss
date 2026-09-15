import {
  DESKTOP_INTERFACE_DENSITIES,
  DESKTOP_INTERFACE_FONTS,
  type DesktopInterfaceDensity,
  type DesktopInterfaceFont,
  type DesktopSettings,
} from "@piabyss/protocol";

const DEFAULT_INTERFACE_DENSITY: DesktopInterfaceDensity = "standard";
const DEFAULT_CONVERSATION_FONT_SIZE = 15;
export const MIN_CONVERSATION_FONT_SIZE = 12;
export const MAX_CONVERSATION_FONT_SIZE = 18;
const DEFAULT_CODE_FONT_SIZE = 12;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;

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
  root.style.setProperty("--code-font-size", `${resolveCodeFontSize(settings?.codeFontSize)}px`);
}
