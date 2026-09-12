import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@piabyss/protocol";
import {
  includeActiveSession,
  canArchiveSession,
  canDeleteSession,
  canExportSession,
  canRenameSession,
  filterSessionItems,
  groupSessionItemsByTime,
  requestSessionRpcWithRetry,
  removedArchivedSessionIds,
  sessionDisplayName,
  sessionStatusDotClass,
  sessionStatusLabelKey,
  shouldRetrySessionRpc,
  shouldClearLastSessionPath,
} from "./session-list-policy";

const active = {
  sessionId: "active-session",
  sessionPath: "C:/sessions/active.jsonl",
  cwd: "C:/workspace",
  revision: 1,
  isStreaming: false,
  isIdle: true,
  isCompacting: false,
  isRetrying: false,
  thinkingLevel: "off",
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  steeringMode: "all",
  followUpMode: "all",
  pending: { revision: 0, steering: [], followUp: [] },
  messages: [{ role: "user", content: "hello" }],
  tools: {
    revision: 1,
    workspaceId: "workspace",
    sessionId: "active-session",
    sessionRevision: 1,
    tools: [],
    active: [],
  },
} satisfies SessionSnapshot;

describe("includeActiveSession", () => {
  it("keeps a blank new conversation out of the list", () => {
    expect(includeActiveSession([], { ...active, messages: [] })).toEqual([]);
  });

  it("shows an active conversation before session.list persists it", () => {
    expect(includeActiveSession([], active)).toMatchObject([
      {
        sessionId: "active-session",
        sessionPath: "C:/sessions/active.jsonl",
        messageCount: 1,
      },
    ]);
  });

  it("replaces the listed active session instead of duplicating it", () => {
    const result = includeActiveSession(
      [
        {
          sessionId: "active-session",
          sessionPath: "C:/sessions/active.jsonl",
          cwd: "C:/workspace",
          updatedAt: 123,
          messageCount: 0,
        },
      ],
      active,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ updatedAt: 123, messageCount: 1 });
  });
});

describe("sessionDisplayName", () => {
  it("uses the persisted name and falls back to the caller-provided label", () => {
    expect(sessionDisplayName({ name: "修复会话恢复" }, "新会话")).toBe("修复会话恢复");
    expect(sessionDisplayName({ name: undefined }, "新会话")).toBe("新会话");
    expect(sessionDisplayName({ name: "  " }, "New session")).toBe("New session");
  });
});

describe("sessionStatusLabelKey", () => {
  it("labels live states and unacknowledged terminal states", () => {
    expect(sessionStatusLabelKey("running", undefined)).toBe("sessionsStatusRunning");
    expect(sessionStatusLabelKey("queued", undefined)).toBe("sessionsStatusQueued");
    expect(sessionStatusLabelKey("idle", { state: "done", acknowledged: false })).toBe(
      "sessionsStatusDone",
    );
    expect(sessionStatusLabelKey("idle", { state: "error", acknowledged: false })).toBe(
      "sessionsStatusError",
    );
  });

  it("hides terminal markers once acknowledged, and quiet states return null", () => {
    expect(sessionStatusLabelKey("idle", { state: "done", acknowledged: true })).toBeNull();
    expect(sessionStatusLabelKey("idle", { state: "error", acknowledged: true })).toBeNull();
    expect(sessionStatusLabelKey("idle", undefined)).toBeNull();
    expect(sessionStatusLabelKey("inactive", undefined)).toBeNull();
  });
});

describe("sessionStatusDotClass", () => {
  it("pulses every surfaced activity state", () => {
    expect(sessionStatusDotClass("running", undefined)).toBe("bg-success status-dot-pulse");
    expect(sessionStatusDotClass("queued", undefined)).toBe("bg-warning status-dot-pulse");
    expect(sessionStatusDotClass("starting", undefined)).toBeNull();
    expect(sessionStatusDotClass("inactive", undefined)).toBeNull();
  });

  it("shows pulsing terminal states until acknowledged", () => {
    expect(sessionStatusDotClass("idle", { state: "error", acknowledged: false })).toBe(
      "bg-danger status-dot-pulse",
    );
    expect(sessionStatusDotClass("idle", { state: "done", acknowledged: false })).toBe(
      "bg-muted status-dot-pulse",
    );
    expect(sessionStatusDotClass("idle", { state: "done", acknowledged: true })).toBeNull();
    expect(sessionStatusDotClass("idle", undefined)).toBeNull();
  });

  it("falls back to a pulsing catalog error state when no marker exists", () => {
    expect(sessionStatusDotClass("error", undefined)).toBe("bg-danger status-dot-pulse");
  });
});

describe("last Session path cleanup", () => {
  it("matches only the exact Host canonical path", () => {
    expect(shouldClearLastSessionPath("/sessions/Alpha.jsonl", "/sessions/Alpha.jsonl")).toBe(true);
    expect(shouldClearLastSessionPath("/sessions/Alpha.jsonl", "/sessions/alpha.jsonl")).toBe(
      false,
    );
  });
});

describe("removedArchivedSessionIds", () => {
  it("returns only archived Sessions that actually disappeared", () => {
    expect(
      removedArchivedSessionIds(
        [
          { sessionId: "active", archived: false },
          { sessionId: "deleted", archived: true },
          { sessionId: "failed", archived: true },
        ],
        [
          { sessionId: "active", archived: false },
          { sessionId: "failed", archived: true },
        ],
      ),
    ).toEqual(["deleted"]);
  });
});

describe("canRenameSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows inactive files and idle active Sessions", () => {
    expect(canRenameSession(item, active)).toBe(true);
    expect(
      canRenameSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("allows the foreground Session while it is running but blocks retained Sessions", () => {
    expect(
      canRenameSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(true);
    expect(canRenameSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canRenameSession({ ...item, runtimeState: "idle" }, active)).toBe(false);
  });

  it("blocks archived Sessions even though their runtime state is inactive", () => {
    expect(canRenameSession({ ...item, archived: true }, null)).toBe(false);
    expect(canRenameSession({ ...item, archived: true, runtimeState: "error" }, active)).toBe(
      false,
    );
  });
});

describe("canExportSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows idle files, including archived ones and the running foreground Session only when idle", () => {
    expect(canExportSession(item, active)).toBe(true);
    expect(canExportSession({ ...item, archived: true }, active)).toBe(true);
    expect(
      canExportSession({ ...item, sessionId: active.sessionId, runtimeState: "running" }, active),
    ).toBe(true);
  });

  it("blocks Sessions that are still appending to their file", () => {
    expect(
      canExportSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
    expect(canExportSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canExportSession({ ...item, runtimeState: "queued" }, active)).toBe(false);
  });
});

describe("canDeleteSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows inactive, archived, and idle Sessions", () => {
    expect(canDeleteSession(item, active)).toBe(true);
    expect(canDeleteSession({ ...item, archived: true }, active)).toBe(true);
    expect(canDeleteSession({ ...item, runtimeState: "idle" }, active)).toBe(true);
    expect(canDeleteSession({ ...item, runtimeState: "error" }, active)).toBe(true);
  });

  it("allows the currently viewed Session while it is idle", () => {
    expect(
      canDeleteSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("blocks Sessions whose Runtime is busy", () => {
    expect(canDeleteSession({ ...item, runtimeState: "starting" }, active)).toBe(false);
    expect(canDeleteSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canDeleteSession({ ...item, runtimeState: "queued" }, active)).toBe(false);
    expect(
      canDeleteSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
  });
});

describe("canArchiveSession", () => {
  const item = {
    sessionId: "inactive-session",
    sessionPath: "C:/sessions/inactive.jsonl",
    cwd: "C:/workspace",
    updatedAt: 1,
    runtimeState: "inactive" as const,
  };

  it("allows idle Sessions including the currently viewed one", () => {
    expect(canArchiveSession(item, active)).toBe(true);
    expect(canArchiveSession({ ...item, runtimeState: "idle" }, active)).toBe(true);
    expect(
      canArchiveSession({ ...item, sessionId: active.sessionId, runtimeState: "idle" }, active),
    ).toBe(true);
  });

  it("blocks archived files and busy Runtimes", () => {
    expect(canArchiveSession({ ...item, archived: true }, active)).toBe(false);
    expect(canArchiveSession({ ...item, runtimeState: "running" }, active)).toBe(false);
    expect(canArchiveSession({ ...item, runtimeState: "queued" }, active)).toBe(false);
    expect(
      canArchiveSession(
        { ...item, sessionId: active.sessionId, runtimeState: "running" },
        { ...active, isIdle: false },
      ),
    ).toBe(false);
  });
});

describe("filterSessionItems", () => {
  const items = [
    {
      sessionId: "repair-session",
      sessionPath: "C:/sessions/repair.jsonl",
      name: "Repair reconnect",
      cwd: "C:/workspace/alpha",
      updatedAt: 2,
      runtimeState: "running" as const,
    },
    {
      sessionId: "tests-session",
      sessionPath: "C:/sessions/tests.jsonl",
      cwd: "C:/workspace/beta",
      updatedAt: 1,
      runtimeState: "inactive" as const,
    },
    {
      sessionId: "archived-session",
      sessionPath: "C:/sessions/.archive/archived.jsonl",
      name: "Old investigation",
      cwd: "C:/workspace/alpha",
      updatedAt: 0,
      archived: true,
      runtimeState: "inactive" as const,
    },
  ];

  it("keeps archived Sessions out of the active view", () => {
    expect(filterSessionItems(items, "active")).toEqual(items.slice(0, 2));
    expect(filterSessionItems(items, "archived")).toEqual([items[2]]);
  });
});

describe("groupSessionItemsByTime", () => {
  const makeItem = (sessionId: string, createdAt: number) => ({
    sessionId,
    sessionPath: `C:/sessions/${sessionId}.jsonl`,
    cwd: "C:/workspace/alpha",
    createdAt,
    updatedAt: createdAt,
    runtimeState: "inactive" as const,
  });

  it("buckets items into today, this week, and earlier", () => {
    // Wed 2024-05-15 12:00 local
    const now = new Date(2024, 4, 15, 12, 0, 0).getTime();
    const todayMs = new Date(2024, 4, 15, 9, 0, 0).getTime();
    const thisWeekMs = new Date(2024, 4, 14, 9, 0, 0).getTime();
    const lastWeekMs = new Date(2024, 4, 1, 9, 0, 0).getTime();

    const result = groupSessionItemsByTime(
      [makeItem("earlier", lastWeekMs), makeItem("today", todayMs), makeItem("week", thisWeekMs)],
      now,
    );

    expect(result.map(({ group }) => group)).toEqual(["today", "thisWeek", "earlier"]);
    expect(result[0].items.map((i) => i.sessionId)).toEqual(["today"]);
    expect(result[1].items.map((i) => i.sessionId)).toEqual(["week"]);
    expect(result[2].items.map((i) => i.sessionId)).toEqual(["earlier"]);
  });

  it("returns all buckets in stable order, including empty ones", () => {
    const now = new Date(2024, 4, 15, 12, 0, 0).getTime();
    const todayMs = new Date(2024, 4, 15, 9, 0, 0).getTime();
    const result = groupSessionItemsByTime([makeItem("today", todayMs)], now);
    expect(result.map(({ group }) => group)).toEqual(["today", "thisWeek", "earlier"]);
    expect(result[1].items).toEqual([]);
    expect(result[2].items).toEqual([]);
  });

  it("considers the start of the current week (Monday) as thisWeek boundary", () => {
    // Friday 2024-05-17 12:00; Monday of this week is 05-13
    const now = new Date(2024, 4, 17, 12, 0, 0).getTime();
    const mondayMs = new Date(2024, 4, 13, 23, 59, 0).getTime();
    const sundayPrevMs = new Date(2024, 4, 12, 23, 59, 0).getTime();
    const result = groupSessionItemsByTime(
      [makeItem("monday", mondayMs), makeItem("sunday", sundayPrevMs)],
      now,
    );
    expect(result[0].group).toBe("today");
    expect(result[0].items).toEqual([]);
    expect(result[1].group).toBe("thisWeek");
    expect(result[1].items.map((i) => i.sessionId)).toEqual(["monday"]);
    expect(result[2].group).toBe("earlier");
    expect(result[2].items.map((i) => i.sessionId)).toEqual(["sunday"]);
  });
});

describe("shouldRetrySessionRpc", () => {
  it("retries only transient graph-lock contention", () => {
    expect(shouldRetrySessionRpc({ code: "SERVICE_GRAPH_BUSY", retryable: true })).toBe(true);
    expect(shouldRetrySessionRpc({ code: "SERVICE_GRAPH_BUSY", retryable: false })).toBe(false);
    expect(shouldRetrySessionRpc({ code: "STALE_REVISION", retryable: true })).toBe(false);
  });

  it("keeps retrying lock contention until a successful list arrives", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { items: ["old-session"] } });
    const wait = vi.fn(async () => {});

    const result = await requestSessionRpcWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { items: ["old-session"] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });
});
