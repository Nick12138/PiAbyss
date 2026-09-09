import type { CSSProperties } from "react";

export const DEFAULT_CONVERSATION_MIN_WIDTH = 350;
export const DEFAULT_CONVERSATION_MAX_WIDTH = 600;
export const HARD_MIN_CONVERSATION_WIDTH = 350;
export const HARD_MAX_CONVERSATION_WIDTH = 2400;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveConversationMinWidth(value: number | undefined): number {
  return clampInt(
    value,
    DEFAULT_CONVERSATION_MIN_WIDTH,
    HARD_MIN_CONVERSATION_WIDTH,
    HARD_MAX_CONVERSATION_WIDTH,
  );
}

export function resolveConversationMaxWidth(value: number | undefined): number {
  return clampInt(
    value,
    DEFAULT_CONVERSATION_MAX_WIDTH,
    DEFAULT_CONVERSATION_MIN_WIDTH,
    HARD_MAX_CONVERSATION_WIDTH,
  );
}

export function conversationContentWidthStyle(
  min: number | undefined,
  max: number | undefined,
): CSSProperties {
  const resolvedMin = resolveConversationMinWidth(min);
  const resolvedMax = Math.max(resolveConversationMaxWidth(max), resolvedMin);
  return {
    "--conversation-min-width": `${resolvedMin}px`,
    "--conversation-max-width": `${resolvedMax}px`,
  } as CSSProperties;
}
