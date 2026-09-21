import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDraftPersistenceForTests,
  commitDraftSend,
  DRAFT_WRITE_DEBOUNCE_MS,
  deleteSessionDrafts,
  editDraft,
  flushDraftWrites,
  hydrateDraftWorkspace,
  restoreDraftSend,
  setDraftAttachmentSnapshot,
  settleDraftWritesWithin,
  stageDraftSend,
} from "./draft-persistence";
import type { DraftTarget, DraftWorkspaceSnapshot } from "./draft-target";
import { useAppStore } from "./stores/app-store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

const target: DraftTarget = {
  kind: "session",
  canonicalCwd: "/repo",
  sessionId: "s1",
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockResolvedValue({ applied: 1 });
  __resetDraftPersistenceForTests();
  useAppStore.setState({
    workspace: null,
    session: null,
    draftTexts: {},
    draftReferences: {},
    draftAttachments: {},
    draftTargets: {},
    draftEditVersions: {},
    draftHydratedWorkspace: null,
    notifications: [],
  });
});

afterEach(() => {
  __resetDraftPersistenceForTests();
  vi.useRealTimers();
});

describe("draft persistence queue", () => {
  it("debounces and coalesces the latest mutation for one draft", async () => {
    editDraft(target, "a");
    editDraft(target, "ab");

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_DEBOUNCE_MS - 1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushDraftWrites();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "upsert", target, text: "ab", attachments: [], references: [] }],
    });
  });

  it("batches independent draft keys and turns empty text into delete", async () => {
    const second: DraftTarget = {
      kind: "new-conversation",
      canonicalCwd: "/repo",
    };
    editDraft(target, "session");
    editDraft(second, "   ");
    await flushDraftWrites();

    expect(mocks.invoke).toHaveBeenCalledWith("desktop_drafts_apply", {
      mutations: [
        { op: "upsert", target, text: "session", attachments: [], references: [] },
        { op: "delete", target: second },
      ],
    });
  });

  it("deletes only the requested Session drafts from live and durable state", async () => {
    const second = { ...target, sessionId: "s2" };
    editDraft(target, "one");
    editDraft(second, "two");

    deleteSessionDrafts("/repo", ["s1", "s1"]);
    await flushDraftWrites();

    expect(useAppStore.getState().draftTexts["session:s1"]).toBeUndefined();
    expect(useAppStore.getState().draftTexts["session:s2"]).toBe("two");
    expect(mocks.invoke).toHaveBeenCalledWith("desktop_drafts_apply", {
      mutations: [
        { op: "delete", target },
        { op: "upsert", target: second, text: "two", attachments: [], references: [] },
      ],
    });
  });

  it("keeps a newer draft when an older send succeeds late", async () => {
    editDraft(target, "first");
    const receipt = stageDraftSend(target);
    editDraft(target, "next");

    expect(commitDraftSend(receipt)).toBe(false);
    await flushDraftWrites();
    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("next");
    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "upsert", target, text: "next", attachments: [], references: [] }],
    });
  });

  it("persists the attachment snapshot alongside the text and survives text-only edits", async () => {
    const attachments = [{ type: "document" as const, sourcePath: "/repo/a.pdf" }];
    setDraftAttachmentSnapshot(target, attachments);
    editDraft(target, "explain");
    await flushDraftWrites();

    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "upsert", target, text: "explain", attachments, references: [] }],
    });

    // A later text-only edit must carry the snapshot along (full-state upsert).
    editDraft(target, "explain again");
    await flushDraftWrites();
    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "upsert", target, text: "explain again", attachments, references: [] }],
    });
  });

  it("keeps the record alive while attachments remain after the text is cleared", async () => {
    editDraft(target, "explain");
    setDraftAttachmentSnapshot(target, [{ type: "pasted-text", text: "notes" }]);
    await flushDraftWrites();

    editDraft(target, "");
    await flushDraftWrites();
    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [
        {
          op: "upsert",
          target,
          text: "",
          attachments: [{ type: "pasted-text", text: "notes" }],
          references: [],
        },
      ],
    });

    setDraftAttachmentSnapshot(target, []);
    await flushDraftWrites();
    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "delete", target }],
    });
  });

  it("deletes Session drafts entirely (text + attachments) on session removal", async () => {
    editDraft(target, "explain");
    setDraftAttachmentSnapshot(target, [{ type: "document", sourcePath: "/repo/a.pdf" }]);
    await flushDraftWrites();

    deleteSessionDrafts("/repo", ["s1"]);
    await flushDraftWrites();

    expect(useAppStore.getState().draftTexts["session:s1"]).toBeUndefined();
    expect(useAppStore.getState().draftAttachments["session:s1"]).toBeUndefined();
    expect(mocks.invoke).toHaveBeenLastCalledWith("desktop_drafts_apply", {
      mutations: [{ op: "delete", target }],
    });
  });

  it("keeps Session switching live while the outgoing native write is unresolved", async () => {
    let resolveWrite!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    editDraft(target, "draft A");

    const outgoingWrite = flushDraftWrites();
    const second: DraftTarget = {
      kind: "session",
      canonicalCwd: "/repo",
      sessionId: "s2",
    };
    editDraft(second, "draft B");

    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("draft A");
    expect(useAppStore.getState().draftTexts["session:s2"]).toBe("draft B");

    resolveWrite({ applied: 1 });
    await outgoingWrite;
  });

  it("restores a failed send without overwriting a newer draft", () => {
    editDraft(target, "first");
    const receipt = stageDraftSend(target);
    editDraft(target, "next");

    expect(restoreDraftSend(receipt)).toBe("first\n\nnext");
    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("first\n\nnext");
  });

  it("does not let late hydration overwrite an edit", async () => {
    useAppStore.setState({
      workspace: {
        id: "w1",
        cwd: "/repo",
        canonicalCwd: "/repo",
        revision: 1,
        servicesReady: true,
      },
    });
    let resolveSnapshot!: (snapshot: DraftWorkspaceSnapshot) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise<DraftWorkspaceSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const hydration = hydrateDraftWorkspace("/repo");
    editDraft(target, "live");
    resolveSnapshot({
      schemaVersion: 1,
      drafts: [{ ...target, text: "stale", updatedAt: 1 }],
    });
    await hydration;

    expect(useAppStore.getState().draftTexts["session:s1"]).toBe("live");
  });

  it("deduplicates persistence failure notifications", async () => {
    mocks.invoke.mockRejectedValue(new Error("disk full"));
    editDraft(target, "one");
    await flushDraftWrites();
    editDraft(target, "two");
    await flushDraftWrites();

    expect(useAppStore.getState().notifications).toHaveLength(1);
    expect(useAppStore.getState().notifications[0]?.message).toContain("disk full");
  });

  it("bounds the close-time wait when a native write does not settle", async () => {
    mocks.invoke.mockReturnValueOnce(new Promise(() => {}));
    editDraft(target, "slow write");
    const completed = vi.fn();
    const settling = settleDraftWritesWithin(500).then(completed);

    await vi.advanceTimersByTimeAsync(499);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settling;

    expect(completed).toHaveBeenCalledOnce();
  });

  it("keeps representative live edits and switch flush scheduling sub-millisecond", () => {
    vi.useRealTimers();
    mocks.isTauri.mockReturnValue(false);
    const draftTexts: Record<string, string> = {};
    const draftTargets: Record<string, DraftTarget> = {};
    const draftEditVersions: Record<string, number> = {};
    for (let index = 0; index < 200; index += 1) {
      const key = `session:s${index}`;
      draftTexts[key] = `draft ${index}`;
      draftTargets[key] = { kind: "session", canonicalCwd: "/repo", sessionId: `s${index}` };
      draftEditVersions[key] = 1;
    }
    useAppStore.setState({ draftTexts, draftTargets, draftEditVersions });

    const iterations = 200;
    const editStartedAt = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) {
      useAppStore.getState().setDraftTextLocal(target, `edit ${index}`);
    }
    const averageEditMs = Number(process.hrtime.bigint() - editStartedAt) / 1_000_000 / iterations;

    let flushSchedulingMs = 0;
    for (let index = 0; index < iterations; index += 1) {
      editDraft(target, `queued ${index}`);
      const flushStartedAt = process.hrtime.bigint();
      void flushDraftWrites();
      flushSchedulingMs += Number(process.hrtime.bigint() - flushStartedAt) / 1_000_000;
      __resetDraftPersistenceForTests();
    }
    const averageFlushSchedulingMs = flushSchedulingMs / iterations;
    if (process.env.REPORT_DRAFT_PERF === "1") {
      console.info(
        `draft perf: edit=${averageEditMs.toFixed(4)}ms flush=${averageFlushSchedulingMs.toFixed(4)}ms`,
      );
    }

    expect(averageEditMs).toBeLessThan(1);
    expect(averageFlushSchedulingMs).toBeLessThan(1);
  });
});
