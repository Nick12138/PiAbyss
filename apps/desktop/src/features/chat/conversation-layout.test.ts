import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_MAX_WIDTH,
  DEFAULT_CONVERSATION_MIN_WIDTH,
  conversationContentWidthStyle,
  resolveConversationMaxWidth,
  resolveConversationMinWidth,
} from "./conversation-layout";

describe("conversation content width", () => {
  it("uses the defaults and clamps out-of-range min and max values", () => {
    expect(resolveConversationMinWidth(undefined)).toBe(DEFAULT_CONVERSATION_MIN_WIDTH);
    expect(resolveConversationMaxWidth(undefined)).toBe(DEFAULT_CONVERSATION_MAX_WIDTH);
    expect(resolveConversationMinWidth(100)).toBe(350);
    expect(resolveConversationMinWidth(640)).toBe(640);
    expect(resolveConversationMinWidth(3000)).toBe(2400);
    expect(resolveConversationMaxWidth(3000)).toBe(2400);
    expect(resolveConversationMaxWidth(920.9)).toBe(920);
  });

  it("keeps the max at least the min when resolving the shared style", () => {
    expect(conversationContentWidthStyle(900, 700)).toEqual({
      "--conversation-min-width": "900px",
      "--conversation-max-width": "900px",
    });
    expect(conversationContentWidthStyle(560, 1100)).toEqual({
      "--conversation-min-width": "560px",
      "--conversation-max-width": "1100px",
    });
  });
});
