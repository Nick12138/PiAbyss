import type { SerializableAgentMessage } from "@piabyss/protocol";

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/**
 * Display-ready cache-hit share of prompt-side input without rounding a
 * partial hit to 100%: a hit that would round to 100 automatically falls back
 * to enough decimal precision to stay honest.
 * @param cacheReadTokens - exact prompt tokens served from cache.
 * @param promptTokens - exact aggregate prompt tokens (uncached + cache read + cache write).
 * @returns percentage text, or null when there was no prompt input.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
): string | null {
  if (promptTokens <= 0) return null;
  const missed = promptTokens - cacheReadTokens;
  if (missed <= 0) return "100";
  for (const places of [0, 1, 2, 3, 4]) {
    const scale = 10 ** places;
    const rounded = Math.round((cacheReadTokens / promptTokens) * 100 * scale) / scale;
    if (rounded < 100) return places === 0 ? String(rounded) : rounded.toFixed(places);
  }
  return "99.99999";
}

/** Display-side prompt usage folded from the visible session messages. */
export type FoldedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Desktop-local live-timing fields stamped onto assistant messages by the
 * transcript reducer; only genuinely streamed turns carry them. */
type AssistantTiming = {
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
};

/** Counts and live timings derived from the visible session messages —
 * the same口径 the stats pills show before any dialog is opened. */
export type PillStats = {
  /** Assistant messages that directly follow a user prompt (or open the view). */
  turns: number;
  /** Assistant messages — one LLM request each. */
  steps: number;
  /** Summed first-delta latency over live-measured steps (ms). */
  ttftMs: number;
  /** Live-measured steps carrying a first-delta timestamp. */
  ttftSteps: number;
  /** Summed decode wall time over live-measured steps that also report output tokens. */
  decodeMs: number;
  /** Summed output tokens over the same live-measured steps. */
  decodeTokens: number;
  usage: FoldedUsage;
};

function numeric(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function addUsage(target: FoldedUsage, usage: SerializableAgentMessage["usage"]): void {
  if (!usage || typeof usage !== "object") return;
  target.input += typeof usage.input === "number" ? usage.input : 0;
  target.output += typeof usage.output === "number" ? usage.output : 0;
  target.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  target.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
}

/**
 * Fold assistant messages into display counts, live timings, and prompt-side
 * usage totals. The window is the visible conversation history, so figures
 * may trail the durable whole-session log; the dialogs fetch
 * `session.getStats` for the authoritative whole-history numbers.
 * @param messages - session snapshot messages.
 * @returns counts, live timings, and folded usage.
 */
export function derivePillStats(messages: readonly SerializableAgentMessage[]): PillStats {
  const stats: PillStats = {
    turns: 0,
    steps: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    stats.steps += 1;
    const previous = messages[index - 1];
    if (index === 0 || previous?.role === "user") stats.turns += 1;
    addUsage(stats.usage, message.usage);
    const timing = message as SerializableAgentMessage & AssistantTiming;
    const startedAt = numeric(timing, "startedAt");
    const firstTokenAt = numeric(timing, "firstTokenAt");
    const endedAt = numeric(timing, "endedAt");
    if (startedAt !== undefined && firstTokenAt !== undefined && firstTokenAt > startedAt) {
      stats.ttftMs += firstTokenAt - startedAt;
      stats.ttftSteps += 1;
    }
    if (
      firstTokenAt !== undefined &&
      endedAt !== undefined &&
      endedAt > firstTokenAt &&
      typeof message.usage?.output === "number" &&
      message.usage.output > 0
    ) {
      stats.decodeMs += endedAt - firstTokenAt;
      stats.decodeTokens += message.usage.output;
    }
  }
  return stats;
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - folded or host-reported usage.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: FoldedUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Output tokens per second over the live-measured decode windows.
 * @param stats - folded pill stats.
 * @returns the speed, or null when no step carries a measured decode window.
 */
export function outputTokensPerSecond(
  stats: Pick<PillStats, "decodeMs" | "decodeTokens">,
): number | null {
  if (stats.decodeMs <= 0) return null;
  return stats.decodeTokens / (stats.decodeMs / 1_000);
}
