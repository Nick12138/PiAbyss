import { describe, expect, it } from "vitest";
import type { SubagentHttpRunSummary } from "./subagent-api.js";
import { mapSubagentHttpRun, normalizeSubagentRuns } from "./subagent-status-extension.js";

function run(overrides: Partial<SubagentHttpRunSummary> = {}): SubagentHttpRunSummary {
  return {
    id: "run_abc",
    title: "认证探索",
    agent: "scout",
    sessionId: "session-1",
    status: "running",
    statusLabel: "运行中",
    createdAt: 1000,
    startedAt: 2000,
    model: "openai/gpt-5",
    resumeCount: 0,
    retryLeft: 1,
    worktree: false,
    outputPreview: "",
    cost: 0,
    turns: 0,
    ...overrides,
  };
}

describe("mapSubagentHttpRun", () => {
  it("maps every plugin status to the panel state set", () => {
    const cases: Array<[string, string]> = [
      ["pending", "queued"],
      ["running", "running"],
      ["paused", "paused"],
      ["completed", "complete"],
      ["failed", "failed"],
      ["stopped", "stopped"],
      ["interrupted", "stopped"],
    ];
    for (const [status, expected] of cases) {
      expect(mapSubagentHttpRun(run({ status })).state).toBe(expected);
    }
  });

  it("carries title/agent/model/timestamps through", () => {
    const node = mapSubagentHttpRun(run());
    expect(node).toMatchObject({
      id: "run_abc",
      kind: "subagent",
      label: "认证探索",
      role: "scout",
      model: "openai/gpt-5",
      state: "running",
      startedAt: 2000,
    });
    expect(node.endedAt).toBeUndefined();
    expect(node.updatedAt).toBe(2000);
  });

  it("falls back to the run id when the title is empty", () => {
    const node = mapSubagentHttpRun(run({ title: "   ", agent: "worker" }));
    expect(node.label).toBe("run_abc");
    expect(node.role).toBe("worker");
  });

  it("exposes the output preview as activity and the end time when finished", () => {
    const node = mapSubagentHttpRun(
      run({ status: "completed", finishedAt: 9000, outputPreview: "完成：已改 3 个文件" }),
    );
    expect(node.state).toBe("complete");
    expect(node.endedAt).toBe(9000);
    expect(node.updatedAt).toBe(9000);
    expect(node.activity).toEqual({ state: "完成：已改 3 个文件" });
  });
});

describe("normalizeSubagentRuns", () => {
  it("scopes runs to the active session and counts only running runs as active", () => {
    const snapshot = normalizeSubagentRuns(
      [
        run({ id: "a", sessionId: "session-1", status: "running" }),
        run({ id: "b", sessionId: "session-1", status: "queued" }),
        run({ id: "c", sessionId: "session-1", status: "completed" }),
        // Other-session and legacy (no session id) runs must not leak in.
        run({ id: "other", sessionId: "session-2", status: "running" }),
        run({ id: "legacy", sessionId: null, status: "running" }),
      ],
      undefined,
      "session-1",
    );
    expect(snapshot.available).toBe(true);
    expect(snapshot.totalActive).toBe(1);
    expect(snapshot.omitted).toBe(0);
    expect(snapshot.fleet).toEqual([]);
    expect(snapshot.runs.map((node) => node.id)).toEqual(["a", "b", "c"]);
  });

  it("hides everything when no session is attached yet", () => {
    const snapshot = normalizeSubagentRuns([run({ status: "running" })], undefined, null);
    expect(snapshot.available).toBe(true);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.totalActive).toBe(0);
  });

  it("shows legacy runs (no sessionId) when the active session spawned them", () => {
    const owned = new Set(["legacy-run-1"]);
    const snapshot = normalizeSubagentRuns(
      [
        run({ id: "legacy-run-1", sessionId: null, status: "running" }),
        run({ id: "legacy-run-2", sessionId: null, status: "completed" }),
        run({ id: "other-session", sessionId: "session-2", status: "running" }),
      ],
      undefined,
      "session-1",
      owned,
    );
    expect(snapshot.runs.map((node) => node.id)).toEqual(["legacy-run-1"]);
    expect(snapshot.totalActive).toBe(1);
  });

  it("does not let transcript evidence override an explicit other-session owner", () => {
    const owned = new Set(["stale-owned"]);
    const snapshot = normalizeSubagentRuns(
      [run({ id: "stale-owned", sessionId: "session-2", status: "running" })],
      undefined,
      "session-1",
      owned,
    );
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.totalActive).toBe(0);
  });

  it("uses transcript evidence only for legacy runs without sessionId", () => {
    const snapshot = normalizeSubagentRuns(
      [
        run({ id: "legacy-owned", sessionId: null, status: "running" }),
        run({ id: "legacy-alien", sessionId: undefined, status: "running" }),
      ],
      undefined,
      "session-1",
      new Set(["legacy-owned"]),
    );
    expect(snapshot.runs.map((node) => node.id)).toEqual(["legacy-owned"]);
  });

  it("caps the scoped runs array at 32 and reports the remainder as omitted", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      run({
        id: `run_${index}`,
        sessionId: "session-1",
        status: index % 2 === 0 ? "running" : "completed",
      }),
    );
    const snapshot = normalizeSubagentRuns(many, undefined, "session-1");
    expect(snapshot.runs).toHaveLength(32);
    expect(snapshot.omitted).toBe(8);
    expect(snapshot.totalActive).toBe(16);
  });
});
