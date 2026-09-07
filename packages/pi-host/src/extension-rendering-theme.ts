import { Theme as ThemeClass, type Theme } from "@earendil-works/pi-coding-agent";

/** Minimal SDK Theme used when Extension components render for Desktop projection. */
export function createDesktopExtensionTheme(): Theme {
  const white = "#e0e0e0";
  const gray = "#808080";
  const cyan = "#00bcd4";
  const green = "#4caf50";
  const red = "#f44336";
  const yellow = "#ffeb3b";
  const magenta = "#e040fb";
  const blue = "#2196f3";
  const fg = {
    accent: cyan,
    border: gray,
    borderAccent: cyan,
    borderMuted: gray,
    success: green,
    error: red,
    warning: yellow,
    muted: gray,
    dim: gray,
    text: white,
    thinkingText: gray,
    userMessageText: white,
    customMessageText: white,
    customMessageLabel: cyan,
    toolTitle: white,
    toolOutput: white,
    mdHeading: white,
    mdLink: cyan,
    mdLinkUrl: cyan,
    mdCode: white,
    mdCodeBlock: white,
    mdCodeBlockBorder: gray,
    mdQuote: gray,
    mdQuoteBorder: gray,
    mdHr: gray,
    mdListBullet: white,
    toolDiffAdded: green,
    toolDiffRemoved: red,
    toolDiffContext: white,
    syntaxComment: gray,
    syntaxKeyword: magenta,
    syntaxFunction: blue,
    syntaxVariable: white,
    syntaxString: green,
    syntaxNumber: yellow,
    syntaxType: cyan,
    syntaxOperator: white,
    syntaxPunctuation: white,
    thinkingOff: gray,
    thinkingMinimal: gray,
    thinkingLow: gray,
    thinkingMedium: yellow,
    thinkingHigh: yellow,
    thinkingXhigh: red,
    thinkingMax: red,
    bashMode: green,
  } as const;
  const bg = {
    selectedBg: "#1565c0",
    userMessageBg: "#000000",
    customMessageBg: "#000000",
    toolPendingBg: "#000000",
    toolSuccessBg: "#000000",
    toolErrorBg: "#000000",
  } as const;
  return new ThemeClass(fg, bg, "256color", { name: "piabyss-stub" });
}
