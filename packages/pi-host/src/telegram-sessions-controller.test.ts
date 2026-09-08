import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MethodHandler } from "./server.js";
import { createTelegramSessionHandlers } from "./telegram-sessions-controller.js";
import { workspaceStorageKey } from "./piabyss-data.js";

/** Sessions dir of the dedicated telegram workspace (scoped scan target). */
function telegramSessionsDir(agentDir: string): string {
  return join("sessions", workspaceStorageKey(join(agentDir, "workspace", "telegram")));
}

function sessionOpen(id: string, cwd: string): string {
  return JSON.stringify({ type: "session", id, cwd, timestamp: "2026-08-18T05:01:40.000Z" });
}

function sessionInfo(name: string): string {
  return JSON.stringify({ type: "session_info", name });
}

function userMessage(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-18T05:02:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantMessage(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-18T05:03:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function telegramText(prompt: string): string {
  return `[telegram|thread:default|from:liu_nick]\n${prompt}`;
}

describe("telegram sessions controller", () => {
  let agentDir = "";
  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = "";
  });

  const handlers = (dir: string): Partial<Record<string, MethodHandler>> =>
    createTelegramSessionHandlers(dir);

  async function call(
    dir: string,
    method: "telegram.getProfiles" | "telegram.listSessions" | "telegram.status",
  ): Promise<Record<string, unknown>> {
    const response = await handlers(dir)[method]!({} as never);
    if (!("result" in response)) throw new Error("unexpected error response");
    return response.result as Record<string, unknown>;
  }

  function writeSession(path: string, lines: string[], mtimeMs: number): string {
    const full = join(agentDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `${lines.join("\n")}\n`, "utf8");
    utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
    return full;
  }

  describe("telegram.getProfiles", () => {
    it("returns the default profile when configured", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({
          profiles: { default: { botToken: "1:A", botId: 7, botUsername: "bot", botName: "B" } },
        }),
        "utf8",
      );
      expect(await call(agentDir, "telegram.getProfiles")).toEqual({
        default: {
          profile: "default",
          botId: 7,
          botUsername: "bot",
          botName: "B",
          configured: true,
        },
      });
    });
  });

  describe("telegram.listSessions", () => {
    it("returns an empty list when the sessions dir is missing", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      expect(await call(agentDir, "telegram.listSessions")).toEqual({ sessions: [] });
    });

    it("finds sessions with telegram markers and ignores plain ones", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeSession(
        join(telegramSessionsDir(agentDir), "tg-a.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/work/a"),
          sessionInfo("Telegram chat A"),
          userMessage("u1", telegramText("帮我看看这个项目")),
          assistantMessage("a1", "好的，我来看看"),
          userMessage("u2", "普通消息"),
        ],
        1_000.75, // fractional mtime must round to an integer for the protocol
      );
      writeSession(
        join(telegramSessionsDir(agentDir), "plain.jsonl"),
        [
          sessionOpen("22222222-2222-4222-8222-222222222222", "C:/work/b"),
          userMessage("u1", "没有标记"),
        ],
        2_000,
      );
      const result = (await call(agentDir, "telegram.listSessions")) as {
        sessions: Array<{
          sessionPath: string;
          sessionId?: string;
          name?: string;
          cwd?: string;
          updatedAt: number;
          telegramMessageCount: number;
          preview?: string;
        }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        name: "Telegram chat A",
        telegramMessageCount: 1,
        cwd: "C:/work/a",
      });
      expect(Number.isInteger(result.sessions[0]?.updatedAt)).toBe(true);
      expect(result.sessions[0]?.preview).toContain("帮我看看这个项目");
    });

    it("sorts sessions by last write, newest first", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeSession(
        join(telegramSessionsDir(agentDir), "old.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/w"),
          userMessage("u1", telegramText("老消息")),
        ],
        1_000,
      );
      writeSession(
        join(telegramSessionsDir(agentDir), "new.jsonl"),
        [
          sessionOpen("22222222-2222-4222-8222-222222222222", "C:/w"),
          userMessage("u1", telegramText("新消息")),
        ],
        3_000,
      );
      const result = (await call(agentDir, "telegram.listSessions")) as {
        sessions: Array<{ sessionPath: string }>;
      };
      expect(result.sessions.map((s) => s.sessionPath.split(/[\\/]/).pop())).toEqual([
        "new.jsonl",
        "old.jsonl",
      ]);
    });

    it("counts multiple telegram messages across a session", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeSession(
        join(telegramSessionsDir(agentDir), "multi.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/w"),
          userMessage("u1", telegramText("第一条")),
          assistantMessage("a1", "回复一"),
          userMessage("u2", telegramText("第二条")),
        ],
        1_000,
      );
      const result = (await call(agentDir, "telegram.listSessions")) as {
        sessions: Array<{ telegramMessageCount: number }>;
      };
      expect(result.sessions[0]?.telegramMessageCount).toBe(2);
    });

    it("ignores telegram-marked sessions living in OTHER workspaces", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      // A legacy telegram pair before the dedicated workspace existed: it must
      // stay visible only in its own folder workspace, never in the TG view.
      writeSession(
        join("sessions", "--C--work--", "legacy-tg.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/work"),
          userMessage("u1", telegramText("旧会话")),
        ],
        1_000,
      );
      writeSession(
        join(telegramSessionsDir(agentDir), "current.jsonl"),
        [
          sessionOpen("22222222-2222-4222-8222-222222222222", "C:/work"),
          userMessage("u1", telegramText("新会话")),
        ],
        2_000,
      );
      const result = (await call(agentDir, "telegram.listSessions")) as {
        sessions: Array<{ sessionPath: string }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.sessionPath).toContain("current.jsonl");
    });
  });

  describe("telegram.getConfig", () => {
    it("returns null profile, creates the workspace dir and no config blocks", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const response = await handlers(agentDir)["telegram.getConfig"]!({} as never);
      if (!("result" in response)) throw new Error("expected result");
      const result = response.result as {
        default: unknown;
        workspacePath: string;
        assistant?: unknown;
      };
      expect(result.default).toBeNull();
      expect(result.workspacePath).toBe(join(agentDir, "workspace", "telegram"));
      expect(existsSync(result.workspacePath)).toBe(true);
      expect(result.assistant).toBeUndefined();
    });

    it("returns sanitized config blocks but never the raw token", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({
          profiles: {
            default: { botToken: "1234567890:SECRET_ABCD_TAIL", botUsername: "bot", botId: 7 },
          },
          assistant: { rendering: "rich", activity: "verbose", proactivePush: false },
          voice: { replyMode: "mirror" },
          threads: { automaticCleanup: true },
          unknownExtra: "should-not-leak",
        }),
        "utf8",
      );
      const response = await handlers(agentDir)["telegram.getConfig"]!({} as never);
      if (!("result" in response)) throw new Error("expected result");
      const result = response.result as Record<string, unknown>;
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain("unknownExtra");
      expect(result.tokenMasked).toBe("12345678****TAIL");
      expect(result.default).toMatchObject({ botUsername: "bot", botId: 7, configured: true });
      expect(result.assistant).toEqual({
        rendering: "rich",
        activity: "verbose",
        proactivePush: false,
      });
      expect(result.voice).toEqual({ replyMode: "mirror" });
      expect(result.threads).toEqual({ automaticCleanup: true });
    });
  });

  describe("telegram.updateConfig", () => {
    it("merges config blocks and preserves profiles and other root fields", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({
          profiles: { default: { botToken: "T", botUsername: "bot" } },
          assistant: { rendering: "html" },
        }),
        "utf8",
      );
      const response = await handlers(agentDir)["telegram.updateConfig"]!({
        params: {
          assistant: { activity: "quiet", proactivePush: true },
          voice: { replyMode: "always" },
        },
      } as never);
      if (!("result" in response)) throw new Error("expected result");
      const saved = JSON.parse(readFileSync(join(agentDir, "telegram.json"), "utf8")) as {
        profiles: Record<string, unknown>;
        assistant: Record<string, unknown>;
        voice: Record<string, unknown>;
      };
      expect(saved.profiles.default).toEqual({ botToken: "T", botUsername: "bot" });
      expect(saved.assistant).toEqual({
        rendering: "html",
        activity: "quiet",
        proactivePush: true,
      });
      expect(saved.voice).toEqual({ replyMode: "always" });
    });

    it("creates config blocks from an empty file", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const response = await handlers(agentDir)["telegram.updateConfig"]!({
        params: { threads: { automaticCleanup: true } },
      } as never);
      if (!("result" in response)) throw new Error("expected result");
      const saved = JSON.parse(readFileSync(join(agentDir, "telegram.json"), "utf8")) as {
        threads: Record<string, unknown>;
      };
      expect(saved.threads).toEqual({ automaticCleanup: true });
    });
  });

  describe("telegram.reset", () => {
    it("removes config, temp state, workspace dir and telegram sessions only", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({ profiles: { default: {} } }),
        "utf8",
      );
      mkdirSync(join(agentDir, "tmp", "telegram", "inbox.json.segments"), { recursive: true });
      writeFileSync(
        join(agentDir, "tmp", "telegram", "inbox.json.segments", "0000000000000001.json"),
        "{}",
        "utf8",
      );
      mkdirSync(join(agentDir, "workspace", "telegram"), { recursive: true });
      writeFileSync(join(agentDir, "workspace", "telegram", "note.txt"), "x", "utf8");
      const tgSession = writeSession(
        join(telegramSessionsDir(agentDir), "tg.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/w"),
          userMessage("u1", telegramText("hi")),
        ],
        1_000,
      );
      const plainSession = writeSession(
        join(telegramSessionsDir(agentDir), "plain.jsonl"),
        [sessionOpen("22222222-2222-4222-8222-222222222222", "C:/w"), userMessage("u1", "普通")],
        1_000,
      );
      const response = await handlers(agentDir)["telegram.reset"]!({} as never);
      if (!("result" in response)) throw new Error("expected result");
      expect(existsSync(join(agentDir, "telegram.json"))).toBe(false);
      expect(existsSync(join(agentDir, "tmp", "telegram"))).toBe(false);
      expect(existsSync(join(agentDir, "workspace", "telegram"))).toBe(false);
      expect(existsSync(tgSession)).toBe(false);
      expect(existsSync(plainSession)).toBe(true);
    });
  });

  describe("telegram.saveProfile", () => {
    it("writes the default profile with token and identity", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const response = await handlers(agentDir)["telegram.saveProfile"]!({
        params: { token: "123456:ABC-DEF", botId: 7, botUsername: "bot", botName: "B" },
      } as never);
      if (!("result" in response)) throw new Error("expected result");
      const saved = JSON.parse(readFileSync(join(agentDir, "telegram.json"), "utf8")) as {
        profiles: { default: Record<string, unknown> };
      };
      expect(saved.profiles.default).toEqual({
        botToken: "123456:ABC-DEF",
        botId: 7,
        botUsername: "bot",
        botName: "B",
      });
      expect(await call(agentDir, "telegram.getProfiles")).toEqual({
        default: {
          profile: "default",
          botId: 7,
          botUsername: "bot",
          botName: "B",
          configured: true,
        },
      });
    });

    it("upserts an existing default profile and preserves other profiles", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({
          someRootFlag: true,
          profiles: {
            default: { botToken: "OLD", botUsername: "old" },
            work: { botToken: "WORK" },
          },
        }),
        "utf8",
      );
      const response = await handlers(agentDir)["telegram.saveProfile"]!({
        params: { token: "NEW", botUsername: "bot" },
      } as never);
      if (!("result" in response)) throw new Error("expected result");
      const saved = JSON.parse(readFileSync(join(agentDir, "telegram.json"), "utf8")) as {
        someRootFlag: boolean;
        profiles: { default: Record<string, unknown>; work: Record<string, unknown> };
      };
      expect(saved.someRootFlag).toBe(true);
      expect(saved.profiles.default).toEqual({ botToken: "NEW", botUsername: "bot" });
      expect(saved.profiles.work).toEqual({ botToken: "WORK" });
    });

    it("rejects an empty token", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const response = await handlers(agentDir)["telegram.saveProfile"]!({
        params: { token: "   " },
      } as never);
      if (!("error" in response)) throw new Error("expected error");
      expect(response.error.code).toBe("INVALID_REQUEST");
    });
  });

  describe("telegram.getSession", () => {
    it("returns the message records plus a fresh summary", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const path = writeSession(
        join(telegramSessionsDir(agentDir), "detail.jsonl"),
        [
          sessionOpen("11111111-1111-4111-8111-111111111111", "C:/work/a"),
          sessionInfo("Telegram chat A"),
          userMessage("u1", telegramText("你好")),
          assistantMessage("a1", "在呢 👋"),
        ],
        1_000,
      );
      const response = await handlers(agentDir)["telegram.getSession"]!({
        params: { sessionPath: path },
      } as never);
      if (!("result" in response)) throw new Error("expected result");
      const result = response.result as {
        summary: { sessionPath: string; telegramMessageCount: number };
        entries: Array<{ id: string; message: { role: string } }>;
      };
      expect(result.summary.telegramMessageCount).toBe(1);
      expect(result.entries.map((e) => e.message.role)).toEqual(["user", "assistant"]);
      expect(result.entries[0]?.id).toBe("u1");
    });

    it("rejects paths outside the sessions directory", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const response = await handlers(agentDir)["telegram.getSession"]!({
        params: { sessionPath: `${agentDir}/../evil.jsonl` },
      } as never);
      if (!("error" in response)) throw new Error("expected error");
      expect(response.error.code).toBe("INVALID_REQUEST");
    });

    it("rejects sessions without telegram messages", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      const path = writeSession(
        join(telegramSessionsDir(agentDir), "plain.jsonl"),
        [sessionOpen("11111111-1111-4111-8111-111111111111", "C:/w"), userMessage("u1", "无标记")],
        1_000,
      );
      const response = await handlers(agentDir)["telegram.getSession"]!({
        params: { sessionPath: path },
      } as never);
      if (!("error" in response)) throw new Error("expected error");
      expect(response.error.code).toBe("INVALID_REQUEST");
    });
  });

  describe("telegram.status", () => {
    it("reports disconnected when no owners file exists", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      expect(await call(agentDir, "telegram.status")).toEqual({ connected: false });
    });

    it("reports disconnected when the owner entry is missing or unparsable", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      mkdirSync(join(agentDir, "tmp", "telegram"), { recursive: true });
      writeFileSync(
        join(agentDir, "tmp", "telegram", "owners.json"),
        JSON.stringify({ other: { pid: process.pid } }),
        "utf8",
      );
      expect(await call(agentDir, "telegram.status")).toEqual({ connected: false });
    });

    it("reports disconnected when the owning process is dead", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      mkdirSync(join(agentDir, "tmp", "telegram"), { recursive: true });
      writeFileSync(
        join(agentDir, "tmp", "telegram", "owners.json"),
        JSON.stringify({ default: { pid: 2_147_483_647 } }), // PID_MAX on Linux — never alive
        "utf8",
      );
      expect(await call(agentDir, "telegram.status")).toMatchObject({ connected: false });
    });

    it("reports connected with the profile bot id for a live owner", async () => {
      agentDir = mkdtempSync(join(tmpdir(), "piabyss-tg-sess-"));
      writeFileSync(
        join(agentDir, "telegram.json"),
        JSON.stringify({
          profiles: { default: { botToken: "1:A", botId: 7, botUsername: "bot" } },
        }),
        "utf8",
      );
      mkdirSync(join(agentDir, "tmp", "telegram"), { recursive: true });
      writeFileSync(
        join(agentDir, "tmp", "telegram", "owners.json"),
        JSON.stringify({ default: { pid: process.pid, cwd: agentDir } }),
        "utf8",
      );
      expect(await call(agentDir, "telegram.status")).toEqual({
        connected: true,
        profile: "default",
        botId: 7,
        ownerPid: process.pid,
      });
    });
  });
});
