import { describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  applyAgentEventBatch,
  coalesceAgentEventBatch,
  matchesTimedAgentEventIdentity,
  type AgentEventEnvelope,
  type TimedAgentEventEnvelope,
} from "./transcript-reducer.js";
import type { SerializableAssistantMessageEvent, SessionSnapshot } from "@piabyss/protocol";
import { buildAttachmentReferenceBlock } from "@piabyss/protocol";

function baseSession(): SessionSnapshot {
  return {
    sessionId: "s1",
    cwd: "/tmp",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "medium",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "w1",
      sessionId: "s1",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("applyAgentEvent", () => {
  it("opens a new assistant row for deltas from a run whose message_start is missing", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_start" },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "message_start", message: { role: "assistant", content: "" } },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Old answer" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Old answer" }] },
      },
    })!;

    // A new run whose turn prefix never arrived: its streamed text must not
    // be glued onto the previous assistant row.
    s = applyAgentEvent(s, {
      runId: "r2",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "New answer" },
      },
    })!;

    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.content).toEqual([{ type: "text", text: "Old answer" }]);
    expect(assistants[1]?.content).toEqual([{ type: "text", text: "New answer" }]);
  });

  it("appends a cross-run message_end instead of overwriting the previous assistant row", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "message_start", message: { role: "assistant", content: "" } },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      },
    })!;

    s = applyAgentEvent(s, {
      runId: "r2",
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
      },
    })!;

    const assistants = s.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.content).toEqual([{ type: "text", text: "Done" }]);
    expect(assistants[1]?.content).toEqual([{ type: "text", text: "Recovered" }]);
  });

  it("settles the previous assistant before a new run starts", () => {
    const session = baseSession();
    session.messages = [
      { role: "assistant", content: [{ type: "text", text: "Previous answer" }] },
    ];

    const next = applyAgentEvent(
      session,
      { runId: "next-run", event: { type: "agent_start" } },
      250,
    )!;

    expect(next.messages[0]).toMatchObject({ endedAt: 250 });
    expect(next.isStreaming).toBe(true);
  });

  it("streams assistant text deltas onto the last assistant message", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_start" },
    })!;
    expect(s.isStreaming).toBe(true);
    expect(s.isIdle).toBe(false);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: "" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
      },
    })!;
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.content).toBe("Hello world");

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "assistant", content: "Hello world!" },
      },
    })!;
    expect(s.messages[0]?.content).toBe("Hello world!");

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_end" },
    })!;
    expect(s.isIdle).toBe(false);
    expect(s.isStreaming).toBe(true);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;
    expect(s.isIdle).toBe(true);
    expect(s.isStreaming).toBe(false);
  });

  it("keeps assistant content dense when streaming events arrive at a later index first", () => {
    let s = applyAgentEvent(baseSession(), {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
    })!;

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "Answer" },
      },
    })!;
    expect(s.messages[0]?.content).toEqual([
      { type: "text", text: "" },
      { type: "text", text: "" },
      { type: "text", text: "Answer" },
    ]);

    for (const assistantMessageEvent of [
      { type: "thinking_delta", contentIndex: 0, delta: "Plan" },
      { type: "text_delta", contentIndex: 1, delta: "Bridge" },
    ] satisfies SerializableAssistantMessageEvent[]) {
      s = applyAgentEvent(s, {
        runId: "r1",
        event: { type: "message_update", assistantMessageEvent },
      })!;
    }

    expect(s.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "Plan", startedAt: expect.any(Number) },
      { type: "text", text: "Bridge" },
      { type: "text", text: "Answer" },
    ]);
    expect(Array.isArray(s.messages[0]?.content) && 0 in s.messages[0].content).toBe(true);
  });

  it("applies a frame of deltas in order with their original receive times", () => {
    let s = applyAgentEvent(
      baseSession(),
      {
        runId: "r1",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      90,
    )!;

    const identity = {
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
      packageRevision: 1,
    };
    s = applyAgentEventBatch(s, [
      {
        ...identity,
        sequence: 1,
        receivedAt: 100,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "Plan",
            },
          },
        },
      },
      {
        ...identity,
        sequence: 2,
        receivedAt: 140,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: 0,
              content: "Plan",
            },
          },
        },
      },
      {
        ...identity,
        sequence: 3,
        receivedAt: 150,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 1,
              delta: "Hello",
            },
          },
        },
      },
      {
        ...identity,
        sequence: 4,
        receivedAt: 160,
        payload: {
          runId: "r1",
          event: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 1,
              delta: " world",
            },
          },
        },
      },
    ])!;

    expect(s.messages[0]?.content).toMatchObject([
      { type: "thinking", thinking: "Plan", startedAt: 100, endedAt: 140 },
      { type: "text", text: "Hello world" },
    ]);
  });

  it("coalesces a large frame of compatible deltas without crossing boundaries", () => {
    const identity = {
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
      packageRevision: 1,
    };
    const makeEvent = (
      sequence: number,
      assistantMessageEvent: SerializableAssistantMessageEvent,
    ): TimedAgentEventEnvelope => ({
      ...identity,
      sequence,
      receivedAt: 100 + sequence,
      payload: {
        runId: "r1",
        event: { type: "message_update", assistantMessageEvent },
      },
    });
    const frame = Array.from({ length: 1_000 }, (_, index) =>
      makeEvent(index + 1, {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
      }),
    );
    frame.push(
      makeEvent(1_001, { type: "text_end", contentIndex: 0, content: "x".repeat(1_000) }),
      makeEvent(1_002, { type: "thinking_delta", contentIndex: 1, delta: "y" }),
      makeEvent(1_003, { type: "thinking_delta", contentIndex: 2, delta: "z" }),
    );

    const coalesced = coalesceAgentEventBatch(frame);

    expect(coalesced).toHaveLength(4);
    expect(coalesced[0]?.receivedAt).toBe(101);
    expect(coalesced[0]?.payload.event.assistantMessageEvent).toEqual({
      type: "text_delta",
      contentIndex: 0,
      delta: "x".repeat(1_000),
    });
  });

  it("applies a long-history delta frame with one outer draft and stable history entries", () => {
    const session = baseSession();
    session.messages = Array.from({ length: 5_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-${index}`,
    }));
    session.messages.push({ role: "assistant", content: "", startedAt: 50 });
    const originalMessages = session.messages;
    const originalFirst = session.messages[0];
    const identity = {
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
      packageRevision: 1,
    };
    const frame: TimedAgentEventEnvelope[] = Array.from({ length: 1_000 }, (_, index) => ({
      ...identity,
      sequence: index + 1,
      receivedAt: 100 + index,
      payload: {
        runId: "r1",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
        },
      },
    }));

    const next = applyAgentEventBatch(session, frame)!;

    expect(next.messages).not.toBe(originalMessages);
    expect(next.messages[0]).toBe(originalFirst);
    expect(next.messages.at(-1)?.content).toBe("x".repeat(1_000));
    expect(session.messages.at(-1)?.content).toBe("");
  });

  it("reconstructs streaming tool arguments and replaces transient state at tool end", () => {
    let s = applyAgentEvent(
      baseSession(),
      {
        runId: "r1",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      90,
    )!;
    for (const assistantMessageEvent of [
      { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "read" },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"' },
      { type: "toolcall_delta", contentIndex: 0, delta: 'a.ts"}' },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.ts" },
          providerMetadata: { stable: true },
        },
      },
    ] satisfies SerializableAssistantMessageEvent[]) {
      s = applyAgentEvent(
        s,
        {
          runId: "r1",
          event: { type: "message_update", assistantMessageEvent },
        },
        100,
      )!;
    }

    const content = s.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content[0]).toMatchObject({
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "a.ts" },
      providerMetadata: { stable: true },
      startedAt: 100,
    });
    expect(content[0]?.argumentsText).toBeUndefined();
  });

  it("rejects buffered events from a different Session generation", () => {
    const identity = {
      hostInstanceId: "h1",
      workspaceId: "w1",
      workspaceRevision: 1,
      sessionId: "s1",
      sessionRevision: 1,
      packageRevision: 1,
    };
    const event = {
      ...identity,
      sequence: 10,
      receivedAt: 100,
      payload: { event: { type: "message_update", delta: "stale" } },
    };

    expect(matchesTimedAgentEventIdentity(event, identity)).toBe(true);
    expect(
      matchesTimedAgentEventIdentity(event, {
        ...identity,
        sessionId: "s2",
        sessionRevision: 2,
      }),
    ).toBe(false);
  });

  it("keeps thinking and text deltas in separate content blocks", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
    })!;
    for (const event of [
      { type: "thinking_delta", contentIndex: 0, delta: "Inspect " },
      { type: "thinking_delta", contentIndex: 0, delta: "files" },
      { type: "thinking_end", contentIndex: 0, content: "Inspect files" },
      { type: "text_delta", contentIndex: 1, delta: "Done." },
    ] satisfies SerializableAssistantMessageEvent[]) {
      s = applyAgentEvent(s, {
        runId: "r1",
        event: { type: "message_update", assistantMessageEvent: event },
      })!;
    }

    expect(s.messages[0]?.content).toMatchObject([
      { type: "thinking", thinking: "Inspect files" },
      { type: "text", text: "Done." },
    ]);
    const thinking = Array.isArray(s.messages[0]?.content) ? s.messages[0].content[0] : undefined;
    expect(typeof thinking?.startedAt).toBe("number");
    expect(typeof thinking?.endedAt).toBe("number");
  });

  it("reconciles streamed deltas with Pi's authoritative final message", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Working",
        },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Plan", signature: "provider-signature" },
            { type: "text", text: "Working" },
          ],
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    })!;

    expect(s.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "Plan", signature: "provider-signature" },
      { type: "text", text: "Working" },
    ]);
    expect(s.messages[0]?.usage?.totalTokens).toBe(3);
  });

  it("tracks concurrent tool executions by toolCallId", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "a.ts" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-write",
        toolName: "write",
        args: { path: "b.ts" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_update",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "a.ts" },
        partialResult: { lines: 10 },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-write",
        toolName: "write",
        result: { written: true },
        isError: false,
      },
    })!;

    const parts = s.messages
      .filter((message) => message.role === "tool" && Array.isArray(message.content))
      .map((message) => (message.content as Array<Record<string, unknown>>)[0]);
    expect(parts).toHaveLength(2);
    expect(parts.find((part) => part.id === "call-read")?.status).toBe("running");
    expect(parts.find((part) => part.id === "call-read")?.result).toContain("lines");
    expect(parts.find((part) => part.id === "call-write")?.status).toBe("done");
    expect(parts.find((part) => part.id === "call-write")?.result).toContain("written");
  });

  it("preserves sibling tool parts when one execution is updated", () => {
    const session = baseSession();
    session.messages = [
      {
        role: "tool",
        content: [
          {
            type: "toolCall",
            id: "call-read",
            name: "read",
            text: "running",
            status: "running",
            startedAt: 10,
          },
          {
            type: "toolCall",
            id: "call-write",
            name: "write",
            text: "running",
            status: "running",
            startedAt: 20,
          },
        ],
      },
    ];

    const next = applyAgentEvent(
      session,
      {
        runId: "r1",
        event: {
          type: "tool_execution_update",
          toolCallId: "call-read",
          toolName: "read",
          partialResult: { lines: 10 },
        },
      },
      30,
    )!;

    const content = next.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content).toHaveLength(2);
    expect(content.find((part) => part.id === "call-read")?.result).toContain("lines");
    expect(content.find((part) => part.id === "call-write")).toMatchObject({
      name: "write",
      status: "running",
      startedAt: 20,
    });
  });

  it("preserves tool error and aborted states", () => {
    let s = baseSession();
    for (const [id, result, isError] of [
      ["call-error", { message: "boom" }, true],
      ["call-abort", { aborted: true }, false],
    ] as const) {
      s = applyAgentEvent(s, {
        runId: "r1",
        event: {
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "tool",
          args: {},
        },
      })!;
      s = applyAgentEvent(s, {
        runId: "r1",
        event: {
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "tool",
          result,
          isError,
        },
      })!;
    }
    const parts = s.messages
      .filter((message) => message.role === "tool" && Array.isArray(message.content))
      .map((message) => (message.content as Array<Record<string, unknown>>)[0]);
    expect(parts.find((part) => part.id === "call-error")?.status).toBe("error");
    expect(parts.find((part) => part.id === "call-abort")?.status).toBe("aborted");
  });

  it("maps Pi's standard error-shaped tool cancellation to aborted", () => {
    let s = applyAgentEvent(baseSession(), {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-sdk-abort",
        toolName: "read",
        args: { path: "large.txt" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-sdk-abort",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "Operation aborted" }],
          details: {},
        },
        isError: true,
      },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part).toMatchObject({
      id: "call-sdk-abort",
      status: "aborted",
      result: "Operation aborted",
      resultBlocks: [{ type: "text", text: "Operation aborted" }],
      details: {},
    });
  });

  it("keeps structured tool result content and details during realtime updates", () => {
    let s = applyAgentEvent(baseSession(), {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-image",
        toolName: "capture",
        args: { path: "screen.png" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_end",
        toolCallId: "call-image",
        toolName: "capture",
        result: {
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: "aW1n", mimeType: "image/png" },
          ],
          details: { width: 10 },
        },
      },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part).toMatchObject({
      id: "call-image",
      status: "done",
      result: "captured",
      resultBlocks: [
        { type: "text", text: "captured" },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
      details: { width: 10 },
    });
  });

  it("aborts unfinished tools when the agent settles", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-running",
        toolName: "bash",
        args: { command: "sleep 10" },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;

    const toolMessage = s.messages.find((message) => message.role === "tool");
    const part = Array.isArray(toolMessage?.content) ? toolMessage.content[0] : undefined;
    expect(part?.status).toBe("aborted");
    expect(typeof part?.endedAt).toBe("number");
    expect(s.isIdle).toBe(true);
  });

  it("keeps tools active across agent runs until the whole turn settles", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-before-continuation",
        toolName: "read",
        args: { path: "first.ts" },
      },
    })!;
    s = applyAgentEvent(
      s,
      {
        runId: "r1",
        event: { type: "agent_end" },
      },
      200,
    )!;

    const afterAgentEnd = s.messages.find((message) => message.role === "tool");
    const firstPart = Array.isArray(afterAgentEnd?.content) ? afterAgentEnd.content[0] : undefined;
    expect(firstPart).toMatchObject({
      id: "call-before-continuation",
      status: "running",
    });
    expect(firstPart?.endedAt).toBeUndefined();
    expect(s.isIdle).toBe(false);
    expect(s.isStreaming).toBe(true);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "tool_execution_start",
        toolCallId: "call-in-continuation",
        toolName: "read",
        args: { path: "second.ts" },
      },
    })!;
    const continuationTools = s.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content) ? message.content : [],
    );
    expect(continuationTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call-before-continuation", status: "running" }),
        expect.objectContaining({ id: "call-in-continuation", status: "running" }),
      ]),
    );

    s = applyAgentEvent(
      s,
      {
        runId: "r1",
        event: { type: "agent_settled" },
      },
      300,
    )!;
    const settledTools = s.messages.flatMap((message) =>
      message.role === "tool" && Array.isArray(message.content) ? message.content : [],
    );
    expect(settledTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "call-before-continuation",
          status: "aborted",
          endedAt: 300,
        }),
        expect.objectContaining({ id: "call-in-continuation", status: "aborted", endedAt: 300 }),
      ]),
    );
    expect(s.isIdle).toBe(true);
    expect(s.isStreaming).toBe(false);
  });

  it("aborts a tool call that never reached execution start", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "not-started", name: "read" }],
        },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "agent_settled" },
    })!;

    const content = s.messages[0]?.content;
    const part = Array.isArray(content) ? content[0] : undefined;
    expect(part?.status).toBe("aborted");
    expect(typeof part?.endedAt).toBe("number");
  });

  it("marks the session retrying across a summarization retry cycle", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "stream dropped",
      },
    })!;
    expect(s.isRetrying).toBe(true);
    expect(s.isIdle).toBe(false);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "summarization_retry_attempt_start", source: "branchSummary" },
    })!;
    expect(s.isRetrying).toBe(true);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "summarization_retry_finished" },
    })!;
    expect(s.isRetrying).toBe(false);
  });

  it("keeps compaction primacy while its summarization call retries", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "compaction_start", reason: "threshold" },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "overloaded",
      },
    })!;
    // The header resolves isCompacting before isRetrying, so the user keeps
    // seeing "Compacting"; the retry flag must not end compaction early.
    expect(s.isCompacting).toBe(true);
    expect(s.isRetrying).toBe(true);

    s = applyAgentEvent(s, { runId: "r1", event: { type: "summarization_retry_finished" } })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
    })!;
    expect(s.isCompacting).toBe(false);
    expect(s.isRetrying).toBe(false);
  });

  it("updates queue from queue_update", () => {
    let s = baseSession();
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "queue_update",
        steering: ["steer-1"],
        followUp: ["fu-1"],
      },
    } as AgentEventEnvelope)!;
    expect(s.pending.steering).toEqual(["steer-1"]);
    expect(s.pending.followUp).toEqual(["fu-1"]);
  });

  it("appends live extension entries only when they extend the active branch", () => {
    const session = baseSession();
    session.entries = [
      { id: "entry-1", type: "message", parentId: null, message: { role: "user", content: "hi" } },
    ];
    session.leafId = "entry-1";

    const next = applyAgentEvent(session, {
      runId: "r1",
      event: {
        type: "entry_appended",
        entry: {
          id: "entry-2",
          type: "custom",
          parentId: "entry-1",
          customType: "plan",
          data: { status: "active" },
        },
      },
    })!;

    expect(next.entries).toHaveLength(2);
    expect(next.leafId).toBe("entry-2");
  });

  it("waits for a full snapshot when an entry does not extend the active branch", () => {
    const session = baseSession();
    session.entries = [{ id: "entry-1", type: "custom", parentId: null }];
    session.leafId = "entry-1";

    const next = applyAgentEvent(session, {
      runId: "r1",
      event: {
        type: "entry_appended",
        entry: { id: "branch-entry", type: "custom", parentId: "other" },
      },
    })!;

    expect(next.entries).toEqual(session.entries);
    expect(next.leafId).toBe("entry-1");
  });
});

describe("optimistic user echo", () => {
  it("replaces the optimistic bubble with the authoritative user message on message_start", () => {
    let s = baseSession();
    s.messages = [{ role: "user", content: "hello", timestamp: 1, _optimisticKey: "opt-1" }];

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "user", content: "hello", timestamp: 2 },
      },
    })!;

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "hello" });
    expect(s.messages[0]?._optimisticKey).toBeUndefined();
  });

  it("does not duplicate when message_end arrives after message_start replaced the bubble", () => {
    let s = baseSession();
    s.messages = [
      { role: "user", content: "hello", _optimisticKey: "opt-1" },
      { role: "assistant", content: [] },
    ];

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "user", content: "hello", timestamp: 2 },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "user", content: "hello", timestamp: 2 },
      },
    })!;

    const userRows = s.messages.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(s.messages[0]?._optimisticKey).toBeUndefined();
  });

  it("claims the optimistic row when the authoritative text carries attachment blocks", () => {
    let s = baseSession();
    s.messages = [{ role: "user", content: "请查看这个附件", _optimisticKey: "opt-doc" }];
    const reference = buildAttachmentReferenceBlock([
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1024,
        status: "ready",
      },
    ]);

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: `请查看这个附件\n\n${reference}` }],
        },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: `请查看这个附件\n\n${reference}` }],
        },
      },
    })!;

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?._optimisticKey).toBeUndefined();
  });

  it("appends normally when no optimistic bubble matches the incoming text", () => {
    let s = baseSession();
    s.messages = [{ role: "user", content: "hello", _optimisticKey: "opt-1" }];

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "user", content: "different text", timestamp: 2 },
      },
    })!;

    expect(s.messages).toHaveLength(2);
  });

  it("message_end updates the newest matching user row after a same-text retry", () => {
    let s = baseSession();
    s.messages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "user", content: "hello", _optimisticKey: "opt-1" },
    ];

    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_start",
        message: { role: "user", content: "hello", timestamp: 2 },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r1",
      event: {
        type: "message_end",
        message: { role: "user", content: "hello", timestamp: 3 },
      },
    })!;

    const userRows = s.messages.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: "user", content: "hello", timestamp: 1 });
    expect(s.messages[1]).toMatchObject({ role: "user", content: "hello", timestamp: 3 });
  });
  it("claims a pure-image optimistic row on message_start and message_end", () => {
    let s = baseSession();
    s.messages = [
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "BASE64" }],
        _optimisticKey: "opt-image",
      },
    ];

    s = applyAgentEvent(s, {
      runId: "r-image",
      event: {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "BASE64" }],
        },
      },
    })!;
    s = applyAgentEvent(s, {
      runId: "r-image",
      event: {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "BASE64" }],
        },
      },
    })!;

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?._optimisticKey).toBeUndefined();
  });
});
