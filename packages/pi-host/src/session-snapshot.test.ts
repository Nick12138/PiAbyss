import { describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { validateSuccessResult } from "@piabyss/protocol";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import { buildSessionSnapshot, refreshActiveSessionSnapshot } from "./session-snapshot.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function sessionFixture(
  messages: unknown[] = [],
  overrides: Record<string, unknown> = {},
): AgentSession {
  return {
    sessionId: SESSION_ID,
    sessionFile: undefined,
    sessionName: undefined,
    cwd: "C:/workspace",
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    model: undefined,
    messages,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
    ...overrides,
  } as unknown as AgentSession;
}

function snapshotFixture(messages: unknown[]) {
  return buildSessionSnapshot({
    session: sessionFixture(messages),
    sessionManager: {} as SessionManager,
    cwd: "C:/workspace",
    sessionId: SESSION_ID,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    toolRevision: 1,
  });
}

describe("buildSessionSnapshot message projection", () => {
  it.each([
    [
      "compactionSummary",
      {
        role: "compactionSummary",
        summary: "Earlier context",
        tokensBefore: 12_000,
        timestamp: 1_759_276_800_000,
      },
    ],
    [
      "branchSummary",
      {
        role: "branchSummary",
        summary: "Returned branch",
        fromId: "entry-1",
        timestamp: 1_759_276_800_001,
      },
    ],
    [
      "bashExecution",
      {
        role: "bashExecution",
        command: "pwd",
        output: "C:/workspace",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1_759_276_800_002,
      },
    ],
  ])("adds wire content to SDK %s messages", (_role, message) => {
    const snapshot = snapshotFixture([message]);

    expect(snapshot.messages).toEqual([{ ...message, content: "" }]);
    expect(Object.hasOwn(message, "content")).toBe(false);
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });

  it("preserves existing string and array content", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    const snapshot = snapshotFixture(messages);

    expect(snapshot.messages).toEqual(messages);
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });

  it.each([null, 42])("does not mask an existing invalid content value %#", (content) => {
    const snapshot = snapshotFixture([{ role: "compactionSummary", summary: "Earlier", content }]);

    expect(snapshot.messages[0]).toHaveProperty("content", content);
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: false });
  });
});

describe("refreshActiveSessionSnapshot", () => {
  it("includes assistant progress produced while the Host route was inactive", () => {
    const cached = snapshotFixture([{ role: "user", content: "Start" }]);
    const streamingMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Latest partial reply" }],
    };
    const graph = {
      workspaceId: WORKSPACE_ID,
      canonicalCwd: "C:/workspace",
      agentSession: sessionFixture([{ role: "user", content: "Start" }], {
        isIdle: false,
        agent: { state: { streamingMessage } },
      }),
      sessionManager: {} as SessionManager,
      sessionSnapshot: cached,
      toolRevision: 1,
    } as WorkspaceGraph;

    const refreshed = refreshActiveSessionSnapshot(graph);

    expect(refreshed?.messages).toHaveLength(2);
    expect(refreshed?.messages[1]).toEqual(streamingMessage);
    expect(refreshed?.isStreaming).toBe(true);
    expect(graph.sessionSnapshot).toBe(refreshed);
  });
});

describe("buildSessionSnapshot entry projection", () => {
  it("projects registered Extension message renderer output by entry id", () => {
    const entries = [
      {
        id: "custom-1",
        type: "custom_message",
        parentId: null,
        timestamp: "2026-08-01T00:00:00.000Z",
        customType: "diagnostic",
        content: "raw",
        display: true,
      },
    ];
    const sessionManager = {
      buildContextEntries: vi.fn(() => entries),
      getLeafId: vi.fn(() => "custom-1"),
    } as unknown as SessionManager;
    const renderer = vi.fn((_message, options: { expanded: boolean }) => ({
      render: () => [options.expanded ? "full diagnostic" : "diagnostic"],
      invalidate: () => undefined,
    }));
    const session = sessionFixture([], {
      extensionRunner: { getMessageRenderer: () => renderer },
    });

    const snapshot = buildSessionSnapshot({
      session,
      sessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      toolRevision: 1,
    });

    expect(snapshot.extensionMessageRenders).toEqual({
      "custom-1": {
        version: 1,
        collapsed: ["diagnostic"],
        expanded: ["full diagnostic"],
        messageIndex: 0,
      },
    });
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });

  it("uses the SDK's active compaction-aware path and serializes its leaf", () => {
    const entries = [
      {
        id: "compaction-1",
        type: "compaction",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "Earlier context",
        firstKeptEntryId: "message-1",
        tokensBefore: 123,
        details: { extensionState: 1n },
      },
      {
        id: "message-1",
        type: "message",
        parentId: "compaction-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Continue" },
      },
    ];
    const sessionManager = {
      buildContextEntries: vi.fn(() => entries),
      getLeafId: vi.fn(() => "message-1"),
      getEntries: vi.fn(() => [{ id: "not-on-active-path", type: "message" }]),
    } as unknown as SessionManager;

    const snapshot = buildSessionSnapshot({
      session: sessionFixture(),
      sessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 4,
      workspaceId: WORKSPACE_ID,
      toolRevision: 2,
    });

    expect(sessionManager.buildContextEntries).toHaveBeenCalledOnce();
    expect(sessionManager.getLeafId).toHaveBeenCalledOnce();
    expect(sessionManager.getEntries).not.toHaveBeenCalled();
    expect(snapshot.leafId).toBe("message-1");
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        id: "compaction-1",
        type: "compaction",
        details: { extensionState: "1" },
      }),
      expect.objectContaining({ id: "message-1", type: "message" }),
    ]);
  });

  it("omits the optional path for an older session-manager-shaped test double", () => {
    const snapshot = buildSessionSnapshot({
      session: sessionFixture(),
      sessionManager: {} as SessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      toolRevision: 1,
    });

    expect(snapshot).not.toHaveProperty("entries");
    expect(snapshot).not.toHaveProperty("leafId");
  });

  it("omits duplicate entries and image data to stay within its projection budget", () => {
    const session = sessionFixture([
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "i".repeat(1_000) }],
      },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ]);
    const sessionManager = {
      buildContextEntries: vi.fn(() => [
        {
          id: "message-1",
          type: "message",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "e".repeat(1_000) },
        },
      ]),
      getLeafId: vi.fn(() => "message-1"),
    } as unknown as SessionManager;
    const maxSnapshotBytes = 1_400;

    const snapshot = buildSessionSnapshot({
      session,
      sessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 4,
      workspaceId: WORKSPACE_ID,
      toolRevision: 2,
      maxSnapshotBytes,
    });

    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      maxSnapshotBytes,
    );
    expect(snapshot).not.toHaveProperty("entries");
    expect(snapshot).not.toHaveProperty("leafId");
    expect(sessionManager.buildContextEntries).not.toHaveBeenCalled();
    expect(sessionManager.getLeafId).not.toHaveBeenCalled();
    expect(snapshot.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Image omitted from desktop snapshot: size limit]",
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ]);
    expect((session.messages[0] as { content: unknown[] }).content[0]).toMatchObject({
      type: "image",
      data: expect.any(String),
    });
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });

  it("retains only a recent message suffix when text alone exceeds the budget", () => {
    const messages = [
      { role: "user", content: "old-1".repeat(100) },
      { role: "assistant", content: "old-2".repeat(100) },
      { role: "user", content: "newest".repeat(100) },
    ];
    const sessionManager = {} as SessionManager;
    const common = {
      sessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 1,
      workspaceId: WORKSPACE_ID,
      toolRevision: 1,
    };
    const emptySnapshot = buildSessionSnapshot({
      ...common,
      session: sessionFixture(),
    });
    const maxSnapshotBytes =
      Buffer.byteLength(JSON.stringify(emptySnapshot), "utf8") +
      Buffer.byteLength(JSON.stringify(messages.at(-1)), "utf8");

    const snapshot = buildSessionSnapshot({
      ...common,
      session: sessionFixture(messages),
      maxSnapshotBytes,
    });

    expect(snapshot.messages).toEqual([messages.at(-1)]);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      maxSnapshotBytes,
    );
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });

  it("falls back to minimal queue and tool projections when metadata exceeds the budget", () => {
    const queuedText = "q".repeat(2_000);
    const toolDescription = "d".repeat(2_000);
    const session = sessionFixture([], {
      getSteeringMessages: () => [queuedText],
      getAllTools: () => [{ name: "large-tool", description: toolDescription }],
      getActiveToolNames: () => ["large-tool"],
    });
    const maxSnapshotBytes = 900;

    const snapshot = buildSessionSnapshot({
      session,
      sessionManager: {} as SessionManager,
      cwd: "C:/workspace",
      sessionId: SESSION_ID,
      revision: 3,
      workspaceId: WORKSPACE_ID,
      toolRevision: 2,
      maxSnapshotBytes,
    });

    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      maxSnapshotBytes,
    );
    expect(snapshot.pending).toEqual({ revision: 0, steering: [], followUp: [] });
    expect(snapshot.tools).toMatchObject({ revision: 2, tools: [], active: [] });
    expect(session.getSteeringMessages()).toEqual([queuedText]);
    expect(session.getAllTools()).toEqual([
      expect.objectContaining({ name: "large-tool", description: toolDescription }),
    ]);
    expect(validateSuccessResult("session.getSnapshot", snapshot)).toMatchObject({ ok: true });
  });
});
