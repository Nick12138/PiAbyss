import { describe, expect, it } from "vitest";
import {
  failDispatch,
  findDispatchBySession,
  hasActiveDispatchFor,
  latestPixieSessionFile,
  listDispatches,
  pixieState,
  registerDispatch,
  settleDispatch,
  PIXIE_STALE_MS,
} from "./pixie-agent-runner.js";
import { buildDispatchTaskPrompt } from "./pixie-controller.js";
import { localDayKey } from "./pixie-usage.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pixie delegation registry", () => {
  it("registers a dispatch and settles it on report", () => {
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s1",
      sessionPath: "C:/s1.jsonl",
      task: "check bot",
    });
    expect(record.status).toBe("dispatched");
    expect(hasActiveDispatchFor("s1")).toBe(true);
    expect(findDispatchBySession("s1")?.id).toBe(record.id);

    const settled = settleDispatch(record.id, "all good");
    expect(settled?.status).toBe("reported");
    expect(settled?.report).toBe("all good");
    expect(hasActiveDispatchFor("s1")).toBe(false);
  });

  it("fails a dispatch and rejects double-settling", () => {
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s2",
      sessionPath: null,
      task: "t",
    });
    expect(failDispatch(record.id, "boom")?.status).toBe("failed");
    expect(settleDispatch(record.id, "late report")).toBeNull();
    // Backdate it so the stale-marking sweep (triggered by later pixieState()
    // calls in other tests) cannot poison the ordering assertion below.
    (record as { createdAt: number }).createdAt = Date.now() - PIXIE_STALE_MS - 60_000;
  });

  it("marks stale dispatches after the threshold", async () => {
    const record = registerDispatch({
      cwd: "C:/ws",
      sessionId: "s3",
      sessionPath: null,
      task: "t",
    });
    // Simulate age by backdating creation.
    (record as { createdAt: number }).createdAt = Date.now() - PIXIE_STALE_MS - 1_000;
    const state = pixieState();
    const stale = state.dispatches.find((d) => d.id === record.id);
    expect(stale?.stale).toBe(true);
  });

  it("lists dispatches newest first with a bound", async () => {
    for (let i = 0; i < 5; i++) {
      const record = registerDispatch({
        cwd: "C:/ws",
        sessionId: `bulk-${i}`,
        sessionPath: null,
        task: `t${i}`,
      });
      // The stale sweep only flags dispatched records older than the
      // threshold; backdating keeps earlier tests' backdated records from
      // asserting on wall-clock drift. Records register 2ms apart.
      (record as { createdAt: number }).createdAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const all = listDispatches(50).filter((d) => d.sessionId?.startsWith("bulk-"));
    expect(all.length).toBe(5);
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1]!;
      const current = all[i]!;
      expect(previous.createdAt).toBeGreaterThanOrEqual(current.createdAt);
    }
    expect(listDispatches(2)).toHaveLength(2);
  });
});

describe("dispatch task prompt template", () => {
  it("embeds the task and the callback contract", () => {
    const prompt = buildDispatchTaskPrompt({ task: "check okxbot", from: "小精灵委派" });
    expect(prompt).toContain("check okxbot");
    expect(prompt).toContain("pixie_report");
    expect(prompt).toContain("piabyss_memo complete");
    expect(prompt).toContain("<pixie-dispatch>");
  });

  it("states manual-user-message priority and the no-complete-while-awaiting-user rule", () => {
    const prompt = buildDispatchTaskPrompt({ task: "t", from: "小精灵委派" });
    // 用户手动消息优先级最高，可覆盖内嵌提示词。
    expect(prompt).toContain("优先级最高");
    expect(prompt).toContain("以用户指令为准");
    // 等待用户决策时不回填备忘录 complete。
    expect(prompt).toContain("不再等待用户输入");
    expect(prompt).toContain("需要用户决策");
  });
});

describe("pixie transcript from disk", () => {
  it("reads the newest session file from the pixie dir", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pixie-test-"));
    const dir = join(agentDir, "piabyss", "pixie", "agent-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session_t1.jsonl"),
      [
        JSON.stringify({ type: "session", id: "t1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf8",
    );
    const found = latestPixieSessionFile(agentDir);
    expect(found).toBeTruthy();
  });
});

describe("pixie usage day key", () => {
  it("formats a local YYYY-MM-DD key", () => {
    const key = localDayKey(new Date(2026, 8, 29, 9, 30).getTime());
    expect(key).toBe("2026-09-29");
  });
});
