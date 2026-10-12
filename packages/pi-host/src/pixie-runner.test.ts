import { afterEach, describe, expect, it } from "vitest";
import {
  askDispatch,
  failDispatch,
  findDispatchBySession,
  hasActiveDispatchFor,
  listDispatches,
  parsePixieModelRef,
  pixieState,
  reactivateDispatchAfterReply,
  registerDispatch,
  resetPixieStateForTests,
  resolvePixieWorkspacePath,
  settleDispatch,
  pixieStaleMs,
  pixieSegmentMaxTurns,
  pixieTranscriptFrom,
  setPixieContext,
  getKnownWorkspaces,
} from "./pixie-agent-runner.js";
import { buildDispatchTaskPrompt } from "./pixie-controller.js";
import { localDayKey } from "./pixie-usage.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshAgentDir(): string {
  resetPixieStateForTests();
  return mkdtempSync(join(tmpdir(), "pixie-test-"));
}

afterEach(() => {
  resetPixieStateForTests();
  delete process.env.PIABYSS_PIXIE_WORKSPACE;
  delete process.env.PIABYSS_PIXIE_STALE_MS;
  delete process.env.PIABYSS_PIXIE_MAX_TURNS;
});

describe("pixie delegation registry", () => {
  it("registers a dispatch and settles it on report", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "check bot",
      agentDir,
    });
    expect(record.status).toBe("dispatched");
    expect(record.kind).toBeNull();
    expect(hasActiveDispatchFor("s1")).toBe(true);
    expect(findDispatchBySession("s1")?.id).toBe(record.id);

    const settled = settleDispatch(record.id, "all good", "done", agentDir);
    expect(settled?.status).toBe("reported");
    expect(settled?.kind).toBe("done");
    expect(settled?.report).toBe("all good");
    expect(hasActiveDispatchFor("s1")).toBe(false);
  });

  it("fails a dispatch and rejects double-settling", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s2",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    const failed = failDispatch(record.id, "boom", agentDir);
    expect(failed?.status).toBe("failed");
    expect(failed?.kind).toBe("error");
    // Double-settle protection: both mutators reject an already-settled record.
    expect(failDispatch(record.id, "boom", agentDir)).toBeNull();
    expect(settleDispatch(record.id, "late report", "done", agentDir)).toBeNull();
    // Backdate so the stale sweep (triggered by later pixieState calls) cannot
    // poison the ordering assertion below.
    (record as { createdAt: number }).createdAt = Date.now() - pixieStaleMs() - 60_000;
  });

  it("marks stale dispatches after the configured threshold", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s3",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    // v4.1: the stale clock reads lastActiveAt ?? startedAt ?? createdAt.
    const backdated = Date.now() - pixieStaleMs() - 1_000;
    const mutable = record as unknown as {
      createdAt: number;
      startedAt: number | null;
      lastActiveAt: number | null;
    };
    mutable.createdAt = backdated;
    mutable.startedAt = backdated;
    mutable.lastActiveAt = backdated;
    const state = pixieState(agentDir);
    const stale = state.dispatches.find((d) => d.id === record.id);
    expect(stale?.stale).toBe(true);
  });

  it("lists dispatches newest first with a bound", async () => {
    const agentDir = freshAgentDir();
    for (let i = 0; i < 5; i++) {
      const record = registerDispatch({
        cwd: "C:/ws",
        sessionId: `bulk-${i}`,
        sessionPath: null,
        task: `t${i}`,
        agentDir,
      });
      (record as { createdAt: number }).createdAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const all = listDispatches(50, agentDir).filter((d) => d.sessionId?.startsWith("bulk-"));
    expect(all.length).toBe(5);
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1]!;
      const current = all[i]!;
      expect(previous.createdAt).toBeGreaterThanOrEqual(current.createdAt);
    }
    expect(listDispatches(2, agentDir)).toHaveLength(2);
  });

  it("persists dispatch records across a registry reload", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "persist-1",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    settleDispatch(record.id, "done!", "done", agentDir);
    // Simulate a fresh Host process: wipe memory, reload from disk.
    resetPixieStateForTests();
    const state = pixieState(agentDir);
    const reloaded = state.dispatches.find((d) => d.id === record.id);
    expect(reloaded?.status).toBe("reported");
    expect(reloaded?.report).toBe("done!");
  });

  it("routes ask → awaiting_user → user reply → dispatched", () => {
    const agentDir = freshAgentDir();
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "ask-1",
      sessionPath: null,
      task: "t",
      agentDir,
    });
    const asked = askDispatch(record.id, "选哪个方案？", ["方案 A", "方案 B"], agentDir);
    expect(asked?.status).toBe("awaiting_user");
    expect(asked?.kind).toBe("ask");
    expect(asked?.question).toBe("选哪个方案？");
    expect(asked?.options).toEqual(["方案 A", "方案 B"]);

    const state = pixieState(agentDir);
    expect(state.askPending).toBe(true);

    const reply = reactivateDispatchAfterReply(record.id, "方案 A", agentDir);
    expect("record" in reply && reply.record.status).toBe("dispatched");
    expect(pixieState(agentDir).askPending).toBe(false);

    // Reply on a non-awaiting record fails.
    expect("error" in reactivateDispatchAfterReply(record.id, "again", agentDir)).toBe(true);
  });
});

describe("pixie workspace + config resolution", () => {
  it("defaults the workspace to <agentDir>/workspace/pixie", () => {
    delete process.env.PIABYSS_PIXIE_WORKSPACE;
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("C:/agent", "workspace", "pixie"));
  });

  it("honours PIABYSS_PIXIE_WORKSPACE with the {agentDir} placeholder", () => {
    process.env.PIABYSS_PIXIE_WORKSPACE = "{agentDir}/custom/pixie";
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("C:/agent", "custom", "pixie"));
    process.env.PIABYSS_PIXIE_WORKSPACE = "D:/fixed/path";
    expect(resolvePixieWorkspacePath("C:/agent")).toBe(join("D:/fixed/path"));
  });

  it("parses provider/model refs at the first slash", () => {
    expect(parsePixieModelRef("openai/gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(parsePixieModelRef("openai/gpt-4o/mini")).toEqual({
      provider: "openai",
      id: "gpt-4o/mini",
    });
    expect(parsePixieModelRef("/nope")).toBeNull();
    expect(parsePixieModelRef(undefined)).toBeNull();
  });

  it("applies stale/max-turns env overrides with safe defaults", () => {
    delete process.env.PIABYSS_PIXIE_STALE_MS;
    delete process.env.PIABYSS_PIXIE_MAX_TURNS;
    expect(pixieStaleMs()).toBe(30 * 60 * 1000);
    expect(pixieSegmentMaxTurns()).toBe(200);
    process.env.PIABYSS_PIXIE_STALE_MS = "60000";
    process.env.PIABYSS_PIXIE_MAX_TURNS = "50";
    expect(pixieStaleMs()).toBe(60000);
    expect(pixieSegmentMaxTurns()).toBe(50);
  });

  it("persists and reloads the known-workspace context", () => {
    const agentDir = freshAgentDir();
    setPixieContext(agentDir, ["C:/work/a", "C:/work/b"]);
    resetPixieStateForTests();
    expect(getKnownWorkspaces(agentDir)).toEqual(["C:/work/a", "C:/work/b"]);
  });
});

describe("dispatch task prompt template", () => {
  it("embeds the task and the callback contract", () => {
    const prompt = buildDispatchTaskPrompt({ task: "check okxbot", from: "小精灵委派" });
    expect(prompt).toContain("check okxbot");
    expect(prompt).toContain("pixie_report");
    expect(prompt).toContain("pixie_ask");
    expect(prompt).toContain("piabyss_memo complete");
    expect(prompt).toContain("<pixie-dispatch>");
  });

  it("states manual-user-message priority and the no-complete-while-awaiting-user rule", () => {
    const prompt = buildDispatchTaskPrompt({ task: "t", from: "小精灵委派" });
    expect(prompt).toContain("优先级最高");
    expect(prompt).toContain("以用户指令为准");
    expect(prompt).toContain("不再等待用户输入");
    expect(prompt).toContain("需要用户决策");
  });
});

describe("pixie timeline placeholder", () => {
  it("renders an archived segment with empty messages instead of crashing", () => {
    const agentDir = freshAgentDir();
    // No sessions were ever created: the timeline is empty and the state is
    // the neutral pre-first-message shape.
    const state = pixieState(agentDir);
    expect(state.resident).toBe(false);
    expect(state.segments).toEqual([]);
    expect(state.askPending).toBe(false);
    expect(state.messages).toEqual([]);
  });
});

describe("pixie transcript from disk", () => {
  it("reads messages from a standard session JSONL", () => {
    const agentDir = freshAgentDir();
    const file = join(agentDir, "session_t1.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "t1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf8",
    );
    const messages = pixieTranscriptFrom(file);
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("hello");
    expect(pixieTranscriptFrom(join(agentDir, "missing.jsonl"))).toEqual([]);
  });
});

describe("pixie usage day key", () => {
  it("formats a local YYYY-MM-DD key", () => {
    const key = localDayKey(new Date(2026, 8, 29, 9, 30).getTime());
    expect(key).toBe("2026-09-29");
  });
});
