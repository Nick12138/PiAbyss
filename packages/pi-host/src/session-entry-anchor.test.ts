/**
 * 消息 → session entry id 的反查。SDK 的真实顺序是「先广播 message_end，
 * 再把消息落盘」，所以监听器当场按引用查 branch 必然落空——这里用假会话复刻
 * 这个顺序，验证延后重试确实能把锚点找回来（锚点丢了只影响跳转滚动，不该抛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  findEntryIdForMessage,
  resolveMessageEntryId,
  watchMessageEntryId,
} from "./session-entry-anchor.js";

type FakeEntry = { type: string; id: string; message?: unknown };

/** 复刻 SDK 语义：message_end 先 emit，entry 在监听器返回之后才进 branch。 */
function fakeSession(initial: FakeEntry[] = []) {
  const branch: FakeEntry[] = [...initial];
  const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
  const session = {
    branch,
    subscribe(listener: (event: { type: string; message?: unknown }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessionManager: { getBranch: () => branch },
    /** 注入一条消息：先广播、后落盘（与 SDK 同序）。 */
    inject(message: unknown): void {
      for (const listener of [...listeners]) listener({ type: "message_end", message });
      branch.push({ type: "message", id: `entry-${branch.length + 1}`, message });
    },
    /** 已落盘但没有再广播（重试路径用）。 */
    persistOnly(message: unknown): void {
      branch.push({ type: "message", id: `entry-${branch.length + 1}`, message });
    },
  };
  return session as unknown as AgentSession & typeof session;
}

const userMessage = (text: string) => ({ role: "user", content: text });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("findEntryIdForMessage", () => {
  it("已落盘的消息能按引用查到 entry id", () => {
    const message = userMessage("已经写进去了");
    const session = fakeSession();
    session.persistOnly(message);
    expect(findEntryIdForMessage(session, message)).toBe("entry-1");
    expect(findEntryIdForMessage(session, userMessage("不在会话里"))).toBeNull();
  });

  it("branch 抛错时安静返回 null", () => {
    const broken = {
      sessionManager: {
        getBranch: () => {
          throw new Error("closed");
        },
      },
      subscribe: () => () => undefined,
    } as unknown as AgentSession;
    expect(findEntryIdForMessage(broken, userMessage("x"))).toBeNull();
  });
});

describe("watchMessageEntryId", () => {
  it("命中信封后延后重试拿到 entry id（落盘晚于广播）", () => {
    const session = fakeSession();
    const found: string[] = [];
    watchMessageEntryId({
      session,
      marker: "<pixie-dispatch",
      onFound: (entryId) => found.push(entryId),
    });
    // 落盘在 emit 之后：同步查必然为空，重试才拿得到。
    session.inject(userMessage("<pixie-dispatch>做点什么</pixie-dispatch>"));
    expect(found).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(found).toEqual(["entry-1"]);
  });

  it("只认武装之后出现的消息，且只认一次", () => {
    const earlier = userMessage("<pixie-dispatch>上一条任务</pixie-dispatch>");
    const session = fakeSession([{ type: "message", id: "entry-old", message: earlier }]);
    const found: string[] = [];
    watchMessageEntryId({
      session,
      marker: "<pixie-dispatch",
      onFound: (entryId) => found.push(entryId),
    });
    const next = userMessage("<pixie-dispatch>这一条才是</pixie-dispatch>");
    session.inject(next);
    vi.advanceTimersByTime(25);
    expect(found).toEqual(["entry-2"]);
    // 命中后已退订：再注入一条不会被记成第二个锚点。
    session.inject(userMessage("<pixie-dispatch>第三条</pixie-dispatch>"));
    vi.advanceTimersByTime(2_000);
    expect(found).toEqual(["entry-2"]);
  });

  it("非 user 角色与不含标记的消息都不算", () => {
    const session = fakeSession();
    const found: string[] = [];
    watchMessageEntryId({
      session,
      marker: 'dispatchId="pix_1"',
      onFound: (entryId) => found.push(entryId),
    });
    session.inject({ role: "assistant", content: 'dispatchId="pix_1"' });
    session.inject(userMessage("<pixie-report>别的委派</pixie-report>"));
    vi.advanceTimersByTime(10_000);
    expect(found).toEqual([]);
  });

  it("取消之后不再回调", () => {
    const session = fakeSession();
    const found: string[] = [];
    const cancel = watchMessageEntryId({
      session,
      marker: "<pixie-dispatch",
      onFound: (entryId) => found.push(entryId),
    });
    cancel();
    session.inject(userMessage("<pixie-dispatch>取消之后的消息</pixie-dispatch>"));
    vi.advanceTimersByTime(60_000);
    expect(found).toEqual([]);
  });
});

describe("resolveMessageEntryId", () => {
  it("始终查不到就安静放弃（锚点留空，不影响委派本身）", () => {
    const session = fakeSession();
    const found: string[] = [];
    const message = userMessage("永远不会落盘");
    resolveMessageEntryId({ session, message, onFound: (entryId) => found.push(entryId) });
    vi.advanceTimersByTime(60_000);
    expect(found).toEqual([]);
  });

  it("延后落盘也能命中", () => {
    const session = fakeSession();
    const found: string[] = [];
    const message = userMessage("稍后才写进去");
    resolveMessageEntryId({ session, message, onFound: (entryId) => found.push(entryId) });
    session.persistOnly(message);
    vi.advanceTimersByTime(25);
    expect(found).toEqual(["entry-1"]);
  });
});
