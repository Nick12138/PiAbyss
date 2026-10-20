/**
 * End-to-end regression for the "🪄 施法中 N 个" wall of nameless 「tool · 等待中」
 * rows plus the shredded thinking blocks.
 *
 * Root cause was a Host that could not pin one run id per run (a delegated run
 * inherited the foreground prompt's id and then got a fresh random id per event
 * once that prompt settled). The reducer keys stream merging by runId, so every
 * delta opened a new assistant message. The Host fix lives in
 * session-runtime-cache (`resolveEventRunId`), but the renderer must also stay
 * whole against an id-unstable stream: unsealed rows keep merging, argument
 * deltas never fabricate a name-less tool part, and thinking indices that drift
 * grow the still-open thought.
 */
import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@piabyss/protocol";
import { applyAgentEvent } from "../../lib/chat/transcript-reducer";
import { buildTranscriptRows, type TranscriptRow } from "./transcript-model";

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

type ToolBlock = Extract<TranscriptRow["blocks"][number], { kind: "tool" }>;

const toolBlocks = (rows: TranscriptRow[]): ToolBlock[] =>
  rows.flatMap((row) => row.blocks.filter((block): block is ToolBlock => block.kind === "tool"));

describe("stream fragmented by an unstable Host run id", () => {
  it("still renders one thought and one settled tool card", () => {
    let session = baseSession();
    let nextRunId = 0;
    // Old Host behavior: a fresh id for every event of a run it did not pin.
    const send = (event: Record<string, unknown>) => {
      nextRunId += 1;
      session = applyAgentEvent(
        session,
        { runId: `run-${nextRunId}`, event: event as never },
        nextRunId,
      )!;
    };

    send({ type: "agent_start" });
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "这个问" },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "题该" },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先看入口" },
    });
    // Two tool calls: the second one's argument stream is what used to leave a
    // nameless card per delta.
    for (const [index, id] of [
      [1, "call-1"],
      [2, "call-2"],
    ] as const) {
      send({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id, name: "bash" },
      });
      for (const delta of ["{", '"command"', ':"pwd"', "}"]) {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta },
        });
      }
      send({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: index,
          toolCall: { type: "toolCall", id, name: "bash", arguments: { command: "pwd" } },
        },
      });
    }
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "这个问题该先看入口",
            thinkingSignature: "reasoning_content",
          },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "pwd" } },
        ],
      },
    });
    for (const id of ["call-1", "call-2"]) {
      send({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "bash",
        args: { command: "pwd" },
      });
      send({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "bash",
        result: { content: [{ type: "text", text: `/repo` }] },
        isError: false,
      });
      send({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "bash",
          content: [{ type: "text", text: "/repo" }],
          durationMs: 12,
          timestamp: 1_000,
        },
      });
    }
    send({ type: "agent_settled" });

    const rows = buildTranscriptRows(session.messages, { turnActive: session.isIdle === false });
    const thinking = rows.flatMap((row) => row.blocks.filter((block) => block.kind === "thinking"));
    const tools = toolBlocks(rows);

    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ kind: "thinking", text: "这个问题该先看入口" });
    expect(tools).toHaveLength(2);
    expect(tools.map((block) => block.tool.id)).toEqual(["call-1", "call-2"]);
    for (const block of tools) {
      expect(block.tool).toMatchObject({
        name: "bash",
        status: "done",
        result: "/repo",
        endedAt: 1_000,
      });
      expect(block.tool.startedAt).toBeDefined();
    }
    // The execution trace label counts real calls, not fragments.
    const traceSteps = rows.flatMap((row) =>
      (row.sections?.ordered ?? []).filter((block) => block.kind === "tool"),
    );
    expect(traceSteps).toHaveLength(2);
  });
});
