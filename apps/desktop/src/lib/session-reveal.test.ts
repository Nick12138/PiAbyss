import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingSessionRevealForTest,
  requestSessionReveal,
  subscribeSessionReveal,
} from "./session-reveal";

const target = { workspaceId: "workspace-1", sessionId: "session-1", archived: true };

describe("session reveal requests", () => {
  beforeEach(() => clearPendingSessionRevealForTest());
  afterEach(() => {
    clearPendingSessionRevealForTest();
    vi.useRealTimers();
  });

  it("delivers a request to live subscribers and stops after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSessionReveal((request) => seen.push(request.sessionId));

    requestSessionReveal(target);
    expect(seen).toEqual(["session-1"]);

    unsubscribe();
    requestSessionReveal(target);
    expect(seen).toEqual(["session-1"]);
  });

  it("replays a fresh request to a late subscriber (list mounts after the request)", () => {
    requestSessionReveal(target);

    const seen: string[] = [];
    subscribeSessionReveal((request) => seen.push(request.sessionId));

    expect(seen).toEqual(["session-1"]);
  });

  it("does not replay a request older than the TTL", () => {
    vi.useFakeTimers();
    requestSessionReveal(target);

    vi.advanceTimersByTime(10_001);

    const seen: string[] = [];
    subscribeSessionReveal((request) => seen.push(request.sessionId));
    expect(seen).toEqual([]);
  });
});
