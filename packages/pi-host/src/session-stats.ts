/**
 * Session statistics projection shared by the workspace session controller
 * (`session.getStats`) and the pixie runner (`pixie.rundown`).
 *
 * The mapping from the SDK's `SessionStats` to the wire `SessionStatsSnapshot`
 * must stay identical across both call sites — the desktop's `StatsPills`
 * reads the same shape — so it lives here instead of being duplicated.
 */
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { SessionStatsSnapshot } from "@piabyss/protocol";
import { MIN_DECODE_MS, TIMING_ENTRY_CUSTOM_TYPE } from "./agent-timing.js";

/** Timestamp of one session message entry for wall-time folding. Assistant
 * messages use the entry's persist timestamp (written at message_end, so it
 * marks the request's END — their own `message.timestamp` marks the request
 * START and would collapse every LLM window to the inter-step gap). All other
 * roles prefer the message's own epoch time (toolResult: tool completion),
 * falling back to the entry timestamp. */
function sessionEntryTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
  role: string,
): number | null {
  if (role !== "assistant") {
    const messageTime = message.timestamp;
    if (typeof messageTime === "number" && Number.isFinite(messageTime) && messageTime >= 0) {
      return messageTime;
    }
  }
  const entryTime = entry.timestamp;
  if (typeof entryTime === "string") {
    const parsed = Date.parse(entryTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Approximate wall-clock timings folded from persisted session entry
 * timestamps — the same entry stream `getSessionStats()` reads, so the two
 * stay consistent, and compaction-rewritten history is included the same way.
 *
 * Each assistant step's request wall time runs from the triggering message
 * entry (the user prompt or the preceding tool result) to the assistant
 * message's persist timestamp (message_end); each tool batch's wall time runs
 * from the assistant message carrying its calls to the appended tool result.
 * Only positive deltas count, so clock skew between entries contributes
 * nothing.
 *
 * First-token and decode timing ride the persisted `piabyss.timing` custom
 * entries the runtime cache writes when a message settles; only timings whose
 * assistant message is still on the branch fold in.
 */
export function deriveSessionTiming(entries: readonly unknown[]): {
  timing: {
    llmMs: number;
    toolMs: number;
    ttftMs?: number;
    ttftSteps?: number;
    decodeMs?: number;
    decodeTokens?: number;
  };
} {
  let llmMs = 0;
  let toolMs = 0;
  let prevRole: string | null = null;
  let prevTime: number | null = null;
  const assistantEntryIds = new Set<string>();
  const timingEntries: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "custom" && record.customType === TIMING_ENTRY_CUSTOM_TYPE) {
      if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
        timingEntries.push(record.data as Record<string, unknown>);
      }
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const messageRecord = message as Record<string, unknown>;
    const role = typeof messageRecord.role === "string" ? messageRecord.role : null;
    if (role === "assistant" && typeof record.id === "string") {
      assistantEntryIds.add(record.id);
    }
    const time = role ? sessionEntryTimestamp(record, messageRecord, role) : null;
    if (
      time !== null &&
      prevTime !== null &&
      time > prevTime &&
      ((role === "assistant" && (prevRole === "user" || prevRole === "toolResult")) ||
        (role === "toolResult" && prevRole === "assistant"))
    ) {
      const delta = time - prevTime;
      if (role === "assistant") llmMs += delta;
      else toolMs += delta;
    }
    prevRole = role;
    prevTime = time;
  }
  let ttftMs = 0;
  let ttftSteps = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  for (const data of timingEntries) {
    const messageEntryId = data.messageEntryId;
    if (typeof messageEntryId !== "string" || !assistantEntryIds.has(messageEntryId)) continue;
    const entryTtft = nonNegativeNumber(data.firstTokenMs);
    if (entryTtft !== null) {
      ttftMs += entryTtft;
      ttftSteps += 1;
    }
    const entryDecode = nonNegativeNumber(data.decodeMs);
    const entryOutput = nonNegativeNumber(data.outputTokens);
    // Legacy persisted entries can carry degenerate burst windows (the whole
    // message arrived in one chunk); a tokens-per-ms reading over them would
    // be fictional, so they stay out of the decode aggregates.
    if (
      entryDecode !== null &&
      entryDecode >= MIN_DECODE_MS &&
      entryOutput !== null &&
      entryOutput > 0
    ) {
      decodeMs += entryDecode;
      decodeTokens += entryOutput;
    }
  }
  return {
    timing: {
      llmMs,
      toolMs,
      ...(ttftSteps > 0 ? { ttftMs, ttftSteps } : {}),
      ...(decodeMs > 0 ? { decodeMs, decodeTokens } : {}),
    },
  };
}

/** Map the SDK `SessionStats` (plus the session's persisted entries) onto the
 * wire `SessionStatsSnapshot`. Shared by session.getStats and pixie.rundown. */
export function buildSessionStatsSnapshot(
  stats: SessionStats,
  entries: readonly unknown[],
): SessionStatsSnapshot {
  return {
    messageCount: stats.totalMessages,
    toolCallCount: stats.toolCalls,
    userMessageCount: stats.userMessages,
    assistantMessageCount: stats.assistantMessages,
    toolResultCount: stats.toolResults,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
    },
    ...deriveSessionTiming(entries),
    cost: stats.cost,
    ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}),
  };
}
