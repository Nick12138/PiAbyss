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

/** Timing payload persisted as a custom entry after one assistant message. */
export type PersistedMessageTiming = {
  /** message_start → first non-empty content delta. */
  firstTokenMs: number;
  /** first non-empty delta → message_end; present only with output tokens. */
  decodeMs?: number;
  /** provider output tokens for the message; rides `decodeMs`. */
  outputTokens?: number;
};

type MessageTimingState = {
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
      if (message) this.states.set(session, { startedAt: now });
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
    const firstTokenMs = nonNegative(state.firstTokenAt - state.startedAt);
    if (firstTokenMs === null) return null;
    const usage = message.usage;
    const outputTokens =
      usage && typeof usage === "object"
        ? nonNegative((usage as Record<string, unknown>).output)
        : null;
    if (outputTokens === null || outputTokens <= 0) return { firstTokenMs };
    const decodeMs = nonNegative(now - state.firstTokenAt);
    if (decodeMs === null) return { firstTokenMs };
    return { firstTokenMs, decodeMs, outputTokens };
  }
}
