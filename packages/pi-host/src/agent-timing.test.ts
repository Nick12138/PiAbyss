import { describe, expect, it } from "vitest";
import { AgentMessageTimingTracker } from "./agent-timing.js";

const session = {};

function messageStart(): unknown {
  return {
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: null },
  };
}

function delta(delta: string, type = "text_delta"): unknown {
  return { type: "message_update", assistantMessageEvent: { type, delta, contentIndex: 0 } };
}

function messageEnd(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: { output: 271 },
      ...overrides,
    },
  };
}

describe("AgentMessageTimingTracker", () => {
  it("measures first-token and decode timing from the raw event stream", () => {
    const tracker = new AgentMessageTimingTracker();
    expect(tracker.observe(session, "message_start", messageStart(), 1_000)).toBeNull();
    expect(
      tracker.observe(session, "message_update", { type: "message_update" }, 1_100),
    ).toBeNull();
    expect(tracker.observe(session, "message_update", delta("he"), 1_500)).toBeNull();
    const timing = tracker.observe(session, "message_end", messageEnd(), 2_500);
    expect(timing).toEqual({ firstTokenMs: 500, decodeMs: 1_000, outputTokens: 271 });
  });

  it("records the first non-empty delta chunk, ignoring empty ones", () => {
    const tracker = new AgentMessageTimingTracker();
    tracker.observe(session, "message_start", messageStart(), 1_000);
    tracker.observe(session, "message_update", delta(""), 1_200);
    tracker.observe(session, "message_update", delta("x"), 1_400);
    const timing = tracker.observe(session, "message_end", messageEnd(), 2_400);
    expect(timing).toMatchObject({ firstTokenMs: 400 });
  });

  it("counts thinking deltas as first token", () => {
    const tracker = new AgentMessageTimingTracker();
    tracker.observe(session, "message_start", messageStart(), 1_000);
    tracker.observe(session, "message_update", delta("…", "thinking_delta"), 1_300);
    const timing = tracker.observe(session, "message_end", messageEnd(), 2_300);
    expect(timing).toMatchObject({ firstTokenMs: 300 });
  });

  it("yields no decode timing when the message reports no output tokens", () => {
    const tracker = new AgentMessageTimingTracker();
    tracker.observe(session, "message_start", messageStart(), 1_000);
    tracker.observe(session, "message_update", delta("x"), 1_200);
    const timing = tracker.observe(
      session,
      "message_end",
      messageEnd({ usage: { output: 0 } }),
      2_200,
    );
    expect(timing).toEqual({ firstTokenMs: 200 });
  });

  it("skips aborted and failed messages", () => {
    const tracker = new AgentMessageTimingTracker();
    tracker.observe(session, "message_start", messageStart(), 1_000);
    tracker.observe(session, "message_update", delta("x"), 1_200);
    expect(
      tracker.observe(session, "message_end", messageEnd({ stopReason: "aborted" }), 2_000),
    ).toBeNull();
    // The consumed measurement is gone: a later end without a start yields null.
    expect(tracker.observe(session, "message_end", messageEnd(), 2_100)).toBeNull();
  });

  it("skips a message_end without a measured start", () => {
    const tracker = new AgentMessageTimingTracker();
    expect(tracker.observe(session, "message_end", messageEnd(), 1_000)).toBeNull();
  });

  it("restarts measurement on a new message_start", () => {
    const tracker = new AgentMessageTimingTracker();
    tracker.observe(session, "message_start", messageStart(), 1_000);
    tracker.observe(session, "message_update", delta("x"), 1_100);
    tracker.observe(session, "message_end", messageEnd(), 1_500);
    tracker.observe(session, "message_start", messageStart(), 2_000);
    tracker.observe(session, "message_update", delta("y"), 2_600);
    const timing = tracker.observe(session, "message_end", messageEnd(), 3_600);
    expect(timing).toEqual({ firstTokenMs: 600, decodeMs: 1_000, outputTokens: 271 });
  });
});
