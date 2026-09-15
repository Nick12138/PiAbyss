/**
 * Live measurement of assistant-message timing from the raw agent event
 * stream — the same first-non-empty-delta rule the DSH session-stats fold
 * uses. The measurement rides the RAW (unserialized) agent events because the
 * serialized wire view drops the message fields timing needs.
 *
 * The tracker is pure: `observe` returns the timing to persist when a
 * message settles, or null. The caller owns persistence (a deferred custom
 * entry, see the runtime cache) and the aggregate fold (see
 * `deriveSessionTiming` in the session controller).
 */

/** customType of the session-file custom entries that carry measured timing. */
export const TIMING_ENTRY_CUSTOM_TYPE = "piabyss.timing";

/**
 * Decode windows below this are burst deliveries — the whole message arrived
 * in one chunk (non-streamed or fully buffered responses), so there is no
 * real streaming decode; a tokens-per-ms reading over such a window would be
 * fictional (hundreds of thousands of tok/s). Such messages keep their TTFT
 * but stay out of the decode aggregates.
 */
export const MIN_DECODE_MS = 50;

/** Timing payload persisted as a custom entry after one assistant message. */
export type PersistedMessageTiming = {
  /** LLM request start → first non-empty content delta. */
  firstTokenMs: number;
  /** first non-empty delta → message_end; present only with output tokens. */
  decodeMs?: number;
  /** provider output tokens for the message; rides `decodeMs`. */
  outputTokens?: number;
};

type MessageTimingState = {
  /** TTFT origin: the assistant message's own `timestamp` — set by pi-ai
   * before the HTTP request is issued (`stopReason:"pending"`). Falls back
   * to the message_start observation clock only when absent. */
  startedAt: number;
  firstTokenAt?: number;
};

function assistantMessageOf(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const message = (event as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  return record.role === "assistant" ? record : null;
}

/** First non-empty delta chunk — thinking deltas count: tokens are tokens. */
function firstDeltaOf(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const delta = (event as Record<string, unknown>).assistantMessageEvent;
  if (!delta || typeof delta !== "object") return null;
  const record = delta as Record<string, unknown>;
  if (
    record.type !== "text_delta" &&
    record.type !== "thinking_delta" &&
    record.type !== "toolcall_delta"
  ) {
    return null;
  }
  return typeof record.delta === "string" && record.delta.length > 0 ? record.delta : null;
}

/** Request-start epoch ms from an assistant message, when numeric. */
function requestStartOf(message: Record<string, unknown>): number | null {
  const timestamp = message.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class AgentMessageTimingTracker {
  private states = new WeakMap<object, MessageTimingState>();

  /**
   * Observe one raw agent event. Returns the timing to persist when an
   * assistant message settles with measured data, or null. Aborted, failed,
   * and never-streamed messages yield null — bad partial data must not enter
   * the aggregates.
   *
   * The TTFT origin is the request start (the message's own `timestamp`),
   * NOT the message_start observation: pi-ai emits message_start only after
   * the provider's response HEADERS arrive, and some providers (notably
   * openai-completions-compatible relays) hold the headers until the first
   * content chunk is ready — measuring from message_start reads ~0ms for the
   * entire request wait. The message timestamp carries the true start.
   *
   * @param session - owning AgentSession (identity only).
   * @param eventType - raw event type.
   * @param event - raw (unserialized) agent event.
   * @param now - observation clock, injectable for tests.
   * @returns timing to persist, or null.
   */
  observe(
    session: object,
    eventType: string,
    event: unknown,
    now: number = Date.now(),
  ): PersistedMessageTiming | null {
    if (eventType === "message_start") {
      const message = assistantMessageOf(event);
      if (message) {
        this.states.set(session, { startedAt: requestStartOf(message) ?? now });
      }
      return null;
    }
    if (eventType === "message_update") {
      const state = this.states.get(session);
      if (!state || state.firstTokenAt !== undefined) return null;
      const delta = firstDeltaOf(event);
      if (delta !== null) state.firstTokenAt = now;
      return null;
    }
    if (eventType !== "message_end") return null;
    const state = this.states.get(session);
    this.states.delete(session);
    if (!state || state.firstTokenAt === undefined) return null;
    const message = assistantMessageOf(event);
    if (!message) return null;
    // Aborted and failed messages keep their partial timing out of the
    // aggregates, mirroring DSH: cancelled steps count but are not timed.
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "aborted" || stopReason === "error") return null;
    // Prefer the message-carried request start; a message_end without a prior
    // message_start (mid-stream subscription) still measures from it.
    const startedAt = requestStartOf(message) ?? state.startedAt;
    // Clamp sub-ms negative rounding (a header-fast provider can observe the
    // first delta at/before the fallback clock) instead of dropping the step.
    const firstTokenMs = Math.max(0, state.firstTokenAt - startedAt);
    const usage = message.usage;
    const outputTokens =
      usage && typeof usage === "object"
        ? nonNegative((usage as Record<string, unknown>).output)
        : null;
    if (outputTokens === null || outputTokens <= 0) return { firstTokenMs };
    const decodeMs = nonNegative(now - state.firstTokenAt);
    if (decodeMs === null || decodeMs < MIN_DECODE_MS) return { firstTokenMs };
    return { firstTokenMs, decodeMs, outputTokens };
  }
}
