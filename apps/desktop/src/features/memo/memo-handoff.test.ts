import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftReference } from "../../lib/draft-target";
import { bindMemoHandoffsToSession, memoHandoffNoteIds } from "./memo-handoff";

const mocks = vi.hoisted(() => ({ updateMemoNote: vi.fn() }));

vi.mock("./memo-client", () => ({ updateMemoNote: mocks.updateMemoNote }));

function reference(id: string, kind: DraftReference["kind"] = "memo"): DraftReference {
  return { id, kind, label: "标题", payload: "<piabyss-memo/>" };
}

describe("memoHandoffNoteIds", () => {
  it("extracts note ids from memo reference capsules", () => {
    expect(memoHandoffNoteIds([reference("memo:n1"), reference("memo:n2")])).toEqual(["n1", "n2"]);
  });

  it("ignores quotes and ids without the memo prefix", () => {
    expect(
      memoHandoffNoteIds([
        reference("quote:abc", "quote"),
        reference("memo:"),
        reference("something-else"),
      ]),
    ).toEqual([]);
  });

  it("deduplicates repeated ids", () => {
    expect(memoHandoffNoteIds([reference("memo:n1"), reference("memo:n1")])).toEqual(["n1"]);
  });
});

describe("bindMemoHandoffsToSession", () => {
  beforeEach(() => {
    mocks.updateMemoNote.mockReset();
    mocks.updateMemoNote.mockResolvedValue({ id: "n1" });
  });

  it("marks the note as in_progress and binds the session", async () => {
    await bindMemoHandoffsToSession([reference("memo:n1")], "session-1");
    expect(mocks.updateMemoNote).toHaveBeenCalledWith("n1", {
      status: "in_progress",
      sessionId: "session-1",
      clearResult: true,
    });
  });

  it("does nothing without a session id", async () => {
    await bindMemoHandoffsToSession([reference("memo:n1")], null);
    expect(mocks.updateMemoNote).not.toHaveBeenCalled();
  });

  it("does nothing when no memo reference was sent", async () => {
    await bindMemoHandoffsToSession([reference("quote:abc", "quote")], "session-1");
    expect(mocks.updateMemoNote).not.toHaveBeenCalled();
  });

  it("swallows host failures so the send flow is unaffected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.updateMemoNote.mockRejectedValue(new Error("host down"));
    await expect(
      bindMemoHandoffsToSession([reference("memo:n1")], "session-1"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
