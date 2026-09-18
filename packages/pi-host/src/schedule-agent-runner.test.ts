/**
 * Schedule smart-creation transcripts must carry the raw content blocks (plus
 * the tool-result linkage) so the page can run them through the same
 * `buildTranscriptRows` projection as a workspace session — reasoning folds
 * into a ThinkingBlock and tool calls fold into an ExecutionTrace, instead of
 * the old `[thinking] …` / `[tool] name` text flattened into the bubble.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentTranscriptFrom } from "./schedule-agent-runner.js";

const dir = mkdtempSync(join(tmpdir(), "schedule-agent-runner-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeTranscript(name: string, lines: unknown[]): string {
  const file = join(dir, name);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

function messageLine(role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", message: { role, content, ...extra } };
}

describe("agentTranscriptFrom", () => {
  it("keeps content blocks and splits reasoning out of the answer text", () => {
    const file = writeTranscript("split.jsonl", [
      messageLine("user", [{ type: "text", text: "每天九点审查代码" }]),
      messageLine("assistant", [
        { type: "thinking", thinking: "先确认触发方式" },
        { type: "text", text: "请问需要几点运行？" },
        { type: "thinking", thinking: "再补充一句" },
      ]),
    ]);

    expect(agentTranscriptFrom(file)).toEqual([
      {
        role: "user",
        text: "每天九点审查代码",
        content: [{ type: "text", text: "每天九点审查代码" }],
      },
      {
        role: "assistant",
        text: "请问需要几点运行？",
        reasoning: "先确认触发方式\n\n再补充一句",
        content: [
          { type: "thinking", thinking: "先确认触发方式" },
          { type: "text", text: "请问需要几点运行？" },
          { type: "thinking", thinking: "再补充一句" },
        ],
      },
    ]);
  });

  it("keeps a thought-only message so the fold stays visible while it streams", () => {
    const file = writeTranscript("thought-only.jsonl", [
      messageLine("assistant", [{ type: "thinking", thinking: "思考中…" }]),
    ]);

    expect(agentTranscriptFrom(file)).toEqual([
      {
        role: "assistant",
        text: "",
        reasoning: "思考中…",
        content: [{ type: "thinking", thinking: "思考中…" }],
      },
    ]);
  });

  it("preserves tool calls and their toolResult linkage", () => {
    const file = writeTranscript("tools.jsonl", [
      messageLine("assistant", [
        { type: "thinking", thinking: "先看一眼目录" },
        { type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } },
      ]),
      messageLine("toolResult", [{ type: "text", text: "apps\npackages" }], {
        toolCallId: "call-1",
        toolName: "ls",
      }),
    ]);

    const messages = agentTranscriptFrom(file);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看一眼目录" },
        { type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } },
      ],
    });
    expect(messages[1]).toEqual({
      role: "toolResult",
      text: "apps\npackages",
      content: [{ type: "text", text: "apps\npackages" }],
      toolCallId: "call-1",
      toolName: "ls",
    });
  });

  it("flags failed tool results so the card renders an error status", () => {
    const file = writeTranscript("failed.jsonl", [
      messageLine("toolResult", [{ type: "text", text: "command not found" }], {
        toolCallId: "call-2",
        toolName: "bash",
        isError: true,
      }),
    ]);

    expect(agentTranscriptFrom(file)[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-2",
      isError: true,
    });
  });

  it("drops messages that carry neither text, reasoning nor blocks", () => {
    const file = writeTranscript("plain.jsonl", [
      messageLine("assistant", [{ type: "text", text: "好的" }]),
      messageLine("assistant", []),
    ]);

    expect(agentTranscriptFrom(file)).toEqual([
      { role: "assistant", text: "好的", content: [{ type: "text", text: "好的" }] },
    ]);
  });

  it("flattens legacy string content into a text block", () => {
    const file = writeTranscript("legacy.jsonl", [
      messageLine("user", "老版本会话"),
      messageLine("assistant", "读完了"),
    ]);

    expect(agentTranscriptFrom(file)).toEqual([
      { role: "user", text: "老版本会话", content: [{ type: "text", text: "老版本会话" }] },
      { role: "assistant", text: "读完了", content: [{ type: "text", text: "读完了" }] },
    ]);
  });
});
