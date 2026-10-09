/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCENT_COLOR_PICKER_PALETTE,
  ACCENT_COLOR_PRESETS,
  applyAppearancePreferences,
  isAccentColor,
  resolveAccentColor,
  resolveCodeFontSize,
  resolveConversationFontSize,
  resolveConversationLineHeight,
  resolveInterfaceDensity,
  THEME_DEFAULT_ACCENTS,
} from "./appearance-preferences";

afterEach(() => {
  document.documentElement.removeAttribute("data-interface-density");
  document.documentElement.style.removeProperty("--conversation-font-size");
  document.documentElement.style.removeProperty("--conversation-line-height");
  document.documentElement.style.removeProperty("--code-font-size");
  document.documentElement.style.removeProperty("--color-accent");
  document.documentElement.style.removeProperty("--color-accent-hover");
  document.documentElement.style.removeProperty("--color-accent-foreground");
});

describe("appearance preferences", () => {
  it("resolves missing and stale values to bounded defaults", () => {
    expect(resolveInterfaceDensity(undefined)).toBe("standard");
    expect(resolveInterfaceDensity("dense")).toBe("standard");
    expect(resolveConversationFontSize(undefined)).toBe(15);
    expect(resolveConversationFontSize(30)).toBe(18);
    expect(resolveConversationLineHeight(undefined)).toBe(1.7);
    expect(resolveConversationLineHeight(0.5)).toBe(1);
    expect(resolveConversationLineHeight(2.6)).toBe(2.5);
    expect(resolveCodeFontSize(4)).toBe(10);
  });

  it("normalizes accent colors and rejects anything unparsable", () => {
    expect(resolveAccentColor("#8b5cf6")).toBe("#8b5cf6");
    expect(resolveAccentColor("#8B5CF6")).toBe("#8b5cf6");
    expect(resolveAccentColor(" #F5A ")).toBe("#ff55aa");
    expect(resolveAccentColor(undefined)).toBeNull();
    expect(resolveAccentColor(null)).toBeNull();
    expect(resolveAccentColor("red")).toBeNull();
    expect(resolveAccentColor("#ff55a")).toBeNull();
    expect(resolveAccentColor("ff55aa")).toBeNull();
    // Presets and theme defaults must already be canonical.
    for (const preset of ACCENT_COLOR_PRESETS) {
      expect(resolveAccentColor(preset)).toBe(preset);
    }
    for (const family of Object.values(THEME_DEFAULT_ACCENTS)) {
      expect(resolveAccentColor(family.light)).toBe(family.light);
      expect(resolveAccentColor(family.dark)).toBe(family.dark);
    }
  });

  it("keeps the custom picker palette canonical and a preset superset", () => {
    expect(ACCENT_COLOR_PICKER_PALETTE).toHaveLength(16);
    for (const color of ACCENT_COLOR_PICKER_PALETTE) {
      expect(isAccentColor(color), color).toBe(true);
      expect(resolveAccentColor(color)).toBe(color);
    }
    for (const preset of ACCENT_COLOR_PRESETS) {
      expect(ACCENT_COLOR_PICKER_PALETTE).toContain(preset);
    }
  });

  it("publishes density and typography values on the document root", () => {
    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      interfaceDensity: "comfortable",
      conversationFontSize: 17,
      conversationLineHeight: 1.8,
      codeFontSize: 15,
    });

    expect(document.documentElement.dataset.interfaceDensity).toBe("comfortable");
    expect(document.documentElement.style.getPropertyValue("--conversation-font-size")).toBe(
      "17px",
    );
    expect(document.documentElement.style.getPropertyValue("--conversation-line-height")).toBe(
      "1.8",
    );
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("15px");
  });

  it("overrides the accent palette with readable derived shades", () => {
    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      accentColor: "#8b5cf6",
    });

    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#8b5cf6");
    // Mid-tone accents darken on hover and keep white text.
    expect(document.documentElement.style.getPropertyValue("--color-accent-hover")).toBe("#764ed1");
    expect(document.documentElement.style.getPropertyValue("--color-accent-foreground")).toBe(
      "#ffffff",
    );

    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      accentColor: "#ededed",
    });

    // Near-white accents flip to dark text and still darken on hover.
    expect(document.documentElement.style.getPropertyValue("--color-accent-hover")).toBe("#c9c9c9");
    expect(document.documentElement.style.getPropertyValue("--color-accent-foreground")).toBe(
      "#17171b",
    );

    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      accentColor: "#1c1c1c",
    });

    // Very dark accents lighten on hover.
    expect(document.documentElement.style.getPropertyValue("--color-accent-hover")).toBe("#454545");
  });

  it("falls back to the theme accent when the override is absent or stale", () => {
    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      accentColor: "#8b5cf6",
    });

    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      accentColor: "not-a-color",
    });

    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--color-accent-hover")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--color-accent-foreground")).toBe("");
  });
});
