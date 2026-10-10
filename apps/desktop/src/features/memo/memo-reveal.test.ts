import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingMemoRevealForTest,
  requestMemoReveal,
  subscribeMemoReveal,
} from "./memo-reveal";

describe("memo reveal requests", () => {
  beforeEach(() => clearPendingMemoRevealForTest());
  afterEach(() => {
    clearPendingMemoRevealForTest();
    vi.useRealTimers();
  });

  it("delivers a request to live subscribers and stops after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeMemoReveal((request) => seen.push(request.noteId));

    requestMemoReveal("memo-1");
    expect(seen).toEqual(["memo-1"]);

    unsubscribe();
    requestMemoReveal("memo-1");
    expect(seen).toEqual(["memo-1"]);
  });

  it("replays a fresh request to a late subscriber (MemoPage mounts after the request)", () => {
    requestMemoReveal("memo-2");

    const seen: string[] = [];
    subscribeMemoReveal((request) => seen.push(request.noteId));

    expect(seen).toEqual(["memo-2"]);
  });

  it("does not replay a request older than the TTL", () => {
    vi.useFakeTimers();
    requestMemoReveal("memo-3");

    vi.advanceTimersByTime(10_001);

    const seen: string[] = [];
    subscribeMemoReveal((request) => seen.push(request.noteId));
    expect(seen).toEqual([]);
  });
});
