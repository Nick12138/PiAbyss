/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STARTUP_THEME_FAMILY_STORAGE_KEY,
  STARTUP_THEME_STORAGE_KEY,
  applyStoredTheme,
  applyTheme,
  readStoredThemeFamily,
  readStoredTheme,
  resolveEffectiveTheme,
} from "./theme";

function mockSystemTheme(light: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: light }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-family");
  document.head.innerHTML = '<meta name="theme-color" content="#17171b">';
  mockSystemTheme(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme bootstrap", () => {
  it("resolves explicit themes independently from the system appearance", () => {
    expect(resolveEffectiveTheme("light", false)).toBe("light");
    expect(resolveEffectiveTheme("dark", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", true)).toBe("light");
    expect(resolveEffectiveTheme("system", false)).toBe("dark");
  });

  it("persists the preference and applies a strongly distinct document theme", () => {
    applyTheme("light");
    expect(window.localStorage.getItem(STARTUP_THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themeFamily).toBe("piabyss");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#ffffff",
    );

    applyTheme("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#17171b",
    );
  });

  it("applies and persists both Vercel color modes", () => {
    applyTheme("light", { family: "vercel" });
    expect(window.localStorage.getItem(STARTUP_THEME_FAMILY_STORAGE_KEY)).toBe("vercel");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.dataset.themeFamily).toBe("vercel");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#ffffff",
    );

    applyTheme("dark", { family: "vercel" });
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.dataset.themeFamily).toBe("vercel");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#000000",
    );
  });

  it("applies and persists both Apple color modes", () => {
    applyTheme("light", { family: "apple" });
    expect(window.localStorage.getItem(STARTUP_THEME_FAMILY_STORAGE_KEY)).toBe("apple");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#f5f5f7",
    );

    applyTheme("dark", { family: "apple" });
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#1c1c1e",
    );
  });

  it("accepts the transparent theme family", () => {
    applyTheme("dark", { family: "transparent" });
    expect(document.documentElement.dataset.themeFamily).toBe("transparent");
  });

  it("restores the mirrored preference before native settings are available", () => {
    window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, "light");
    window.localStorage.setItem(STARTUP_THEME_FAMILY_STORAGE_KEY, "vercel");
    applyStoredTheme();
    expect(readStoredTheme()).toBe("light");
    expect(readStoredThemeFamily()).toBe("vercel");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.dataset.themeFamily).toBe("vercel");

    window.localStorage.setItem(STARTUP_THEME_FAMILY_STORAGE_KEY, "apple");
    applyStoredTheme();
    expect(readStoredThemeFamily()).toBe("apple");
    expect(document.documentElement.dataset.themeFamily).toBe("apple");

    window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, "invalid");
    window.localStorage.setItem(STARTUP_THEME_FAMILY_STORAGE_KEY, "invalid");
    mockSystemTheme(false);
    applyStoredTheme();
    expect(readStoredTheme()).toBeNull();
    expect(readStoredThemeFamily()).toBeNull();
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.dataset.themeFamily).toBe("piabyss");
  });
});
