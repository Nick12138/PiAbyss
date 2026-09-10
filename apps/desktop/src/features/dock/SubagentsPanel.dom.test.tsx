/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { SubagentsPanel } from "./SubagentsPanel";

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

afterEach(() => {
  cleanup();
  useAppStore.setState({
    subagentsStatus: {
      ...baseStatus,
      totalActive: 0,
      runs: [],
    },
  });
});

describe("SubagentsPanel", () => {
  it("renders nested children as independently collapsible rows", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "run-1",
            kind: "workflow",
            label: "worker workflow",
            state: "running",
            children: [
              {
                id: "step-1",
                kind: "step",
                label: "reviewer",
                state: "running",
                activity: { currentTool: "read" },
              },
            ],
          },
        ],
      },
    });

    render(<SubagentsPanel />);

    expect(screen.getByRole("button", { name: /worker workflow/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /reviewer/ })).toBeVisible();
    expect(screen.getByText("read")).toBeVisible();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("Running")).toHaveLength(2);
  });

  it("counts only running tasks in the header", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "running",
            kind: "subagent",
            label: "running task",
            role: "reviewer",
            state: "running",
          },
          {
            id: "complete",
            kind: "subagent",
            label: "complete task",
            state: "complete",
          },
          {
            id: "failed",
            kind: "subagent",
            label: "failed task",
            state: "failed",
          },
          {
            id: "queued",
            kind: "subagent",
            label: "queued task",
            state: "queued",
          },
        ],
      },
    });

    render(<SubagentsPanel />);

    expect(screen.getByText("Active: 1")).toBeVisible();
    const roleBadge = screen.getByText("👀");
    const row = roleBadge.closest("div");
    expect(roleBadge).toBeVisible();
    expect(roleBadge).toHaveAttribute("title", "Role: Reviewer");
    expect(row).not.toBeNull();
    expect(row?.textContent?.indexOf("👀")).toBeLessThan(
      row?.textContent?.indexOf("running task") ?? -1,
    );
    expect(row?.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(row?.querySelector("svg.animate-spin")?.classList).toContain("animate-spin");
  });

  it("expands conversation inline instead of navigating away", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          {
            id: "run-inline",
            kind: "subagent",
            label: "Inline task",
            state: "running",
          },
        ],
      },
    });

    render(<SubagentsPanel />);
    const row = screen.getByRole("button", { name: "Inline task" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByLabelText("Back to subagents")).not.toBeInTheDocument();
  });

  it("shows a stop button only for running rows", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          { id: "running", kind: "subagent", label: "Running task", state: "running" },
          { id: "done", kind: "subagent", label: "Done task", state: "complete" },
        ],
      },
    });

    render(<SubagentsPanel />);
    expect(screen.getByRole("button", { name: "Stop subagent" })).toBeVisible();
    fireEvent.mouseEnter(screen.getByText("Running task"));
    expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeVisible();
  });

  it("exposes pause/continue/resume for the matching states", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        runs: [
          { id: "running", kind: "subagent", label: "Running task", state: "running" },
          { id: "paused", kind: "subagent", label: "Paused task", state: "paused" },
          { id: "failed", kind: "subagent", label: "Failed task", state: "failed" },
          { id: "done", kind: "subagent", label: "Done task", state: "complete" },
        ],
      },
    });

    render(<SubagentsPanel />);
    // running → pause + stop; paused → continue + stop; failed → resume.
    expect(screen.getAllByRole("button", { name: "Pause subagent" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Continue subagent" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Resume subagent" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Stop subagent" })).toHaveLength(2);
  });

  it("routes control actions through the host client", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
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
        result: {},
      } as never;
    });
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      subagentsStatus: {
        ...baseStatus,
        runs: [{ id: "run-ctl", kind: "subagent", label: "Ctl task", state: "running" }],
      },
    });

    render(<SubagentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Pause subagent" }));
    expect(await screen.findByText("Ctl task")).toBeVisible();
    expect(request).toHaveBeenCalledWith(
      "subagents.pause",
      expect.anything(),
      { nodeId: "run-ctl" },
      expect.anything(),
    );
    request.mockRestore();
  });

  it("shows a useful empty state when no child is active", () => {
    useAppStore.setState({
      subagentsStatus: {
        ...baseStatus,
        totalActive: 0,
        runs: [],
      },
    });
    render(<SubagentsPanel />);
    expect(screen.getByText("No active subagents.")).toBeVisible();
  });

  it("collapses intermediate operations for finished subagents and expands on click", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") {
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
          result: {
            nodeId: "run-collapse",
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
                id: "a1",
                timestamp: "2026-01-01T00:00:30.000Z",
                message: {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "secret thinking" },
                    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
                    { type: "text", text: "Let me check" },
                  ],
                },
              },
              {
                type: "message",
                id: "t1",
                timestamp: "2026-01-01T00:00:31.000Z",
                message: {
                  role: "toolResult",
                  toolCallId: "c1",
                  toolName: "bash",
                  content: [{ type: "text", text: "output" }],
                  isError: false,
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
          },
        } as never;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      subagentsStatus: {
        ...baseStatus,
        runs: [{ id: "run-collapse", kind: "subagent", label: "Collapse task", state: "complete" }],
      },
    });

    render(<SubagentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse task" }));

    // Only the user message, the collapsed summary, and the final result show.
    expect(await screen.findByText("Do the task")).toBeVisible();
    expect(screen.getByText("Completed after 2 min")).toBeVisible();
    expect(screen.getByText("Final answer")).toBeVisible();
    expect(screen.queryByText("Let me check")).not.toBeInTheDocument();
    expect(screen.queryByText(/secret thinking/)).not.toBeInTheDocument();

    // Clicking the summary expands the intermediate operations.
    fireEvent.click(screen.getByText("Completed after 2 min").closest("button") as HTMLElement);
    expect(await screen.findByText("Let me check")).toBeVisible();

    request.mockRestore();
  });

  it("renders the running tail row in streaming style with a working header", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") {
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
          result: {
            nodeId: "run-stream",
            sessionId: "s2",
            state: "running",
            truncated: false,
            updatedAt: 1787545104000,
            entries: [
              {
                type: "message",
                id: "u1",
                timestamp: "2026-01-01T00:00:00.000Z",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "Stream the task" }],
                },
              },
              {
                type: "message",
                id: "a1",
                timestamp: "2026-01-01T00:00:10.000Z",
                message: {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "partial thinking" },
                    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
                    { type: "text", text: "Streaming answer" },
                  ],
                },
              },
            ],
          },
        } as never;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      subagentsStatus: {
        ...baseStatus,
        runs: [{ id: "run-stream", kind: "subagent", label: "Stream task", state: "running" }],
      },
    });

    render(<SubagentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Stream task" }));

    expect(await screen.findByText("Stream the task")).toBeVisible();
    expect(screen.getByText("Streaming answer")).toBeVisible();

    // The tail assistant row carries the working header, a streaming caret
    // and the active execution-trace spinner.
    const tailRow = screen.getByText("Streaming answer").closest("[data-row-key]");
    expect(tailRow).not.toBeNull();
    expect(tailRow?.querySelector(".execution-trace-spinner")).toBeInTheDocument();
    expect(tailRow?.textContent).toContain("Pi is working...");

    request.mockRestore();
  });

  it("keeps finished runs fully static without a working header", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") {
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
          result: {
            nodeId: "run-static",
            sessionId: "s3",
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
                  content: [{ type: "text", text: "Static task" }],
                },
              },
              {
                type: "message",
                id: "a1",
                timestamp: "2026-01-01T00:01:00.000Z",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Final static answer" }],
                },
              },
            ],
          },
        } as never;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      subagentsStatus: {
        ...baseStatus,
        runs: [{ id: "run-static", kind: "subagent", label: "Static task", state: "complete" }],
      },
    });

    render(<SubagentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Static task" }));

    expect(await screen.findByText("Final static answer")).toBeVisible();
    const resultRow = screen.getByText("Final static answer").closest("[data-row-key]");
    expect(resultRow).not.toBeNull();
    expect(resultRow?.querySelector("svg.animate-spin")).not.toBeInTheDocument();
    expect(resultRow?.textContent).not.toContain("Pi is working...");

    request.mockRestore();
  });

  it("shows a working indicator while a running run has no assistant tail yet", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "subagents.getSession") {
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
          result: {
            nodeId: "run-tool-tail",
            sessionId: "s4",
            state: "running",
            truncated: false,
            updatedAt: 1787545104000,
            entries: [
              {
                type: "message",
                id: "u1",
                timestamp: "2026-01-01T00:00:00.000Z",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "Tool tail task" }],
                },
              },
              {
                type: "message",
                id: "t1",
                timestamp: "2026-01-01T00:00:10.000Z",
                message: {
                  role: "toolResult",
                  toolCallId: "c1",
                  toolName: "bash",
                  content: [{ type: "text", text: "partial output" }],
                  isError: false,
                },
              },
            ],
          },
        } as never;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    useAppStore.setState({
      host,
      workspace,
      desktopSettings: { language: "en" } as never,
      subagentsStatus: {
        ...baseStatus,
        runs: [
          { id: "run-tool-tail", kind: "subagent", label: "Tool tail task", state: "running" },
        ],
      },
    });

    render(<SubagentsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Tool tail task" }));

    expect(await screen.findByText("Tool tail task")).toBeVisible();
    // The tail entry is a tool result, not an assistant message: the generic
    // working indicator still shows while the run is active.
    const panel = document.querySelector("[data-subagents-panel]");
    expect(panel?.textContent).toContain("Pi is working...");

    request.mockRestore();
  });
});
