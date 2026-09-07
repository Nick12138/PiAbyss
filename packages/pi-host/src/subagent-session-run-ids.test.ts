import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSessionRunIds, resetSessionRunIdCache } from "./subagent-status-extension.js";

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "piabyss-session-runids-"));
});

afterEach(() => {
  resetSessionRunIdCache();
  rmSync(sessionsDir, { recursive: true, force: true });
});

function writeSession(sessionId: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(sessionsDir, `2026-08-25T00-00-00-000Z_${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify({ type: "session", id: sessionId, ...line })).join("\n") +
      "\n",
    "utf8",
  );
}

describe("collectSessionRunIds", () => {
  it("returns null without a session id or sessions dir", () => {
    expect(collectSessionRunIds("", "session-1")).toBeNull();
    expect(collectSessionRunIds(sessionsDir, null)).toBeNull();
  });

  it("extracts run ids from subagent tool invocations in the active session file", () => {
    writeSession("session-1", [
      {},
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "subagent", arguments: { agent: "worker", task: "x" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          content: [{ type: "text", text: "已提交 1 个子代理任务：\n- run_mt7zi8dhc52d5f" }],
        },
      },
    ]);

    const ids = collectSessionRunIds(sessionsDir, "session-1");
    expect(ids).toEqual(new Set(["run_mt7zi8dhc52d5f"]));
  });

  it("caches by session id + mtime and ignores other sessions' files", () => {
    writeSession("session-1", [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          content: [{ type: "text", text: "已提交 1 个子代理任务：\n- run_a1b2c3d4e5f6g7" }],
        },
      },
    ]);
    writeSession("session-2", [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          content: [{ type: "text", text: "已提交 1 个子代理任务：\n- run_zz9yy8xx7ww6vv5" }],
        },
      },
    ]);

    const first = collectSessionRunIds(sessionsDir, "session-1");
    const second = collectSessionRunIds(sessionsDir, "session-1");
    expect(first).toEqual(new Set(["run_a1b2c3d4e5f6g7"]));
    expect(second).toBe(first); // cached
    expect(collectSessionRunIds(sessionsDir, "session-2")).toEqual(
      new Set(["run_zz9yy8xx7ww6vv5"]),
    );
  });

  it("ignores run ids mentioned in list/result outputs (only spawns count)", () => {
    writeSession("session-1", [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          content: [
            {
              type: "text",
              text: "子代理列表（共 2 个）：\n- run_spawned1 [运行中]「a」\n- run_spawned2 [已完成]「b」",
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          content: [{ type: "text", text: "已提交 1 个子代理任务：\n- run_spawned1" }],
        },
      },
    ]);

    expect(collectSessionRunIds(sessionsDir, "session-1")).toEqual(new Set(["run_spawned1"]));
  });

  it("returns null when the session file does not exist", () => {
    expect(collectSessionRunIds(sessionsDir, "missing-session")).toBeNull();
  });
});
