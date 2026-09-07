import type { DesktopTheme, DesktopThemeFamily } from "@piabyss/protocol";

export type AppTheme = DesktopTheme;
export type AppThemeFamily = DesktopThemeFamily;
export type EffectiveTheme = Exclude<AppTheme, "system">;

export const STARTUP_THEME_STORAGE_KEY = "piabyss.theme";
export const STARTUP_THEME_FAMILY_STORAGE_KEY = "piabyss.theme-family";
const DEFAULT_THEME_FAMILY: AppThemeFamily = "piabyss";
const THEME_COLORS: Record<AppThemeFamily, Record<EffectiveTheme, string>> = {
  piabyss: { light: "#ffffff", dark: "#17171b" },
  vercel: { light: "#ffffff", dark: "#000000" },
  apple: { light: "#f5f5f7", dark: "#1c1c1e" },
  transparent: { light: "#f5f5f7", dark: "#1c1c1e" },
};

function syncNativeTheme(theme: AppTheme, effective: EffectiveTheme): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().setTheme(theme === "system" ? null : effective),
    )
    .catch(() => undefined);
}

export function resolveEffectiveTheme(
  theme: AppTheme,
  systemPrefersLight = typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches,
): EffectiveTheme {
  return theme === "system" ? (systemPrefersLight ? "light" : "dark") : theme;
}

export function readStoredTheme(): AppTheme | null {
  try {
    const value = window.localStorage.getItem(STARTUP_THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : null;
  } catch {
    return null;
  }
}

export function readStoredThemeFamily(): AppThemeFamily | null {
  try {
    const value = window.localStorage.getItem(STARTUP_THEME_FAMILY_STORAGE_KEY);
    if (value === "acrylic") return "apple";
    if (value === "pideck") return "piabyss"; // legacy family id
    return value === "piabyss" || value === "vercel" || value === "apple" || value === "transparent"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function applyTheme(
  theme: AppTheme,
  options: { family?: AppThemeFamily; persist?: boolean } = {},
): void {
  const { family = DEFAULT_THEME_FAMILY, persist = true } = options;
  const root = document.documentElement;
  const effective = resolveEffectiveTheme(theme);
  if (persist) {
    try {
      window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, theme);
      window.localStorage.setItem(STARTUP_THEME_FAMILY_STORAGE_KEY, family);
    } catch {
      // Hardened WebViews may disable local storage; native settings remain authoritative.
    }
  }
  root.classList.toggle("light", effective === "light");
  root.classList.toggle("dark", effective === "dark");
  root.dataset.theme = effective;
  root.dataset.themeFamily = family;
  syncNativeTheme(theme, effective);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[family][effective]);
}

export function applyStoredTheme(): void {
  applyTheme(readStoredTheme() ?? "system", {
    family: readStoredThemeFamily() ?? DEFAULT_THEME_FAMILY,
    persist: false,
  });
}
