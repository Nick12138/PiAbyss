/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAppearancePreferences,
  resolveCodeFontSize,
  resolveConversationFontSize,
  resolveInterfaceDensity,
} from "./appearance-preferences";

afterEach(() => {
  document.documentElement.removeAttribute("data-interface-density");
  document.documentElement.style.removeProperty("--conversation-font-size");
  document.documentElement.style.removeProperty("--code-font-size");
});

describe("appearance preferences", () => {
  it("resolves missing and stale values to bounded defaults", () => {
    expect(resolveInterfaceDensity(undefined)).toBe("standard");
    expect(resolveInterfaceDensity("dense")).toBe("standard");
    expect(resolveConversationFontSize(undefined)).toBe(15);
    expect(resolveConversationFontSize(30)).toBe(18);
    expect(resolveCodeFontSize(4)).toBe(10);
  });

  it("publishes density and typography values on the document root", () => {
    applyAppearancePreferences({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
      interfaceDensity: "comfortable",
      conversationFontSize: 17,
      codeFontSize: 15,
    });

    expect(document.documentElement.dataset.interfaceDensity).toBe("comfortable");
    expect(document.documentElement.style.getPropertyValue("--conversation-font-size")).toBe(
      "17px",
    );
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("15px");
  });
});
