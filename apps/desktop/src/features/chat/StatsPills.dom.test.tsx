/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { SessionStatsPills } from "./StatsPills";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [],
        startedAt: 1_000,
        firstTokenAt: 1_500,
        endedAt: 2_500,
        usage: {
          input: 100,
          output: 271,
          cacheRead: 700,
          cacheWrite: 200,
          totalTokens: 1_271,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
    ...overrides,
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

function statsResult() {
  return {
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    tokens: {
      input: 540_560,
      output: 222_432,
      cacheRead: 5_849_984,
      cacheWrite: 0,
      total: 6_612_976,
    },
    timing: {
      llmMs: 3_336_000,
      toolMs: 11_200,
      ttftMs: 1_200,
      ttftSteps: 2,
      decodeMs: 4_000,
      decodeTokens: 1_084,
    },
    cost: 1.5,
  };
}

describe("SessionStatsPills", () => {
  beforeEach(() => {
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("renders both pill labels from the durable aggregates", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getStats", statsResult()) as never,
    );
    render(<SessionStatsPills />);
    // The time pill's outer reading is the output speed only.
    const timePill = screen.getByRole("button", { name: /Session stats/ });
    expect(timePill).toHaveTextContent("271 tok/s");
    expect(timePill).not.toHaveTextContent("turns");
    expect(timePill).not.toHaveTextContent("steps");
    // The usage pill's outer reading is the cache-hit percentage only.
    const usagePill = screen.getByRole("button", { name: /Token usage/ });
    await waitFor(() => expect(usagePill).toHaveTextContent("92%"));
    expect(usagePill).not.toHaveTextContent("tok");
  });

  it("opens the time dialog with turn/step counts and whole-history timings", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(envelope("session.getStats", statsResult()) as never);
    const user = userEvent.setup();
    render(<SessionStatsPills />);

    await user.click(screen.getByRole("button", { name: /Session stats/ }));

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("session.getStats", expect.anything(), null);
    const dialog = screen.getByRole("dialog", { name: "Session stats" });
    expect(dialog).toHaveTextContent("Turns");
    expect(dialog).toHaveTextContent("Steps");
    expect(dialog).toHaveTextContent("Model time");
    expect(dialog).toHaveTextContent("55m36s");
    expect(dialog).toHaveTextContent("Tool time");
    expect(dialog).toHaveTextContent("11.2s");
    // Host-persisted whole-history aggregate (1200ms / 2 steps), not the
    // live-measured 500ms of the visible snapshot.
    expect(dialog).toHaveTextContent("Avg. TTFT");
    expect(dialog).toHaveTextContent("0.6s");
    expect(dialog).toHaveTextContent("Avg. speed");
    expect(dialog).toHaveTextContent("271 tok/s");
  });

  it("opens the usage dialog with exact whole-history buckets", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getStats", statsResult()) as never,
    );
    const user = userEvent.setup();
    render(<SessionStatsPills />);

    await user.click(screen.getByRole("button", { name: /Token usage/ }));

    const dialog = await screen.findByRole("dialog", { name: "Token usage" });
    expect(dialog).toHaveTextContent("6,612,976");
    expect(dialog).toHaveTextContent("Cache hit");
    expect(dialog).toHaveTextContent("92%");
    expect(dialog).toHaveTextContent("540,560");
    expect(dialog).toHaveTextContent("5,849,984");
    expect(dialog).toHaveTextContent("222,432");
  });

  it("keeps only one dialog open at a time", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getStats", statsResult()) as never,
    );
    const user = userEvent.setup();
    render(<SessionStatsPills />);

    await user.click(screen.getByRole("button", { name: /Session stats/ }));
    expect(screen.getByRole("dialog", { name: "Session stats" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Token usage/ }));
    expect(screen.queryByRole("dialog", { name: "Session stats" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Token usage" })).toBeVisible();
  });

  it("renders nothing for a fresh conversation", () => {
    useAppStore.getState().applySessionSnapshot(session({ messages: [] }));
    render(<SessionStatsPills />);
    expect(screen.queryByRole("button", { name: /Session stats/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Token usage/ })).not.toBeInTheDocument();
  });

  it("hides a pill whose figure is missing instead of showing an icon alone", async () => {
    // Zero cache hit and no measured decode window: neither pill has a figure
    // to print, so the whole row disappears.
    useAppStore.getState().applySessionSnapshot(
      session({
        messages: [
          {
            role: "assistant",
            content: [],
            usage: {
              input: 120,
              output: 40,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 160,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ],
      }),
    );
    vi.spyOn(hostClient, "request").mockRejectedValue(new Error("host gone"));
    const { container } = render(<SessionStatsPills />);

    await waitFor(() => expect(hostClient.request).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Session stats/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Token usage/ })).not.toBeInTheDocument();
    expect(container.querySelector("[data-composer-stats]")).toBeNull();
  });

  it("falls back to the visible-window fold when the fetch fails", async () => {
    vi.spyOn(hostClient, "request").mockRejectedValue(new Error("host gone"));
    const user = userEvent.setup();
    render(<SessionStatsPills />);

    await user.click(screen.getByRole("button", { name: /Token usage/ }));

    const dialog = await screen.findByRole("dialog", { name: "Token usage" });
    expect(dialog).toHaveTextContent("1,271");
    expect(dialog).toHaveTextContent("70%");
    expect(dialog).toHaveTextContent("700");
    expect(dialog).toHaveTextContent("271");
  });
});
