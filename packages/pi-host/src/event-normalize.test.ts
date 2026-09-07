import { describe, expect, it } from "vitest";
import { normalizeAgentEvent } from "./event-normalize.js";

const reviewedFields = {
  agent_start: [],
  agent_end: ["messages", "willRetry"],
  turn_start: [],
  turn_end: ["message", "toolResults"],
  message_start: ["message"],
  message_update: ["assistantMessageEvent"],
  message_end: ["message"],
  tool_execution_start: ["toolCallId", "toolName", "args"],
  tool_execution_update: ["toolCallId", "toolName", "args", "partialResult"],
  tool_execution_end: ["toolCallId", "toolName", "result", "isError"],
  agent_settled: [],
  queue_update: ["steering", "followUp"],
  compaction_start: ["reason"],
  entry_appended: ["entry"],
  session_info_changed: ["name"],
  thinking_level_changed: ["level"],
  compaction_end: ["reason", "result", "aborted", "willRetry", "errorMessage"],
  auto_retry_start: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  auto_retry_end: ["success", "attempt", "finalError"],
  summarization_retry_scheduled: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  summarization_retry_attempt_start: ["source", "reason"],
  summarization_retry_finished: [],
  error: ["error", "message"],
} as const;

const representativeFields = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  willRetry: false,
  message: { role: "assistant", content: [], timestamp: 2 },
  toolResults: [{ role: "toolResult", content: [] }],
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
  toolCallId: "tool-1",
  toolName: "read",
  args: { path: "fixture.txt" },
  partialResult: {
    content: [{ type: "text", text: "partial" }],
    details: { progress: 1 },
    addedToolNames: ["fixture_tool", 7],
    terminate: false,
    unreviewed: "drop-me",
  },
  result: {
    content: [{ type: "text", text: "done" }],
    details: { completed: true },
    addedToolNames: ["fixture_tool", 7],
    terminate: true,
    unreviewed: "drop-me",
  },
  isError: false,
  steering: ["steer"],
  followUp: ["follow"],
  reason: "manual",
  source: "compaction",
  entry: { type: "session_info", id: "entry-1", parentId: null },
  name: "Fixture session",
  level: "high",
  aborted: false,
  errorMessage: "fixture error",
  attempt: 1,
  maxAttempts: 3,
  delayMs: 25,
  success: true,
  finalError: "final fixture error",
  error: "synthetic fixture error",
} as const;

describe("normalizeAgentEvent", () => {
  it.each(Object.entries(reviewedFields))(
    "allows only reviewed outer fields for %s",
    (type, fields) => {
      const out = normalizeAgentEvent({
        type,
        ...representativeFields,
        unreviewedOuterSecret: "must-not-cross-the-boundary",
      });

      expect(Object.keys(out).sort()).toEqual(["type", ...fields].sort());
      expect(out).not.toHaveProperty("unreviewedOuterSecret");
    },
  );

  it.each([null, undefined, 42, "agent_start", [], {}, { type: 42 }])(
    "uses a payload-free unknown policy for %j",
    (event) => {
      expect(normalizeAgentEvent(event)).toEqual({ type: "unknown" });
    },
  );

  it("does not forward an unknown event type or any unknown payload", () => {
    expect(
      normalizeAgentEvent({
        type: "future_sdk_event_with_sensitive_name",
        credential: "must-not-cross-the-boundary",
      }),
    ).toEqual({ type: "unknown" });
  });

  it("projects message updates without the cumulative message or partial snapshot", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(50_000) }],
    };
    const out = normalizeAgentEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
        partial: message,
      },
    });

    expect(out).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
    });
    expect(JSON.stringify(out).length).toBeLessThan(150);
  });

  it("extracts tool identity at start and the final structured call at end", () => {
    expect(
      normalizeAgentEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          partial: {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              { type: "toolCall", id: "call-1", name: "read", arguments: {} },
            ],
          },
        },
      }),
    ).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "call-1",
        name: "read",
      },
    });

    expect(
      normalizeAgentEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "README.md" },
          },
          partial: { role: "assistant", content: [] },
        },
      }),
    ).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      },
    });
  });

  it("fails closed for malformed or future Assistant message events", () => {
    expect(
      normalizeAgentEvent({
        type: "message_update",
        message: { role: "assistant", content: "must not cross" },
        assistantMessageEvent: { type: "future_delta", partial: {} },
      }),
    ).toEqual({ type: "unknown" });
  });

  it("keeps bash_execution_update unreviewed by decision, not by accident", () => {
    // 0.82.1 emits this only from AgentSession.executeBash, which PiAbyss never
    // calls; the transcript still shows the result via the bashExecution
    // session message. Wiring the delta stream is a deliberate future step.
    expect(
      normalizeAgentEvent({ type: "bash_execution_update", id: "b1", delta: "chunk" }),
    ).toEqual({ type: "unknown" });
  });

  it.each([
    ["tool_execution_update", "partialResult"],
    ["tool_execution_end", "result"],
  ] as const)("preserves only reviewed tool-result fields on %s", (type, field) => {
    const out = normalizeAgentEvent({ type, ...representativeFields });
    expect(out[field]).toEqual({
      content:
        field === "partialResult"
          ? [{ type: "text", text: "partial" }]
          : [{ type: "text", text: "done" }],
      details: field === "partialResult" ? { progress: 1 } : { completed: true },
      addedToolNames: ["fixture_tool"],
      terminate: field === "result",
    });
    expect(out[field]).not.toHaveProperty("unreviewed");
  });

  it("safe-serializes Error and functions inside reviewed details", () => {
    const out = normalizeAgentEvent({
      type: "tool_execution_end",
      result: {
        content: [],
        details: { err: new Error("x"), fn: () => 1 },
      },
    });
    const result = out.result as { details: { err: { message: string }; fn: string } };
    expect(result.details.err.message).toBe("x");
    expect(result.details.fn).toBe("[function]");
  });

  it("omits optional fields that are absent or undefined", () => {
    expect(normalizeAgentEvent({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual({
      type: "auto_retry_end",
      success: true,
      attempt: 2,
    });
    expect(normalizeAgentEvent({ type: "session_info_changed", name: undefined })).toEqual({
      type: "session_info_changed",
    });
  });
});
