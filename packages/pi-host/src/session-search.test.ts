import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSnippet,
  normalizeQueryTerms,
  resetSessionSearchCaches,
  searchSessions,
} from "./session-search.js";
import { createTempAgentLayout, type TempAgentLayout } from "./test-helpers/temp-agent.js";

type SessionFixture = {
  id?: string;
  cwd: string;
  name?: string;
  messages?: Array<{ role: string; content: unknown }>;
  rawLines?: string[];
};

function writeSessionFile(dir: string, fileName: string, fixture: SessionFixture): string {
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  if (fixture.rawLines) {
    lines.push(...fixture.rawLines);
  } else {
    lines.push(
      JSON.stringify({
        type: "session",
        version: 3,
        id: fixture.id ?? randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: fixture.cwd,
      }),
    );
    if (fixture.name !== undefined) {
      lines.push(JSON.stringify({ type: "session_info", id: "info", name: fixture.name }));
    }
    for (const message of fixture.messages ?? []) {
      lines.push(JSON.stringify({ type: "message", id: randomUUID(), message }));
    }
  }
  const path = join(dir, fileName);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function userText(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("session-search", () => {
  let layout: TempAgentLayout;
  let activeRoot: string;
  let archiveRoot: string;

  beforeEach(() => {
    resetSessionSearchCaches();
    layout = createTempAgentLayout("piabyss-search-");
    activeRoot = join(layout.agentDir, "sessions");
    archiveRoot = join(layout.agentDir, "piabyss", "session-archive");
  });

  afterEach(() => {
    layout.cleanup();
  });

  it("finds message text across workspaces and reports each session cwd", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("how do I fix the login timeout?")],
    });
    writeSessionFile(join(activeRoot, "--proj-b--"), "b.jsonl", {
      cwd: "/proj/b",
      messages: [assistantText("the database layer needs refactoring")],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "login" });
    expect(report.scannedCount).toBe(2);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.cwd).toBe("/proj/a");
    expect(report.items[0]?.matches[0]?.role).toBe("user");
    expect(report.items[0]?.matches[0]?.snippet).toContain("login timeout");

    const other = await searchSessions({ agentDir: layout.agentDir, query: "database" });
    expect(other.items).toHaveLength(1);
    expect(other.items[0]?.cwd).toBe("/proj/b");
  });

  it("matches all terms case-insensitively within one block", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("how do I fix the login timeout?")],
    });

    const both = await searchSessions({ agentDir: layout.agentDir, query: "LOGIN Timeout" });
    expect(both.items).toHaveLength(1);

    const across = await searchSessions({ agentDir: layout.agentDir, query: "login database" });
    expect(across.items).toHaveLength(0);
  });

  it("matches CJK substrings", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("帮我修复登录超时问题")],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "登录超时" });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.matches[0]?.snippet).toContain("登录超时");
  });

  it("reports name-only matches with nameMatched and no snippets", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      name: "billing dashboard",
      messages: [userText("unrelated content")],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "billing" });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.nameMatched).toBe(true);
    expect(report.items[0]?.matchCount).toBe(0);
    expect(report.items[0]?.matches).toHaveLength(0);
  });

  it("includes archived sessions unless excluded", async () => {
    writeSessionFile(join(archiveRoot, "--proj-a--"), "old.jsonl", {
      cwd: "/proj/a",
      messages: [userText("the zebra migration plan")],
    });

    const withArchive = await searchSessions({ agentDir: layout.agentDir, query: "zebra" });
    expect(withArchive.items).toHaveLength(1);
    expect(withArchive.items[0]?.archived).toBe(true);

    const withoutArchive = await searchSessions({
      agentDir: layout.agentDir,
      query: "zebra",
      includeArchived: false,
    });
    expect(withoutArchive.items).toHaveLength(0);
    expect(withoutArchive.scannedCount).toBe(0);
  });

  it("does not search thinking or toolResult content", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "secret plan about xylophones" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "xylophones found in output" }],
        },
      ],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "xylophones" });
    expect(report.items).toHaveLength(0);
  });

  it("skips malformed files and counts only parseable sessions in results", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "broken.jsonl", {
      cwd: "/ignored",
      rawLines: ["not json at all", JSON.stringify({ type: "message" })],
    });
    writeSessionFile(join(activeRoot, "--proj-a--"), "ok.jsonl", {
      cwd: "/proj/a",
      messages: [userText("findable marker")],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "marker" });
    expect(report.scannedCount).toBe(2);
    expect(report.items).toHaveLength(1);
  });

  it("sorts by recency, applies the limit, and flags truncation", async () => {
    const dir = join(activeRoot, "--proj-a--");
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const path = writeSessionFile(dir, `s${index}.jsonl`, {
        cwd: "/proj/a",
        name: `session ${index}`,
        messages: [userText("shared needle text")],
      });
      const seconds = (now - (2 - index) * 60_000) / 1000;
      utimesSync(path, seconds, seconds);
    }

    const report = await searchSessions({ agentDir: layout.agentDir, query: "needle", limit: 2 });
    expect(report.truncated).toBe(true);
    expect(report.items).toHaveLength(2);
    expect(report.items[0]?.name).toBe("session 2");
    expect(report.items[1]?.name).toBe("session 1");
  });

  it("caps reported snippets while counting every matching block", async () => {
    writeSessionFile(join(activeRoot, "--proj-a--"), "a.jsonl", {
      cwd: "/proj/a",
      messages: [
        userText("needle one"),
        assistantText("needle two"),
        userText("needle three"),
        assistantText("needle four"),
      ],
    });

    const report = await searchSessions({ agentDir: layout.agentDir, query: "needle" });
    expect(report.items[0]?.matchCount).toBe(4);
    expect(report.items[0]?.matches).toHaveLength(3);
  });

  it("keeps a briefly stale snapshot after deletion and recovers cleanly", async () => {
    const dir = join(activeRoot, "--proj-a--");
    const path = writeSessionFile(dir, "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("ephemeral quokka note")],
    });

    const before = await searchSessions({ agentDir: layout.agentDir, query: "quokka" });
    expect(before.items).toHaveLength(1);

    rmSync(path);
    // Within STAT_TTL_MS the memoized snapshot may still surface the session;
    // the search must not fail on the missing file.
    const stale = await searchSessions({ agentDir: layout.agentDir, query: "quokka" });
    expect(stale.items.length).toBeLessThanOrEqual(1);

    resetSessionSearchCaches();
    const after = await searchSessions({ agentDir: layout.agentDir, query: "quokka" });
    expect(after.items).toHaveLength(0);
  });

  it("picks up file changes after a cached search", async () => {
    const dir = join(activeRoot, "--proj-a--");
    const path = writeSessionFile(dir, "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("original content")],
    });

    const before = await searchSessions({ agentDir: layout.agentDir, query: "kumquat" });
    expect(before.items).toHaveLength(0);

    writeSessionFile(dir, "a.jsonl", {
      cwd: "/proj/a",
      messages: [userText("original content"), userText("fresh kumquat mention")],
    });
    const future = (Date.now() + 5_000) / 1000;
    utimesSync(path, future, future);
    // Stat results are memoized briefly between debounced keystrokes; clearing
    // the caches simulates that TTL expiring before the next search.
    resetSessionSearchCaches();

    const after = await searchSessions({ agentDir: layout.agentDir, query: "kumquat" });
    expect(after.items).toHaveLength(1);
  });
});

describe("normalizeQueryTerms", () => {
  it("lowercases, dedupes, and caps terms", () => {
    expect(normalizeQueryTerms("  Foo   BAR foo ")).toEqual(["foo", "bar"]);
    expect(normalizeQueryTerms("a b c d e f g h i j")).toHaveLength(8);
    expect(normalizeQueryTerms("   ")).toEqual([]);
  });
});

describe("buildSnippet", () => {
  it("collapses whitespace and anchors on the first term", () => {
    const padding = "x".repeat(300);
    const text = `${padding}\n\n  the   TARGET word  \n${padding}`;
    const snippet = buildSnippet(text, "target");
    expect(snippet).toContain("TARGET");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("\n");
  });

  it("falls back to the head of the text when the term is absent", () => {
    const snippet = buildSnippet("short text", "missing");
    expect(snippet).toBe("short text");
  });
});
