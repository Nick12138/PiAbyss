/**
 * 会话缓存 + 会话归属规则（v4.3）：
 * 小精灵默认只能使用/复用自己创建的会话；用户自己创建的会话只有显式给出 id 时才被登记使用。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PixieDispatchRecord } from "@piabyss/protocol";
import {
  applyDispatchRecordsToSessionCache,
  isPixieOwnedSessionId,
  isPixieOwnedSessionPath,
  listPixieSessions,
  loadPixieSessionCache,
  pixieSessionCachePath,
  sessionLookupKey,
  upsertPixieSession,
} from "./pixie-session-cache.js";

const roots: string[] = [];

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pixie-cache-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dispatchRecord(over: Partial<PixieDispatchRecord>): PixieDispatchRecord {
  return {
    id: "pix_1",
    status: "reported",
    kind: "done",
    cwd: "D:/ws",
    sessionId: "s1",
    sessionPath: "D:/ws/sessions/s1.jsonl",
    task: "查询任务",
    report: null,
    question: null,
    options: [],
    createdAt: 1,
    startedAt: 1,
    reportedAt: null,
    lastActiveAt: 1,
    stale: false,
    staleNotified: false,
    batchId: null,
    failCount: 0,
    progressSummary: null,
    files: null,
    retryOf: null,
    model: null,
    thinkingLevel: null,
    originSessionId: null,
    ...over,
  };
}

describe("pixie session cache — 归属规则", () => {
  it("未登记的会话一律不算小精灵的（保守方向：用户自己的会话自动落点永远挑不到）", () => {
    const agentDir = makeAgentDir();
    expect(isPixieOwnedSessionPath(agentDir, "D:/ws/sessions/user-made.jsonl")).toBe(false);
    expect(isPixieOwnedSessionId(agentDir, "user-made")).toBe(false);
    expect(isPixieOwnedSessionPath(agentDir, "")).toBe(false);
  });

  it("小精灵新建的会话登记后即为自己人；路径大小写与斜杠差异不影响判定", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "s1",
      sessionPath: "D:/ws/sessions/s1.jsonl",
      cwd: "D:/ws",
      owner: "pixie",
      role: "delegated",
      summary: "查询任务",
    });
    expect(isPixieOwnedSessionPath(agentDir, "D:/ws/sessions/s1.jsonl")).toBe(true);
    expect(isPixieOwnedSessionPath(agentDir, "d:/WS/sessions/s1.jsonl/")).toBe(true);
    expect(isPixieOwnedSessionId(agentDir, "s1")).toBe(true);
    expect(isPixieOwnedSessionId(agentDir, "s2")).toBe(false);
  });

  it("显式指定的用户会话登记为 owner=user：留在缓存里可被交代，但不算可自动复用", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "user1",
      sessionPath: "D:/ws/sessions/user1.jsonl",
      cwd: "D:/ws",
      owner: "user",
      role: "delegated",
      summary: "用户指定的会话",
    });
    expect(isPixieOwnedSessionId(agentDir, "user1")).toBe(false);
    expect(isPixieOwnedSessionPath(agentDir, "D:/ws/sessions/user1.jsonl")).toBe(false);
    expect(listPixieSessions(agentDir, "D:/ws")).toHaveLength(1);
  });

  it("归属一经确定不再翻转（用户会话被登记后不会被复用路径改写成 pixie）", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "user1",
      sessionPath: "D:/ws/sessions/user1.jsonl",
      cwd: "D:/ws",
      owner: "user",
      role: "delegated",
    });
    upsertPixieSession(agentDir, {
      sessionId: "user1",
      sessionPath: "D:/ws/sessions/user1.jsonl",
      cwd: "D:/ws",
      owner: "pixie",
      role: "delegated",
      reused: true,
    });
    expect(isPixieOwnedSessionId(agentDir, "user1")).toBe(false);
    expect(loadPixieSessionCache(agentDir).sessions[0]?.reuseCount).toBe(1);
  });
});

describe("pixie session cache — 保存与交代信息", () => {
  it("缓存内容只有简洁摘要：任务简介截断 120 字、结果截断 200 字", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "s1",
      sessionPath: "D:/ws/sessions/s1.jsonl",
      cwd: "D:/ws",
      owner: "pixie",
      role: "pixie",
      summary: "长".repeat(400),
      result: "果".repeat(400),
    });
    const entry = loadPixieSessionCache(agentDir).sessions[0]!;
    expect(entry.summary.length).toBe(120);
    expect(entry.result?.length).toBe(200);
  });

  it("按工作区过滤 + 按最后活跃倒序", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "a",
      sessionPath: "D:/ws-a/s.jsonl",
      cwd: "D:/ws-a",
      owner: "pixie",
      role: "delegated",
      now: 100,
    });
    upsertPixieSession(agentDir, {
      sessionId: "b",
      sessionPath: "D:/ws-b/s.jsonl",
      cwd: "D:/ws-b",
      owner: "pixie",
      role: "delegated",
      now: 300,
    });
    expect(listPixieSessions(agentDir).map((entry) => entry.sessionId)).toEqual(["b", "a"]);
    expect(listPixieSessions(agentDir, "D:/WS-A").map((entry) => entry.sessionId)).toEqual(["a"]);
  });

  it("委派记录只补进已登记的会话，不凭空造条目、不改归属", () => {
    const agentDir = makeAgentDir();
    upsertPixieSession(agentDir, {
      sessionId: "s1",
      sessionPath: "D:/ws/sessions/s1.jsonl",
      cwd: "D:/ws",
      owner: "pixie",
      role: "delegated",
      summary: "查询任务",
    });
    applyDispatchRecordsToSessionCache(agentDir, [
      dispatchRecord({ id: "pix_1", report: "结果：门店 12 家" }),
      dispatchRecord({
        id: "pix_9",
        sessionId: "other",
        sessionPath: "D:/ws/sessions/other.jsonl",
      }),
    ]);
    const cache = loadPixieSessionCache(agentDir);
    expect(cache.sessions).toHaveLength(1);
    const entry = cache.sessions[0]!;
    expect(entry.dispatchIds).toEqual(["pix_1"]);
    expect(entry.result).toBe("结果：门店 12 家");
    // 幂等：重复同步不重复追加
    applyDispatchRecordsToSessionCache(agentDir, [
      dispatchRecord({ id: "pix_1", report: "结果：门店 12 家" }),
    ]);
    expect(loadPixieSessionCache(agentDir).sessions[0]?.dispatchIds).toEqual(["pix_1"]);
  });

  it("文件缺失或损坏时回退为空缓存，不抛错", () => {
    const agentDir = makeAgentDir();
    expect(loadPixieSessionCache(agentDir).sessions).toEqual([]);
    mkdirSync(dirname(pixieSessionCachePath(agentDir)), { recursive: true });
    writeFileSync(pixieSessionCachePath(agentDir), "{ not json", "utf8");
    expect(loadPixieSessionCache(agentDir).sessions).toEqual([]);
  });

  it("sessionLookupKey 归一化盘符、斜杠与结尾斜杠", () => {
    expect(sessionLookupKey("D:\\Ws\\s1.jsonl\\")).toBe(sessionLookupKey("d:/ws/s1.jsonl"));
  });
});
