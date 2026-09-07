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
});
