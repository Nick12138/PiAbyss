import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateSuccessResult } from "@piabyss/protocol";
import { createHostError } from "@piabyss/protocol";
import type { HandlerContext } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { IdentityState } from "./identity.js";
import { TryMutex } from "./locks.js";
import { createSessionHandlers } from "./session-controller.js";
import { sessionStorageDirs } from "./session-storage.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BACKGROUND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

describe("session.open", () => {
  it("switches to the managed session workspace and continues opening it", async () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-cross-workspace-open-"));
    try {
      const agentDir = join(root, "agent");
      const currentCwd = resolve(join(root, "current"));
      const targetCwd = resolve(join(root, "target"));
      mkdirSync(currentCwd, { recursive: true });
      mkdirSync(targetCwd, { recursive: true });
      const { activeDir } = sessionStorageDirs(agentDir, targetCwd);
      mkdirSync(activeDir, { recursive: true });
      const sessionPath = join(activeDir, `${BACKGROUND_SESSION_ID}.jsonl`);
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: BACKGROUND_SESSION_ID,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: targetCwd,
        })}\n`,
      );

      const graph = { canonicalCwd: currentCwd };
      const openedSession = { sessionId: BACKGROUND_SESSION_ID, sessionPath };
      const openSession = vi
        .fn()
        .mockResolvedValueOnce({
          error: {
            code: "SESSION_NOT_FOUND",
            message: "Session is not in the current workspace; switch workspace first",
          },
        })
        .mockResolvedValueOnce(openedSession);
      const setCurrent = vi.fn(async (cwd: string) => {
        graph.canonicalCwd = cwd;
        return { workspace: { canonicalCwd: cwd } };
      });
      const factory = {
        deps: { agentDir },
        checkIdentity: () => null,
        getGraph: () => graph,
        canonicalizeCwd: (cwd: string) => resolve(cwd),
        sessionPathsEqual: (left: string | undefined, right: string) =>
          Boolean(left) && resolve(left!).toLowerCase() === resolve(right).toLowerCase(),
        openSession,
        setCurrent,
      } as unknown as WorkspaceGraphFactory;

      const response = await createSessionHandlers(factory)["session.open"]!({
        id: "55555555-5555-4555-8555-555555555555",
        method: "session.open",
        params: { sessionPath },
        context: {},
      } as HandlerContext);

      expect(setCurrent).toHaveBeenCalledWith(targetCwd, "55555555-5555-4555-8555-555555555555");
      expect(openSession).toHaveBeenCalledTimes(2);
      expect(response).toEqual({ result: openedSession });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not switch for an unmanaged session file", async () => {
    const root = mkdtempSync(join(tmpdir(), "piabyss-unmanaged-session-open-"));
    try {
      const agentDir = join(root, "agent");
      const currentCwd = resolve(join(root, "current"));
      const targetCwd = resolve(join(root, "target"));
      mkdirSync(currentCwd, { recursive: true });
      mkdirSync(targetCwd, { recursive: true });
      const sessionPath = join(root, "unmanaged.jsonl");
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: BACKGROUND_SESSION_ID,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: targetCwd,
        })}\n`,
      );

      const notFound = {
        error: {
          code: "SESSION_NOT_FOUND" as const,
          message: "Session is not in the current workspace; switch workspace first",
        },
      };
      const setCurrent = vi.fn();
      const factory = {
        deps: { agentDir },
        checkIdentity: () => null,
        getGraph: () => ({ canonicalCwd: currentCwd }),
        canonicalizeCwd: (cwd: string) => resolve(cwd),
        sessionPathsEqual: (left: string | undefined, right: string) =>
          Boolean(left) && resolve(left!).toLowerCase() === resolve(right).toLowerCase(),
        openSession: vi.fn().mockResolvedValue(notFound),
        setCurrent,
      } as unknown as WorkspaceGraphFactory;

      const response = await createSessionHandlers(factory)["session.open"]!({
        id: "55555555-5555-4555-8555-555555555556",
        method: "session.open",
        params: { sessionPath },
        context: {},
      } as HandlerContext);

      expect(setCurrent).not.toHaveBeenCalled();
      expect(response).toEqual(notFound);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session.list runtime metadata", () => {
  it("includes the active and retained background Runtime states", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const runtimes = new Map([
      [ACTIVE_SESSION_ID, { runtimeState: "idle" as const, sessionRevision: 5 }],
      [BACKGROUND_SESSION_ID, { runtimeState: "running" as const, sessionRevision: 3 }],
    ]);
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({ workspaceId: WORKSPACE_ID }),
      listSessions: async () => [
        {
          id: ACTIVE_SESSION_ID,
          path: "C:/sessions/active.jsonl",
          name: "Active",
          cwd: "C:/workspace",
          modified: new Date(10),
          messageCount: 2,
        },
        {
          id: BACKGROUND_SESSION_ID,
          path: "C:/sessions/background.jsonl",
          name: "Background",
          cwd: "C:/workspace",
          modified: new Date(20),
          messageCount: 4,
        },
      ],
      getSessionRuntimeInfo: (sessionId: string) => runtimes.get(sessionId) ?? null,
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.list"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.list",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      workspaceId: WORKSPACE_ID,
      items: [
        expect.objectContaining({
          sessionId: ACTIVE_SESSION_ID,
          runtimeState: "idle",
          sessionRevision: 5,
        }),
        expect.objectContaining({
          sessionId: BACKGROUND_SESSION_ID,
          runtimeState: "running",
          sessionRevision: 3,
        }),
      ],
    });
  });
});

describe("session.getTree", () => {
  it("emits wire-valid nodes even when SDK labels are undefined-keyed", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        sessionManager: {
          // Mirrors SDK getTree(): unlabeled nodes still carry the keys.
          getTree: () => [
            {
              entry: {
                id: "u1",
                type: "message",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "user", content: "first ask" },
              },
              children: [
                {
                  entry: {
                    id: "a1",
                    type: "message",
                    parentId: "u1",
                    timestamp: "2026-01-01T00:00:02.000Z",
                    message: { role: "assistant", content: [] },
                  },
                  children: [],
                  label: "experiment",
                  labelTimestamp: "2026-01-01T00:00:03.000Z",
                },
              ],
              label: undefined,
              labelTimestamp: undefined,
            },
          ],
          getLeafId: () => "a1",
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getTree"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getTree",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(validateSuccessResult("session.getTree", response.result)).toMatchObject({
      ok: true,
    });
    const tree = (response.result as { tree: Record<string, unknown>[] }).tree;
    expect("label" in tree[0]!).toBe(false);
    expect("labelTimestamp" in tree[0]!).toBe(false);
    expect((tree[0]!.children as Record<string, unknown>[])[0]!.label).toBe("experiment");
  });
});

describe("session.export", () => {
  function exportFixture(isIdle: boolean) {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const agentSession = {
      isIdle,
      exportToHtml: async (path?: string) => path ?? "/exports/default.html",
      exportToJsonl: (path?: string) => path ?? "/exports/default.jsonl",
    };
    const factory = {
      getServer: () => ({ identity, serviceGraphLock: new TryMutex() }),
      checkIdentity: () => null,
      getGraph: () => ({ agentSession }),
      getSessionOperationLock: () => ({ isHeld: () => false }),
    } as unknown as WorkspaceGraphFactory;
    return factory;
  }

  it("exports html and jsonl to the requested path", async () => {
    const factory = exportFixture(true);
    const calls: Array<[string, string, string | undefined]> = [];
    (factory as unknown as { exportActiveSession: unknown }).exportActiveSession = async (
      id: string,
      format: "html" | "jsonl",
      path?: string,
    ) => {
      calls.push([id, format, path]);
      return {
        path: path ?? (format === "html" ? "/exports/default.html" : "/exports/default.jsonl"),
      };
    };
    const handler = createSessionHandlers(factory)["session.export"]!;

    const html = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.export",
      params: { format: "html", path: "/tmp/out.html" },
      context: {},
    } as HandlerContext);
    expect(html).toEqual({ result: { path: "/tmp/out.html" } });

    const jsonl = await handler({
      id: "55555555-5555-4555-8555-555555555556",
      method: "session.export",
      params: { format: "jsonl" },
      context: {},
    } as HandlerContext);
    expect(jsonl).toEqual({ result: { path: "/exports/default.jsonl" } });
    expect(calls).toEqual([
      ["55555555-5555-4555-8555-555555555555", "html", "/tmp/out.html"],
      ["55555555-5555-4555-8555-555555555556", "jsonl", undefined],
    ]);
  });

  it("routes a Session locator to the file-backed export path", async () => {
    const factory = exportFixture(true);
    const exportSession = vi.fn(async () => ({ path: "/exports/other.html" }));
    (factory as unknown as { exportSession: unknown }).exportSession = exportSession;
    const handler = createSessionHandlers(factory)["session.export"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555557",
      method: "session.export",
      params: {
        format: "html",
        sessionId: ACTIVE_SESSION_ID,
        sessionPath: "/sessions/other.jsonl",
        path: "/tmp/other.html",
      },
      context: {},
    } as HandlerContext);

    expect(response).toEqual({ result: { path: "/exports/other.html" } });
    expect(exportSession).toHaveBeenCalledWith(
      expect.any(String),
      "html",
      ACTIVE_SESSION_ID,
      "/sessions/other.jsonl",
      "/tmp/other.html",
    );
  });

  it("rejects while the active agent is busy", async () => {
    const factory = exportFixture(false);
    (factory as unknown as { exportActiveSession: unknown }).exportActiveSession = async () => ({
      error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }),
    });
    const handler = createSessionHandlers(factory)["session.export"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.export",
      params: { format: "html" },
      context: {},
    } as HandlerContext);

    expect("error" in response && response.error.code).toBe("AGENT_BUSY");
  });
});

describe("session.getForkPoints", () => {
  it("lists the session's user messages for the fork selector", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        agentSession: {
          getUserMessagesForForking: () => [
            { entryId: "u1", text: "first ask" },
            { entryId: "u2", text: "second ask" },
          ],
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getForkPoints"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getForkPoints",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      items: [
        { entryId: "u1", text: "first ask" },
        { entryId: "u2", text: "second ask" },
      ],
    });
  });
});

describe("session.getStats", () => {
  it("maps AgentSession.getSessionStats into the protocol snapshot", async () => {
    const identity = new IdentityState();
    identity.workspaceId = WORKSPACE_ID;
    identity.workspaceRevision = 1;
    identity.sessionId = ACTIVE_SESSION_ID;
    identity.sessionRevision = 5;
    const serviceGraphLock = new TryMutex();
    const factory = {
      getServer: () => ({ identity, serviceGraphLock }),
      checkIdentity: () => null,
      getGraph: () => ({
        agentSession: {
          getSessionStats: () => ({
            sessionFile: "/sessions/active.jsonl",
            sessionId: ACTIVE_SESSION_ID,
            userMessages: 4,
            assistantMessages: 5,
            toolCalls: 7,
            toolResults: 7,
            totalMessages: 16,
            tokens: {
              input: 1200,
              output: 300,
              cacheRead: 8000,
              cacheWrite: 900,
              total: 10400,
            },
            cost: 0.42,
          }),
        },
        sessionManager: {
          getEntries: () => [
            {
              type: "message",
              id: "entry-user-1",
              message: { role: "user", timestamp: 1_000 },
            },
            {
              type: "message",
              id: "entry-assistant-1",
              message: { role: "assistant", timestamp: 5_500 },
            },
            {
              type: "message",
              id: "entry-toolresult-1",
              message: { role: "toolResult", timestamp: 8_200 },
            },
            // toolResult → assistant closes a second LLM request in the turn.
            {
              type: "message",
              id: "entry-assistant-2",
              message: { role: "assistant", timestamp: 9_400 },
            },
            // Backwards timestamps (clock skew) contribute nothing.
            {
              type: "message",
              message: { role: "toolResult", timestamp: 9_000 },
            },
            // Persisted measured timing for the first assistant message.
            {
              type: "custom",
              customType: "piabyss.timing",
              id: "entry-timing-1",
              data: {
                version: 1,
                messageEntryId: "entry-assistant-1",
                firstTokenMs: 900,
                decodeMs: 3_000,
                outputTokens: 542,
              },
            },
            // A timing entry whose message left the branch folds nothing.
            {
              type: "custom",
              customType: "piabyss.timing",
              id: "entry-timing-2",
              data: {
                version: 1,
                messageEntryId: "entry-gone",
                firstTokenMs: 5_000,
                decodeMs: 9_000,
                outputTokens: 100,
              },
            },
          ],
        },
      }),
    } as unknown as WorkspaceGraphFactory;
    const handler = createSessionHandlers(factory)["session.getStats"]!;

    const response = await handler({
      id: "55555555-5555-4555-8555-555555555555",
      method: "session.getStats",
      params: null,
      context: {},
    } as HandlerContext);

    expect(response).toHaveProperty("result");
    if (!("result" in response)) return;
    expect(response.result).toEqual({
      messageCount: 16,
      toolCallCount: 7,
      userMessageCount: 4,
      assistantMessageCount: 5,
      toolResultCount: 7,
      tokens: {
        input: 1200,
        output: 300,
        cacheRead: 8000,
        cacheWrite: 900,
        total: 10400,
      },
      // user(1000) → assistant(5500) = 4500; toolResult(8200) → assistant(9400)
      // = 1200; assistant(5500) → toolResult(8200) = 2700. TTFT/decode fold
      // from the piabyss.timing custom entries whose message is still on the
      // branch: 900ms TTFT over 1 message, 3000ms decode over 542 tokens.
      timing: {
        llmMs: 5_700,
        toolMs: 2_700,
        ttftMs: 900,
        ttftSteps: 1,
        decodeMs: 3_000,
        decodeTokens: 542,
      },
      cost: 0.42,
      sessionFile: "/sessions/active.jsonl",
    });
  });
});
