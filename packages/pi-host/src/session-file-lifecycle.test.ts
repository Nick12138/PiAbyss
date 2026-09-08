import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiHostServer } from "./server.js";
import { TryMutex } from "./locks.js";
import { GraphOperationRegistry } from "./operation-lifecycle.js";
import {
  WorkspaceGraphFactory,
  type GraphFactoryDeps,
  type WorkspaceGraph,
} from "./workspace-graph-factory.js";
import { sessionArchiveDir } from "./piabyss-data.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_SESSION_ID = "44444444-4444-4444-8444-444444444444";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "piabyss-session-files-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const activeDir = join(agentDir, "sessions", safePath);
  mkdirSync(activeDir, { recursive: true });

  const factory = new WorkspaceGraphFactory({ agentDir } as GraphFactoryDeps);
  const graph = {
    canonicalCwd: resolvedCwd,
    servicesReady: true,
    agentSession: null,
    sessionSnapshot: null,
    backgroundSessions: new Map(),
  } as unknown as WorkspaceGraph;
  Reflect.set(factory, "graph", graph);
  factory.bindServer({
    serviceGraphLock: new TryMutex(),
    graphOperations: new GraphOperationRegistry(),
    identity: {
      sessionId: null,
      sessionRevision: 0,
    },
  } as unknown as PiHostServer);

  return {
    root,
    cwd: resolvedCwd,
    activeDir,
    archiveDir: sessionArchiveDir(agentDir, resolvedCwd),
    factory,
    graph,
  };
}

function writeSession(dir: string, sessionId: string, cwd: string): string {
  const sessionPath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      }),
      JSON.stringify({
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        name: "Lifecycle test",
      }),
    ].join("\n") + "\n",
  );
  return sessionPath;
}

describe("Session file lifecycle", () => {
  it("projection cache invalidation makes mutations visible to session.list immediately", async () => {
    // Functional guard for the A1 wiring: if withSessionFileMutation ever
    // stops calling invalidateSessionListProjection(), the 2s dir-listing TTL
    // would keep serving the stale active projection here and this test
    // would fail (the archived session would still appear as active).
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);

    const before = await fixture.factory.listSessions();
    expect(before.map((session) => session.id)).toEqual([SESSION_ID]);

    const archived = await fixture.factory.archiveSession(
      "archive-projection-cache",
      SESSION_ID,
      sessionPath,
    );
    expect("error" in archived).toBe(false);

    const after = await fixture.factory.listSessions();
    expect(after).toEqual([expect.objectContaining({ id: SESSION_ID, archived: true })]);
  });

  it("invalidates the Workspace cache before persistent Session mutations", async () => {
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);
    let expectedSourcePath = sessionPath;
    const invalidate = vi
      .spyOn(fixture.factory, "invalidateRetainedWorkspaceGraph")
      .mockImplementation(async (canonicalCwd) => {
        expect(canonicalCwd).toBe(fixture.cwd);
        expect(existsSync(expectedSourcePath)).toBe(true);
      });

    const renamed = await fixture.factory.renameSession(
      "rename-with-invalidation",
      SESSION_ID,
      sessionPath,
      "Updated name",
    );
    expect("error" in renamed).toBe(false);

    const archived = await fixture.factory.archiveSession(
      "archive-with-invalidation",
      SESSION_ID,
      sessionPath,
    );
    expect("error" in archived).toBe(false);
    if ("error" in archived) return;
    expectedSourcePath = archived.sessionPath;

    const restored = await fixture.factory.restoreSession(
      "restore-with-invalidation",
      SESSION_ID,
      archived.sessionPath,
    );
    expect("error" in restored).toBe(false);
    if ("error" in restored) return;
    expectedSourcePath = restored.sessionPath;

    const deleted = await fixture.factory.deleteSession(
      "delete-with-invalidation",
      SESSION_ID,
      restored.sessionPath,
    );
    expect(deleted).toEqual({ sessionId: SESSION_ID, deleted: true });
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("renames inactive and archived Sessions without activating them", async () => {
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);

    const renamed = await fixture.factory.renameSession(
      "rename-active-file",
      SESSION_ID,
      sessionPath,
      "Pinned investigation",
    );
    expect(renamed).toEqual({ sessionId: SESSION_ID, name: "Pinned investigation" });
    expect(await fixture.factory.listSessions()).toEqual([
      expect.objectContaining({ id: SESSION_ID, name: "Pinned investigation" }),
    ]);

    const archived = await fixture.factory.archiveSession("archive", SESSION_ID, sessionPath);
    expect("error" in archived).toBe(false);
    if ("error" in archived) return;
    const renamedArchived = await fixture.factory.renameSession(
      "rename-archived-file",
      SESSION_ID,
      archived.sessionPath,
      "Archived investigation",
    );
    expect(renamedArchived).toEqual({
      sessionId: SESSION_ID,
      name: "Archived investigation",
    });
  });

  it("archives, lists, restores, and permanently deletes a Session", async () => {
    const fixture = createFixture();
    const originalPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);

    const archived = await fixture.factory.archiveSession("archive", SESSION_ID, originalPath);
    expect(archived).toMatchObject({ sessionId: SESSION_ID, archived: true });
    expect(existsSync(originalPath)).toBe(false);
    expect("error" in archived).toBe(false);
    if ("error" in archived) return;
    expect(archived.sessionPath).toBe(join(fixture.archiveDir, basename(originalPath)));
    expect(existsSync(archived.sessionPath)).toBe(true);
    expect(await fixture.factory.listSessions()).toEqual([
      expect.objectContaining({ id: SESSION_ID, archived: true }),
    ]);

    const restored = await fixture.factory.restoreSession(
      "restore",
      SESSION_ID,
      archived.sessionPath,
    );
    expect(restored).toEqual({
      sessionId: SESSION_ID,
      sessionPath: originalPath,
      archived: false,
    });
    expect(existsSync(originalPath)).toBe(true);

    const archivedAgain = await fixture.factory.archiveSession(
      "archive-again",
      SESSION_ID,
      originalPath,
    );
    expect("error" in archivedAgain).toBe(false);
    if ("error" in archivedAgain) return;
    const deleted = await fixture.factory.deleteSession(
      "delete",
      SESSION_ID,
      archivedAgain.sessionPath,
    );
    expect(deleted).toEqual({ sessionId: SESSION_ID, deleted: true });
    expect(await fixture.factory.listSessions()).toEqual([]);
  });

  it("permanently deletes an inactive Session without archiving it first", async () => {
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);

    const deleted = await fixture.factory.deleteSession("delete-inactive", SESSION_ID, sessionPath);

    expect(deleted).toEqual({ sessionId: SESSION_ID, deleted: true });
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("refuses to delete the active Session or a running background Runtime", async () => {
    const activeFixture = createFixture();
    const activePath = writeSession(activeFixture.activeDir, SESSION_ID, activeFixture.cwd);
    activeFixture.graph.sessionSnapshot = {
      sessionId: SESSION_ID,
      sessionPath: activePath,
    } as never;

    const activeDelete = await activeFixture.factory.deleteSession(
      "delete-active",
      SESSION_ID,
      activePath,
    );
    expect("error" in activeDelete && activeDelete.error.code).toBe("AGENT_BUSY");
    expect(existsSync(activePath)).toBe(true);

    const backgroundFixture = createFixture();
    const backgroundPath = writeSession(
      backgroundFixture.activeDir,
      SESSION_ID,
      backgroundFixture.cwd,
    );
    backgroundFixture.graph.backgroundSessions.set(SESSION_ID, {
      sessionId: SESSION_ID,
      agentSession: { isIdle: false },
      sessionSnapshot: { sessionPath: backgroundPath },
    } as never);

    const backgroundDelete = await backgroundFixture.factory.deleteSession(
      "delete-running-background",
      SESSION_ID,
      backgroundPath,
    );
    expect("error" in backgroundDelete && backgroundDelete.error.code).toBe("AGENT_BUSY");
    expect(existsSync(backgroundPath)).toBe(true);
  });

  it("rejects forged paths and Sessions owned by a Runtime", async () => {
    const fixture = createFixture();
    const sessionPath = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);
    const otherPath = writeSession(fixture.activeDir, SECOND_SESSION_ID, fixture.cwd);
    const invalidate = vi.spyOn(fixture.factory, "invalidateRetainedWorkspaceGraph");

    const forged = await fixture.factory.archiveSession("forged", SESSION_ID, otherPath);
    expect("error" in forged && forged.error.code).toBe("SESSION_NOT_FOUND");
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(otherPath)).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();

    vi.spyOn(fixture.factory, "getSessionRuntimeInfo").mockReturnValue({
      runtimeState: "idle",
      sessionRevision: 1,
    });
    const occupied = await fixture.factory.archiveSession("occupied", SESSION_ID, sessionPath);
    expect("error" in occupied && occupied.error.code).toBe("AGENT_BUSY");
    expect(existsSync(sessionPath)).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("promotes an idle cached session when its file is not yet on disk", async () => {
    const fixture = createFixture();
    const sessionPath = join(fixture.activeDir, SESSION_ID + ".jsonl");

    // Set up required graph properties that openSession checks at the start
    fixture.graph.servicesReady = true;
    fixture.graph.settingsManager = {} as never;
    fixture.graph.resourceLoader = {} as never;

    // A cached idle session must also promote directly without a disk read.
    const mockSessionSnapshot = {
      sessionId: SESSION_ID,
      sessionPath,
      sessionManager: {},
      agentSession: { isIdle: false },
    } as never;
    fixture.graph.idleSessionCache = new Map([
      [
        SESSION_ID,
        {
          sessionId: SESSION_ID,
          sessionSnapshot: mockSessionSnapshot,
          agentSession: { isIdle: true },
        } as never,
      ],
    ]);

    // Mock promoteBackgroundRuntime to return a successful result
    const promoteMock = vi
      .spyOn(fixture.factory, "promoteBackgroundRuntime")
      .mockResolvedValue({ sessionId: SESSION_ID, sessionPath } as never);

    // Ensure the session file does NOT exist on disk (simulating unpersisted session)
    const result = await fixture.factory.openSession("promote-idle-cache", sessionPath);
    expect(result).toMatchObject({
      sessionId: SESSION_ID,
    });

    expect(promoteMock).toHaveBeenCalledOnce();
  });

  it("cleans all archived Sessions and reports the count", async () => {
    const fixture = createFixture();
    const first = writeSession(fixture.activeDir, SESSION_ID, fixture.cwd);
    const second = writeSession(fixture.activeDir, SECOND_SESSION_ID, fixture.cwd);
    await fixture.factory.archiveSession("archive-first", SESSION_ID, first);
    await fixture.factory.archiveSession("archive-second", SECOND_SESSION_ID, second);
    const invalidate = vi.spyOn(fixture.factory, "invalidateRetainedWorkspaceGraph");

    const result = await fixture.factory.cleanupArchivedSessions("cleanup");

    expect(result).toEqual({ deletedCount: 2, failedCount: 0 });
    expect(await fixture.factory.listSessions()).toEqual([]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(fixture.cwd);
  });
});
