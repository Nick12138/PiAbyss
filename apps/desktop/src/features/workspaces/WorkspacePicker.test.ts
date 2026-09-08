import { describe, expect, it } from "vitest";
import type { HostActivitySummary } from "../../lib/bridge/tauri-transport";
import {
  addKnownWorkspace,
  replaceKnownWorkspace,
  removeKnownWorkspace,
  summarizeWorkspaceActivity,
  workspaceDisplayName,
} from "./WorkspacePicker";

describe("known workspace list", () => {
  it("appends new paths and keeps insertion order", () => {
    const list = addKnownWorkspace(["C:\\repos\\alpha"], "C:\\repos\\beta");
    expect(list).toEqual(["C:\\repos\\alpha", "C:\\repos\\beta"]);
  });

  it("preserves differently-cased canonical paths", () => {
    const list = addKnownWorkspace(["/repos/Alpha"], "/repos/alpha");
    expect(list).toEqual(["/repos/Alpha", "/repos/alpha"]);
  });

  it("removes only the exact canonical path", () => {
    const list = removeKnownWorkspace(["/repos/Alpha", "/repos/alpha"], "/repos/Alpha");
    expect(list).toEqual(["/repos/alpha"]);
  });

  it("replaces a requested path with the Host canonical path", () => {
    expect(
      replaceKnownWorkspace(
        ["C:\\repos\\alpha", "C:\\repos\\beta"],
        "C:\\repos\\alpha",
        "C:\\Repos\\Alpha",
      ),
    ).toEqual(["C:\\Repos\\Alpha", "C:\\repos\\beta"]);
  });
});

describe("workspaceDisplayName", () => {
  it("uses the last path segment for both separators", () => {
    expect(workspaceDisplayName("C:\\repos\\alpha")).toBe("alpha");
    expect(workspaceDisplayName("/home/user/beta/")).toBe("beta");
  });
});

describe("summarizeWorkspaceActivity", () => {
  function entry(overrides: Partial<HostActivitySummary> = {}): HostActivitySummary {
    return {
      cwd: "/a",
      busy: true,
      hasBeenBusy: true,
      errorCount: 0,
      doneCount: 0,
      terminalSessions: {},
      ...overrides,
    };
  }

  it("scopes busy and terminal markers to the owning cwd", () => {
    const shared = entry({
      busySessions: { s1: "/a", s2: "/b" },
      terminalSessions: {
        s1: { state: "error", generation: 1, workspaceCwd: "/a" },
        s2: { state: "done", generation: 2, workspaceCwd: "/b" },
      },
    });

    const a = summarizeWorkspaceActivity(shared, "/a");
    expect(a.busy).toBe(true);
    expect(a.errorCount).toBe(1);
    expect(a.doneCount).toBe(0);
    expect(a.terminalSessions.s1).toEqual({ state: "error", generation: 1, workspaceCwd: "/a" });
    expect(a.terminalSessions.s2).toBeUndefined();

    const b = summarizeWorkspaceActivity(shared, "/b");
    expect(b.busy).toBe(true);
    expect(b.errorCount).toBe(0);
    expect(b.doneCount).toBe(1);
    expect(b.terminalSessions.s2).toBeDefined();
    expect(b.terminalSessions.s1).toBeUndefined();
  });

  it("reports per-cwd busy from busySessions even when entry.busy disagrees", () => {
    // Legacy flag says the Host is idle, but the pool knows s1 still runs in /a.
    const shared = entry({ busy: false, busySessions: { s1: "/a" } });
    expect(summarizeWorkspaceActivity(shared, "/a").busy).toBe(true);
    expect(summarizeWorkspaceActivity(shared, "/b").busy).toBe(false);
  });

  it("mirrors markers without ownership while scoping is active", () => {
    const mixed = entry({
      errorCount: 9,
      doneCount: 9,
      busySessions: { s1: "/a" },
      terminalSessions: {
        s1: { state: "error", generation: 1, workspaceCwd: "/a" },
        // Legacy marker without ownership: could belong to any bound cwd.
        s0: { state: "done", generation: 1 },
      },
    });

    const a = summarizeWorkspaceActivity(mixed, "/a");
    expect(a.busy).toBe(true);
    expect(a.terminalSessions.s1).toBeDefined();
    expect(a.terminalSessions.s0).toBeDefined();
    expect(a.errorCount).toBe(1);
    expect(a.doneCount).toBe(1);

    const b = summarizeWorkspaceActivity(mixed, "/b");
    expect(b.busy).toBe(false);
    expect(b.terminalSessions.s1).toBeUndefined();
    expect(b.terminalSessions.s0).toBeDefined();
  });

  it("falls back to whole-entry mirroring for legacy pools without ownership", () => {
    const legacy = entry({
      errorCount: 3,
      doneCount: 4,
      terminalSessions: { s: { state: "done", generation: 1 } },
    });
    for (const cwd of ["/a", "/b"]) {
      const activity = summarizeWorkspaceActivity(legacy, cwd);
      expect(activity.busy).toBe(true);
      expect(activity.errorCount).toBe(3);
      expect(activity.doneCount).toBe(4);
      expect(activity.terminalSessions.s).toEqual({ state: "done", generation: 1 });
    }
  });

  it("matches cwds case-insensitively on Windows-like platforms", () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    try {
      const shared = entry({ busySessions: { s1: "C:\\Repos\\Alpha" } });
      expect(summarizeWorkspaceActivity(shared, "c:\\repos\\alpha").busy).toBe(true);
    } finally {
      Object.defineProperty(navigator, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
