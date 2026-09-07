/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeTerminalSnapshots,
  mergeTerminalState,
  readTerminalStates,
  removeTerminalStates,
  type SessionTerminalStates,
} from "./session-terminal-states";

const KEY = "piabyss.sessions.terminalStates.v1";

describe("session-terminal-states persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  afterEach(() => {
    globalThis.localStorage?.clear();
  });

  it("reads an empty store", () => {
    expect(readTerminalStates()).toEqual({});
  });

  it("merges a single entry and persists it", () => {
    const next = mergeTerminalState({}, "w1", "s1", { state: "error", acknowledged: false });
    expect(next).toEqual({ w1: { s1: { state: "error", acknowledged: false } } });
    expect(readTerminalStates()).toEqual(next);
  });

  it("is a no-op when the entry is already identical", () => {
    const current: SessionTerminalStates = {
      w1: { s1: { state: "done", acknowledged: true } },
    };
    const next = mergeTerminalState(current, "w1", "s1", { state: "done", acknowledged: true });
    expect(next).toBe(current);
  });

  it("ignores malformed persisted payloads", () => {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ w1: { s1: { state: "weird" } } }));
    expect(readTerminalStates()).toEqual({});
  });

  it("removes only the requested sessions", () => {
    const current: SessionTerminalStates = {
      w1: {
        s1: { state: "done", acknowledged: false },
        s2: { state: "error", acknowledged: false },
      },
      w2: { s3: { state: "error", acknowledged: false } },
    };
    const next = removeTerminalStates(current, "w1", ["s2"]);
    expect(next.w1).toEqual({ s1: { state: "done", acknowledged: false } });
    expect(next.w2).toEqual(current.w2);
  });

  it("returns the same reference when nothing is removed", () => {
    const current: SessionTerminalStates = {
      w1: { s1: { state: "done", acknowledged: false } },
    };
    expect(removeTerminalStates(current, "w1", [])).toBe(current);
    expect(removeTerminalStates(current, "missing", ["s1"])).toBe(current);
  });

  it("merges a background Host terminal snapshot as unacknowledged", () => {
    const next = mergeTerminalSnapshots({}, "w1", {
      s1: { state: "done", generation: 4 },
    });
    expect(next.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
      generation: 4,
    });
  });

  it("keeps an acknowledgement for the same Host generation", () => {
    const current: SessionTerminalStates = {
      w1: { s1: { state: "done", acknowledged: true, generation: 4 } },
    };
    expect(
      mergeTerminalSnapshots(current, "w1", {
        s1: { state: "done", generation: 4 },
      }),
    ).toBe(current);
  });

  it("reopens the marker when the same session finishes in a later generation", () => {
    const current: SessionTerminalStates = {
      w1: { s1: { state: "done", acknowledged: true, generation: 4 } },
    };
    const next = mergeTerminalSnapshots(current, "w1", {
      s1: { state: "done", generation: 5 },
    });
    expect(next.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
      generation: 5,
    });
  });

  it("reopens newer generations without focus suppression", () => {
    // Newer generations represent fresh runs; they become unacknowledged so the
    // status dot appears and remains until the user sends a new command or switches away.
    const current: SessionTerminalStates = {
      w1: { s1: { state: "done", acknowledged: true, generation: 4 } },
    };
    const nextDone = mergeTerminalSnapshots(current, "w1", {
      s1: { state: "done", generation: 5 },
    });
    expect(nextDone.w1?.s1).toEqual({
      state: "done",
      acknowledged: false,
      generation: 5,
    });

    const nextError = mergeTerminalSnapshots(current, "w1", {
      s1: { state: "error", generation: 5 },
    });
    expect(nextError.w1?.s1).toEqual({
      state: "error",
      acknowledged: false,
      generation: 5,
    });
  });
});
