import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchHostActivity,
  type HostActivitySummary,
  type HostTerminalMarker,
} from "./bridge/tauri-transport";
import type { SystemNotificationCandidate } from "./system-notifications";
import { ActivityNotificationObserver, activityPathKey } from "./activity-notifications";

vi.mock("./bridge/tauri-transport", () => ({
  fetchHostActivity: vi.fn(async () => [] as HostActivitySummary[]),
  subscribeHostActivity: vi.fn(() => () => {}),
  hostActivityCwds: (entry: HostActivitySummary) =>
    entry.cwds && entry.cwds.length > 0 ? entry.cwds : [entry.cwd],
}));

function summary(
  cwd: string,
  terminalSessions: Record<string, HostTerminalMarker>,
): HostActivitySummary {
  return {
    cwd,
    busy: false,
    hasBeenBusy: true,
    errorCount: 0,
    doneCount: 0,
    terminalSessions,
  };
}

describe("ActivityNotificationObserver", () => {
  let isActiveWorkspace: (cwd: string) => boolean;
  let attentionState: "foreground" | "background" | "unknown";
  let enabled: boolean;
  const notified: SystemNotificationCandidate[] = [];

  function makeObserver(): ActivityNotificationObserver {
    return new ActivityNotificationObserver({
      isActiveWorkspace: (cwd) => isActiveWorkspace(cwd),
      attention: () => attentionState,
      enabled: () => enabled,
      notify: (candidate) => notified.push(candidate),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    isActiveWorkspace = () => false;
    attentionState = "background";
    enabled = true;
    notified.length = 0;
  });

  it("primes the first snapshot silently and notifies later completions", async () => {
    const observer = makeObserver();
    observer.observeSnapshot([
      summary("/proj/other", { "session-old": { state: "done", generation: 3 } }),
    ]);
    expect(notified).toHaveLength(0);

    observer.observeSnapshot([
      summary("/proj/other", { "session-old": { state: "done", generation: 3 } }),
    ]);
    expect(notified).toHaveLength(0);

    observer.observeSnapshot([
      summary("/proj/other", { "session-new": { state: "done", generation: 4 } }),
    ]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "response-ready",
      target: {
        workspaceId: null,
        workspacePath: "/proj/other",
        sessionId: "session-new",
      },
    });
    observer.dispose();
  });

  it("classifies failed terminals as session-failed", () => {
    const observer = makeObserver();
    observer.observeSnapshot([summary("/proj/other", {})]);
    observer.observeSnapshot([
      summary("/proj/other", { "session-broken": { state: "error", generation: 1 } }),
    ]);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.kind).toBe("session-failed");
    observer.dispose();
  });

  it("skips the active workspace and foreground attention", () => {
    isActiveWorkspace = (cwd) => cwd === "/proj/active";
    attentionState = "foreground";
    const observer = makeObserver();
    observer.observeSnapshot([summary("/proj/other", {})]);
    observer.observeSnapshot([
      summary("/proj/active", { a: { state: "done", generation: 1 } }),
      summary("/proj/other", { b: { state: "done", generation: 1 } }),
    ]);
    expect(notified).toHaveLength(0);

    attentionState = "background";
    observer.observeSnapshot([summary("/proj/active", { a: { state: "done", generation: 2 } })]);
    expect(notified).toHaveLength(0);
    observer.dispose();
  });

  it("skips candidates when the setting is disabled", () => {
    enabled = false;
    const observer = makeObserver();
    observer.observeSnapshot([summary("/proj/other", {})]);
    observer.observeSnapshot([summary("/proj/other", { s: { state: "done", generation: 1 } })]);
    expect(notified).toHaveLength(0);
    observer.dispose();
  });

  it("treats a generation regression as a Host restart and re-arms afterwards", () => {
    const observer = makeObserver();
    observer.observeSnapshot([summary("/proj/other", {})]);
    observer.observeSnapshot([summary("/proj/other", { s: { state: "done", generation: 7 } })]);
    expect(notified).toHaveLength(1);

    // Host restarted: generations reset below the baseline; no alert, and the
    // next completion of the same session notifies again.
    observer.observeSnapshot([summary("/proj/other", { s: { state: "done", generation: 2 } })]);
    expect(notified).toHaveLength(1);
    observer.observeSnapshot([summary("/proj/other", { s: { state: "done", generation: 3 } })]);
    expect(notified).toHaveLength(2);
    observer.dispose();
  });

  it("does not re-notify the same generation", () => {
    const observer = makeObserver();
    observer.observeSnapshot([summary("/proj/other", {})]);
    const terminal = { s: { state: "done", generation: 5 } as const };
    observer.observeSnapshot([summary("/proj/other", terminal)]);
    observer.observeSnapshot([summary("/proj/other", terminal)]);
    expect(notified).toHaveLength(1);
    observer.dispose();
  });

  it("compares workspace paths case-insensitively on Windows-like keys", () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    try {
      expect(activityPathKey("C:\\Repo")).toBe(activityPathKey("c:\\repo"));
      isActiveWorkspace = () => false;
      const observer = makeObserver();
      observer.observeSnapshot([summary("/proj/other", {})]);
      observer.observeSnapshot([summary("/proj/other", { s: { state: "done", generation: 1 } })]);
      expect(notified).toHaveLength(1);
      observer.dispose();
    } finally {
      Object.defineProperty(navigator, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("expands shared-host cwds without duplicating one session per workspace", () => {
    const observer = makeObserver();
    // Shared Host bound to /a and /b: one entry mirrors the same session
    // terminal marker across both cwds.
    const shared = (generation: number) => ({
      ...summary("/a", { s1: { state: "done", generation } }),
      cwds: ["/a", "/b"],
    });
    observer.observeSnapshot([shared(1)]); // prime
    observer.observeSnapshot([shared(2)]);
    // The generation advanced once per session — never once per cwd.
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "response-ready",
      target: { workspacePath: "/a", sessionId: "s1" },
    });
    observer.dispose();
  });

  it("skips a shared Host whose bound workspaces include the active workspace", () => {
    const observer = makeObserver();
    const shared = (generation: number) => ({
      ...summary("/a", { s1: { state: "error", generation } }),
      cwds: ["/a", "/b"],
    });
    observer.observeSnapshot([shared(1)]); // prime
    // Active workspace /b is one of the shared Host's bound workspaces: the
    // event stream already delivered the completion, so no pool alert.
    isActiveWorkspace = (cwd) => cwd === "/b";
    observer.observeSnapshot([shared(2)]);
    expect(notified).toHaveLength(0);
    observer.dispose();
  });

  it("notifies a parked completion even when the entry also covers the active workspace", () => {
    isActiveWorkspace = (cwd) => cwd === "/a";
    const observer = makeObserver();
    const shared = (generation: number) => ({
      ...summary("/a", {
        // The active workspace's own marker stays event-stream-covered…
        "s-active": { state: "done", generation },
        // …while the parked workspace's completion must not be swallowed.
        "s-parked": { state: "done", generation, workspaceCwd: "/b" },
      }),
      cwds: ["/a", "/b"],
    });
    observer.observeSnapshot([shared(1)]); // prime
    observer.observeSnapshot([shared(2)]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "response-ready",
      target: { workspaceId: null, workspacePath: "/b", sessionId: "s-parked" },
    });
    observer.dispose();
  });

  it("skips a completion whose workspaceCwd is the active workspace", () => {
    isActiveWorkspace = (cwd) => cwd === "/b";
    const observer = makeObserver();
    const shared = (generation: number) => ({
      ...summary("/a", {
        "s-active": { state: "error", generation, workspaceCwd: "/b" },
        "s-parked": { state: "done", generation, workspaceCwd: "/a" },
      }),
      cwds: ["/a", "/b"],
    });
    observer.observeSnapshot([shared(1)]); // prime
    observer.observeSnapshot([shared(2)]);
    // Only the parked completion is delivered; the one owned by the active
    // workspace is suppressed (the event stream already notified it).
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "response-ready",
      target: { workspacePath: "/a", sessionId: "s-parked" },
    });
    observer.dispose();
  });

  it("refresh pulls a snapshot through the pool command", async () => {
    vi.mocked(fetchHostActivity).mockResolvedValueOnce([
      summary("/proj/other", { s: { state: "done", generation: 1 } }),
    ]);
    const observer = makeObserver();
    await observer.refresh();
    expect(notified).toHaveLength(0);
    vi.mocked(fetchHostActivity).mockResolvedValueOnce([
      summary("/proj/other", { s: { state: "done", generation: 2 } }),
    ]);
    await observer.refresh();
    expect(notified).toHaveLength(1);
    observer.dispose();
  });

  it("serializes fetches so no sample is applied before an older one", async () => {
    const gates: Array<(value: HostActivitySummary[]) => void> = [];
    vi.mocked(fetchHostActivity).mockImplementation(
      () => new Promise<HostActivitySummary[]>((resolve) => gates.push(resolve)),
    );
    const observer = makeObserver();

    const prime = observer.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchHostActivity).toHaveBeenCalledTimes(1);

    // A completion lands after the prime sample was taken; the busy-change
    // schedules a second fetch which must wait for the prime to be applied.
    const second = observer.refresh();
    expect(fetchHostActivity).toHaveBeenCalledTimes(1);
    gates[0]!([summary("/proj/other", {})]);
    await prime;
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchHostActivity).toHaveBeenCalledTimes(2);

    gates[1]!([summary("/proj/other", { "session-new": { state: "done", generation: 1 } })]);
    await second;
    expect(notified).toHaveLength(1);
    expect(notified[0]!.target?.sessionId).toBe("session-new");
    observer.dispose();
  });

  it("coalesces bursts of busy-changes into one queued fetch", async () => {
    const gates: Array<(value: HostActivitySummary[]) => void> = [];
    vi.mocked(fetchHostActivity).mockImplementation(
      () => new Promise<HostActivitySummary[]>((resolve) => gates.push(resolve)),
    );
    const observer = makeObserver();

    const prime = observer.refresh();
    await Promise.resolve();
    await Promise.resolve();
    const queued = observer.refresh();
    observer.refresh();
    observer.refresh();
    expect(fetchHostActivity).toHaveBeenCalledTimes(1);

    gates[0]!([summary("/proj/other", {})]);
    await prime;
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchHostActivity).toHaveBeenCalledTimes(2);
    gates[1]!([summary("/proj/other", {})]);
    await queued;
    expect(notified).toHaveLength(0);
    observer.dispose();
  });

  it("ignores refreshes after dispose", async () => {
    const observer = makeObserver();
    observer.dispose();
    await observer.refresh();
    expect(fetchHostActivity).not.toHaveBeenCalled();
  });
});
