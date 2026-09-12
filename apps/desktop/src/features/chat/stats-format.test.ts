import { describe, expect, it } from "vitest";
import type { SerializableAgentMessage } from "@piabyss/protocol";
import {
  billedInputTokens,
  derivePillStats,
  formatCacheHitPercent,
  formatDuration,
  outputTokensPerSecond,
} from "./stats-format";

function usage(overrides: Partial<SerializableAgentMessage["usage"]> = {}) {
  return {
    input: 100,
    output: 50,
    cacheRead: 700,
    cacheWrite: 200,
    totalTokens: 1050,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function assistant(overrides: Partial<SerializableAgentMessage> = {}): SerializableAgentMessage {
  return { role: "assistant", content: [], ...overrides };
}

describe("formatDuration", () => {
  it("renders sub-minute durations with one decimal", () => {
    expect(formatDuration(45_200)).toBe("45.2s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("renders minutes+seconds from one minute on", () => {
    expect(formatDuration(162_000)).toBe("2m42s");
    expect(formatDuration(3_336_000)).toBe("55m36s");
  });
});

describe("formatCacheHitPercent", () => {
  it("returns null without prompt input", () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
  });

  it("returns 100 only for a full hit", () => {
    expect(formatCacheHitPercent(1000, 1000)).toBe("100");
  });

  it("rounds partial hits to integer percent", () => {
    expect(formatCacheHitPercent(92_00, 100_00)).toBe("92");
  });

  it("keeps a hit that would round to 100 honest", () => {
    expect(formatCacheHitPercent(9_999, 10_000)).toBe("99.99");
  });
});

describe("billedInputTokens", () => {
  it("sums the three disjoint prompt buckets", () => {
    expect(billedInputTokens({ input: 100, output: 50, cacheRead: 700, cacheWrite: 200 })).toBe(
      1000,
    );
  });
});

describe("outputTokensPerSecond", () => {
  it("returns null without a measured decode window", () => {
    expect(outputTokensPerSecond({ decodeMs: 0, decodeTokens: 500 })).toBeNull();
  });

  it("divides decode tokens by the decode wall time", () => {
    expect(outputTokensPerSecond({ decodeMs: 2_000, decodeTokens: 542 })).toBe(271);
  });
});

describe("derivePillStats", () => {
  it("counts turns only where an assistant follows a user prompt", () => {
    const messages = [
      { role: "user", content: "hi" },
      assistant(),
      // toolResult between assistants keeps the same turn.
      { role: "toolResult", content: [] },
      assistant(),
      { role: "user", content: "again" },
      assistant(),
    ] satisfies SerializableAgentMessage[];
    const stats = derivePillStats(messages);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
  });

  it("folds prompt-side usage across assistant messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      assistant({ usage: usage() }),
    ] satisfies SerializableAgentMessage[];
    const stats = derivePillStats(messages);
    expect(stats.usage).toEqual({ input: 100, output: 50, cacheRead: 700, cacheWrite: 200 });
  });

  it("derives live TTFT and decode speed only from measured turns", () => {
    const messages = [
      { role: "user", content: "hi" },
      assistant({
        startedAt: 1_000,
        firstTokenAt: 1_500,
        endedAt: 2_500,
        usage: usage({ output: 271 }),
      }),
      // A session-restored row without timing fields contributes nothing.
      assistant({ usage: usage() }),
    ] satisfies SerializableAgentMessage[];
    const stats = derivePillStats(messages);
    expect(stats.ttftSteps).toBe(1);
    expect(stats.ttftMs).toBe(500);
    expect(stats.decodeMs).toBe(1_000);
    expect(stats.decodeTokens).toBe(271);
    expect(outputTokensPerSecond(stats)).toBe(271);
  });
});
