import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateSessionListProjection,
  listSessionProjectionsFromDir,
  resetSessionListProjectionCachesForTests,
  sessionListProjectionParseCountForTests,
  type SessionListProjection,
} from "./session-list-projection.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const HEADER_TIMESTAMP = "2026-02-01T10:00:00.000Z";
const CREATED_MS = Date.parse(HEADER_TIMESTAMP);
const MESSAGE_TIMESTAMP = Date.parse("2026-02-01T10:00:05.000Z");

let root: string;
let dir: string;

beforeEach(() => {
  resetSessionListProjectionCachesForTests();
  root = mkdtempSync(join(tmpdir(), "piabyss-session-projection-"));
  dir = join(root, "sessions-dir");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  resetSessionListProjectionCachesForTests();
  rmSync(root, { recursive: true, force: true });
});

function writeLines(fileName: string, lines: unknown[]): string {
  const path = join(dir, fileName);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function sessionHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: HEADER_TIMESTAMP,
    cwd: root,
    ...overrides,
  };
}

function userMessage(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-02-01T10:00:01.000Z",
    message: { role: "user", content: text, timestamp: MESSAGE_TIMESTAMP },
    ...overrides,
  };
}

async function listDir(): Promise<SessionListProjection[]> {
  return listSessionProjectionsFromDir(dir);
}

describe("session-list-projection", () => {
  it("parses header, name, and message fields on the first listing", async () => {
    writeLines("a.jsonl", [
      sessionHeader({ parentSession: join(root, "parent.jsonl") }),
      { type: "session_info", id: "info-1", name: "  Fancy name  " },
      userMessage("hello world"),
      {
        type: "message",
        id: "m2",
        timestamp: "2026-02-01T10:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      },
      "not json at all",
      {
        type: "message",
        id: "m3",
        message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      },
      {
        type: "message",
        id: "m4",
        message: { role: "user", content: [{ type: "text", text: "second question" }] },
      },
    ]);

    const [projection] = await listDir();
    expect(projection).toMatchObject({
      path: join(dir, "a.jsonl"),
      id: SESSION_ID,
      cwd: root,
      name: "Fancy name",
      parentSessionPath: join(root, "parent.jsonl"),
      createdMs: CREATED_MS,
      modifiedMs: MESSAGE_TIMESTAMP,
      messageCount: 4,
      firstMessage: "hello world",
    });
  });

  it("defaults name, firstMessage, and modifiedMs for a bare session file", async () => {
    writeLines("bare.jsonl", [sessionHeader({ cwd: root })]);

    const [projection] = await listDir();
    expect(projection).toMatchObject({
      id: SESSION_ID,
      createdMs: CREATED_MS,
      modifiedMs: CREATED_MS,
      messageCount: 0,
      firstMessage: "(no messages)",
    });
    expect(projection).not.toHaveProperty("name");
    expect(projection).not.toHaveProperty("parentSessionPath");
  });

  it("serves the second listing from cache and returns cloned projections", async () => {
    writeLines("a.jsonl", [sessionHeader({ cwd: root }), userMessage("cache me")]);

    const [first] = await listDir();
    const parsesAfterFirst = sessionListProjectionParseCountForTests();

    const [second] = await listDir();
    expect(sessionListProjectionParseCountForTests()).toBe(parsesAfterFirst);
    expect(second).toEqual(first);

    // Mutating a returned projection must not poison the cache.
    first!.name = "poisoned";
    first!.messageCount = 999;
    const [third] = await listDir();
    expect(third).toEqual(second);
    expect(third).not.toHaveProperty("name", "poisoned");
  });

  it("re-parses when the file's size/mtime signature changes", async () => {
    writeLines("a.jsonl", [sessionHeader({ cwd: root }), userMessage("v1")]);
    const [before] = await listDir();
    expect(before!.messageCount).toBe(1);
    const parsesBefore = sessionListProjectionParseCountForTests();

    writeLines("a.jsonl", [
      sessionHeader({ cwd: root }),
      userMessage("v1"),
      userMessage("v2"),
    ]);

    // Expire the shared stat snapshot (2s TTL) without clearing any caches:
    // the projection must notice the new size/mtime signature and re-parse.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      const [after] = await listDir();
      expect(after!.messageCount).toBe(2);
      expect(after!.firstMessage).toBe("v1");
      expect(sessionListProjectionParseCountForTests()).toBeGreaterThan(parsesBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reflects a rename after invalidateSessionListProjection", async () => {
    const pathA = writeLines("a.jsonl", [sessionHeader({ cwd: root }), userMessage("renamed later")]);
    await listDir();
    const pathB = join(dir, "b.jsonl");
    renameSync(pathA, pathB);

    // Without invalidation the briefly cached listing still serves the old name.
    const stale = await listDir();
    expect(stale.map((projection) => projection.path)).toContain(pathA);

    invalidateSessionListProjection(pathA);
    const fresh = await listDir();
    expect(fresh.map((projection) => projection.path)).toEqual([pathB]);
    expect(fresh[0]!.id).toBe(SESSION_ID);

    // Full clear also works and keeps the listing correct.
    invalidateSessionListProjection();
    expect((await listDir()).map((projection) => projection.path)).toEqual([pathB]);
  });

  it("tolerates non-session files, empty files, and ignores non-JSONL entries", async () => {
    writeLines("good.jsonl", [sessionHeader({ cwd: root }), userMessage("findable")]);
    writeLines("empty.jsonl", []);
    // First parseable line is not a session header -> not a session.
    writeLines("garbage-first.jsonl", ["not json at all", { type: "message", id: "m1" }]);
    writeLines("message-first.jsonl", [{ type: "message", id: "m1", message: { role: "user" } }]);
    writeFileSync(join(dir, "notes.txt"), "ignored");
    mkdirSync(join(dir, "sub.jsonl"), { recursive: true });

    const projections = await listDir();
    expect(projections.map((projection) => projection.id)).toEqual([SESSION_ID]);
    expect(projections[0]!.firstMessage).toBe("findable");

    // Negative results (garbage/empty files) are cached too: no re-parse.
    const parses = sessionListProjectionParseCountForTests();
    expect(await listDir()).toEqual(projections);
    expect(sessionListProjectionParseCountForTests()).toBe(parses);
  });

  it("falls back to filesystem timestamps when the header has no timestamp", async () => {
    const path = writeLines("no-ts.jsonl", [
      { type: "session", version: 3, id: SESSION_ID, cwd: root },
    ]);

    const [projection] = await listDir();
    const fileStat = statSync(path);
    expect(projection!.modifiedMs).toBe(fileStat.mtimeMs);
    const candidates = [fileStat.birthtimeMs, fileStat.ctimeMs, fileStat.mtimeMs].filter(
      (value) => Number.isFinite(value) && value > 0,
    );
    expect(candidates).toContain(projection!.createdMs);
  });

  it("returns [] for a missing directory", async () => {
    expect(await listSessionProjectionsFromDir(join(root, "does-not-exist"))).toEqual([]);
  });
});
