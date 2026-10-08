/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { SubagentTitleMenu } from "./SubagentTitleMenu";
import { SubagentConversation } from "./SubagentConversation";

const host = { hostInstanceId: "00000000-0000-4000-8000-000000000101" } as HostStatusSnapshot;
const workspace = {
  id: "00000000-0000-4000-8000-000000000201",
  revision: 3,
  canonicalCwd: "/repo/apps/desktop",
} as WorkspaceSnapshot;

const baseStatus = {
  version: 1 as const,
  available: true,
  generatedAt: 1,
  totalActive: 1,
  omitted: 0,
  fleet: [],
};

function setStatus(runs: unknown[], available = true) {
  useAppStore.setState({
    subagentsStatus: {
      ...baseStatus,
      available,
      totalActive: Array.isArray(runs)
        ? (runs as Array<{ state: string }>).filter((r) => r.state === "running").length
        : 0,
      runs: runs as never,
    },
  });
}

/** Host response envelope with a given result payload. */
function okResponse(method: string, result: unknown) {
  return {
    protocolVersion: 1,
    id: crypto.randomUUID(),
    method,
    hostInstanceId: host.hostInstanceId,
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 0,
    ok: true,
    result,
  } as never;
}

const finishedSnapshot = {
  nodeId: "run-1",
  sessionId: "s1",
  state: "complete",
  truncated: false,
  updatedAt: 1787545104000,
  entries: [
    {
      type: "message",
      id: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Do the task" }],
      },
    },
    {
      type: "message",
      id: "a2",
      timestamp: "2026-01-01T00:02:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({
    activeSubagentNodeId: null,
    subagentsStatus: {
      ...baseStatus,
      totalActive: 0,
      runs: [],
    },
  });
});

describe("SubagentTitleMenu", () => {
  it("renders nothing when no runs exist", () => {
    setStatus([]);
    render(<SubagentTitleMenu />);
    expect(screen.queryByRole("button", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("shows the bot trigger with a running badge and opens the run list", async () => {
    setStatus([
      { id: "run-1", kind: "subagent", label: "Scout task", role: "scout", state: "running" },
      { id: "run-2", kind: "subagent", label: "Done task", state: "complete" },
    ]);
    render(<SubagentTitleMenu />);

    const trigger = screen.getByRole("button", { name: "Subagents" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.textContent).toContain("1");
    // Live fleet: accent tone + breathing icon.
    expect(trigger).toHaveClass("text-accent");
    expect(trigger.querySelector("svg")).toHaveClass("animate-pulse");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Scout task/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Done task/ })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Done task/ }));
    expect(useAppStore.getState().activeSubagentNodeId).toBe("run-2");
  });

  it("keeps the bot trigger muted without running children", () => {
    setStatus([{ id: "run-2", kind: "subagent", label: "Done task", state: "complete" }]);
    render(<SubagentTitleMenu />);

    const trigger = screen.getByRole("button", { name: "Subagents" });
    expect(trigger).toHaveClass("text-muted");
    expect(trigger.querySelector("svg")).not.toHaveClass("animate-pulse");
  });

  it("renders the breadcrumb segment for the active subagent and can switch runs", async () => {
    setStatus([
      { id: "run-1", kind: "subagent", label: "Scout task", state: "running" },
      { id: "run-2", kind: "subagent", name: "Named worker", label: "run-2", state: "paused" },
    ]);
    useAppStore.setState({ activeSubagentNodeId: "run-2" });
    render(<SubagentTitleMenu />);

    const crumb = screen.getByRole("button", { name: "Subagents" });
    expect(crumb.textContent).toContain("Named worker");
    expect(screen.getByText("/")).toBeVisible();

    fireEvent.click(crumb);
    fireEvent.click(screen.getByRole("button", { name: /Scout task/ }));
    expect(useAppStore.getState().activeSubagentNodeId).toBe("run-1");
  });
});

describe("SubagentConversation", () => {
  it("renders the persisted transcript rows", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") return okResponse(method, finishedSnapshot);
      throw new Error(`Unexpected method ${method}`);
    });
    setStatus([{ id: "run-1", kind: "subagent", label: "Run task", state: "complete" }]);
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      activeSubagentNodeId: "run-1",
    });

    render(<SubagentConversation />);

    expect(await screen.findByText("Do the task")).toBeVisible();
    expect(screen.getByText("Final answer")).toBeVisible();
    expect(request).toHaveBeenCalledWith(
      "subagents.getSession",
      expect.anything(),
      { nodeId: "run-1" },
      expect.anything(),
    );
  });

  it("sends a composer message through subagents.send", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") return okResponse(method, finishedSnapshot);
      if (method === "subagents.send") return okResponse(method, { sent: true, mode: "steer" });
      throw new Error(`Unexpected method ${method}`);
    });
    setStatus([{ id: "run-1", kind: "subagent", label: "Run task", state: "running" }]);
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      activeSubagentNodeId: "run-1",
    });

    render(<SubagentConversation />);

    const composer = await screen.findByPlaceholderText("Message this subagent...");
    fireEvent.change(composer, { target: { value: "check the results" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "subagents.send",
        expect.anything(),
        { nodeId: "run-1", message: "check the results" },
        expect.anything(),
      ),
    );
    expect(
      (screen.getByPlaceholderText("Message this subagent...") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("exposes pause/stop for a running run and routes them through the host client", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") return okResponse(method, finishedSnapshot);
      if (method === "subagents.pause" || method === "subagents.stop")
        return okResponse(method, { paused: true });
      throw new Error(`Unexpected method ${method}`);
    });
    setStatus([{ id: "run-1", kind: "subagent", label: "Run task", state: "running" }]);
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      activeSubagentNodeId: "run-1",
    });

    render(<SubagentConversation />);

    fireEvent.click(screen.getByRole("button", { name: "Pause subagent" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "subagents.pause",
        expect.anything(),
        { nodeId: "run-1" },
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "subagents.stop",
        expect.anything(),
        { nodeId: "run-1" },
        expect.anything(),
      ),
    );
  });

  it("falls back to the main session when the active run disappears from the status", async () => {
    setStatus([{ id: "run-1", kind: "subagent", label: "Run task", state: "complete" }]);
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      activeSubagentNodeId: "run-gone",
    });

    render(<SubagentConversation />);

    await waitFor(() => expect(useAppStore.getState().activeSubagentNodeId).toBeNull());
  });
});
