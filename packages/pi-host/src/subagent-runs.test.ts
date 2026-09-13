import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapSubagentRunState,
  readSubagentRunStatus,
  readSubagentRunTitle,
  readSubagentRunTranscript,
  resolveSubagentRunId,
  subagentRunsRoot,
} from "./subagent-runs.js";

let home: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => home,
  };
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "piabyss-subagent-runs-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeRun(runId: string, sessionLines: string[], status = "running"): void {
  const dir = join(subagentRunsRoot(), runId);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "task.json"),
    JSON.stringify({ id: runId, title: `任务 ${runId}`, agent: "worker", cwd: "/repo" }),
    "utf8",
  );
  writeFileSync(join(dir, "status.json"), JSON.stringify({ status }), "utf8");
  if (sessionLines.length > 0) {
    writeFileSync(
      join(dir, "sessions", `0_run_${runId}.jsonl`),
      sessionLines.join("\n") + "\n",
      "utf8",
    );
  }
}

describe("subagent-runs", () => {
  it("reads the newest session transcript with header metadata", () => {
    writeRun("run_1", [
      JSON.stringify({ type: "session", id: "sub-run_1", name: "任务 run_1", version: 3 }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Do the task" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        timestamp: "2026-01-01T00:00:30.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "Done" },
          ],
        },
      }),
    ]);

    const transcript = readSubagentRunTranscript("run_1");
    expect(transcript).not.toBeNull();
    expect(transcript!.sessionId).toBe("sub-run_1");
    expect(transcript!.name).toBe("任务 run_1");
    expect(transcript!.truncated).toBe(false);
    expect(transcript!.entries).toHaveLength(2);
    expect(transcript!.entries[1]).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Done" },
        ],
      },
    });
  });

  it("returns null when the run has no session file yet", () => {
    writeRun("run_1", []);
    expect(readSubagentRunTranscript("run_1")).toBeNull();
  });

  it("reads task title and status metadata", () => {
    writeRun("run_1", [], "failed");
    expect(readSubagentRunTitle("run_1")).toBe("任务 run_1");
    expect(readSubagentRunStatus("run_1")).toBe("failed");
  });

  it("resolves legacy external node ids to the run id", () => {
    expect(resolveSubagentRunId("run_9")).toBe("run_9");
    expect(resolveSubagentRunId("external:session-1:run_9")).toBe("run_9");
    expect(resolveSubagentRunId("  run_9  ")).toBe("run_9");
  });

  it("maps plugin statuses to panel states", () => {
    expect(mapSubagentRunState("pending")).toBe("queued");
    expect(mapSubagentRunState("queued")).toBe("queued");
    expect(mapSubagentRunState("running")).toBe("running");
    expect(mapSubagentRunState("paused")).toBe("paused");
    expect(mapSubagentRunState("completed")).toBe("complete");
    expect(mapSubagentRunState("failed")).toBe("failed");
    expect(mapSubagentRunState("stopped")).toBe("stopped");
    expect(mapSubagentRunState("interrupted")).toBe("stopped");
    expect(mapSubagentRunState(undefined)).toBe("running");
  });

  it("keeps the tail of large transcripts so the final answer survives", () => {
    const bigToolResult = JSON.stringify({
      type: "message",
      id: "t1",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(300_000) }],
      },
    });
    const early = (id: string) =>
      JSON.stringify({
        type: "message",
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: `early ${id}` }] },
      });
    const finalAnswer = JSON.stringify({
      type: "message",
      id: "final",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "最终调查结果".repeat(1000) }],
      },
    });
    writeRun("run_tail", [
      JSON.stringify({ type: "session", id: "sub-run_tail", name: "尾窗任务", version: 3 }),
      early("a1"),
      early("a2"),
      bigToolResult,
      finalAnswer,
    ]);

    const transcript = readSubagentRunTranscript("run_tail");
    expect(transcript).not.toBeNull();
    expect(transcript!.sessionId).toBe("sub-run_tail");
    expect(transcript!.name).toBe("尾窗任务");
    expect(transcript!.truncated).toBe(true);
    const last = transcript!.entries.at(-1) as {
      message?: { role?: string; content?: { type: string; text?: string }[] };
    };
    expect(last.message?.role).toBe("assistant");
    expect(last.message?.content?.some((block) => block.text?.includes("最终调查结果"))).toBe(true);
    const ids = transcript!.entries.map((entry) => (entry as { id?: string }).id);
    expect(ids).not.toContain("a1");
    expect(ids).not.toContain("a2");
    // The oversized tool result alone exceeds MAX_TOTAL_TEXT, so the contiguous
    // tail window starts after it and only the final answer survives.
    expect(ids).toEqual(["final"]);
  });

  it("prepends the first user task message when the tail window lacks one", () => {
    const task = JSON.stringify({
      type: "message",
      id: "task",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "原始任务描述" }] },
    });
    // A 240KB+ tool result forces the window to start after it, dropping the task.
    const bigToolResult = JSON.stringify({
      type: "message",
      id: "t1",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "x".repeat(300_000) }],
      },
    });
    const finalAnswer = JSON.stringify({
      type: "message",
      id: "final",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "最终报告" }] },
    });
    writeRun("run_task", [task, bigToolResult, finalAnswer]);

    const transcript = readSubagentRunTranscript("run_task");
    expect(transcript).not.toBeNull();
    const ids = transcript!.entries.map((entry) => (entry as { id?: string }).id);
    expect(ids).toEqual(["task", "final"]);
    const first = transcript!.entries[0] as {
      message?: { role?: string; content?: { type: string; text?: string }[] };
    };
    expect(first.message?.role).toBe("user");
    expect(first.message?.content?.[0]?.text).toBe("原始任务描述");
  });

  it("snaps the window start to a turn boundary, dropping orphan tool results", () => {
    const task = JSON.stringify({
      type: "message",
      id: "task",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "任务" }] },
    });
    const toolCall = JSON.stringify({
      type: "message",
      id: "call-entry",
      timestamp: "2026-01-01T00:00:20.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "grep", arguments: { pattern: "x" } }],
      },
    });
    const orphanResult = (id: string) =>
      JSON.stringify({
        type: "message",
        id,
        timestamp: "2026-01-01T00:00:30.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_9",
          toolName: "grep",
          isError: false,
          content: [{ type: "text", text: "y".repeat(150_000) }],
        },
      });
    const finalAnswer = JSON.stringify({
      type: "message",
      id: "final",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "报告" }] },
    });
    // Two 150KB results exceed the 240KB budget, so the raw window lands on
    // the first orphan result; snapping must skip both and start at "final".
    writeRun("run_snap", [task, toolCall, orphanResult("o1"), orphanResult("o2"), finalAnswer]);

    const transcript = readSubagentRunTranscript("run_snap");
    expect(transcript).not.toBeNull();
    const ids = transcript!.entries.map((entry) => (entry as { id?: string }).id);
    expect(ids).toEqual(["task", "final"]);
  });
});
