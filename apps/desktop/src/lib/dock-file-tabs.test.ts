import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingFileTabsForTest,
  requestOpenWorkspaceFileTab,
  subscribeOpenWorkspaceFileTab,
} from "./dock-file-tabs";

afterEach(() => clearPendingFileTabsForTest());

describe("dock file tab requests", () => {
  it("routes a request to the dock once mounted", () => {
    const handler = vi.fn(() => true);
    requestOpenWorkspaceFileTab("report.md");
    expect(handler).not.toHaveBeenCalled();

    const unsubscribe = subscribeOpenWorkspaceFileTab(handler);
    expect(handler).toHaveBeenCalledWith("report.md");
    unsubscribe();

    requestOpenWorkspaceFileTab("other.md");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays every queued path in order and keeps live requests immediate", () => {
    const handler = vi.fn((_path: string) => true);
    requestOpenWorkspaceFileTab("a.md");
    requestOpenWorkspaceFileTab("b.md");
    const unsubscribe = subscribeOpenWorkspaceFileTab(handler);
    expect(handler.mock.calls.map(([path]) => path)).toEqual(["a.md", "b.md"]);

    requestOpenWorkspaceFileTab("c.md");
    expect(handler).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("keeps a request queued when no handler consumes it", () => {
    const rejecting = vi.fn(() => false);
    const unsubscribe = subscribeOpenWorkspaceFileTab(rejecting);
    requestOpenWorkspaceFileTab("late.md");
    expect(rejecting).toHaveBeenCalledTimes(1);

    const mounted = vi.fn(() => true);
    const unsubscribeMounted = subscribeOpenWorkspaceFileTab(mounted);
    expect(mounted).toHaveBeenCalledWith("late.md");
    unsubscribe();
    unsubscribeMounted();
  });
});
