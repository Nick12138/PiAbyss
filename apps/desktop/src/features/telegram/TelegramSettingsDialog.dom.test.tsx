/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { useTelegramViewStore } from "./telegram-view-store";
import { TelegramSettingsDialog } from "./TelegramSettingsDialog";

function readyHostState() {
  useAppStore.setState({
    host: {
      protocolVersion: 1,
      hostInstanceId: "host-1",
      workspaceId: "w-1",
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 1,
      sdkVersion: "0.82.1",
      nodeVersion: process.version,
      agentDir: "/agent",
      phase: "ready",
      capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    },
    workspace: { id: "w-1", cwd: "/p", canonicalCwd: "/p", revision: 1, servicesReady: true },
  });
}

describe("TelegramSettingsDialog", () => {
  beforeEach(() => {
    readyHostState();
    useTelegramViewStore.setState({
      profile: {
        profile: "default",
        botUsername: "liu_worker_bot",
        botName: "Worker",
        configured: true,
      },
      assistant: { rendering: "rich", activity: "verbose", proactivePush: true },
      voice: { replyMode: "mirror" },
      threads: { automaticCleanup: true },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("saves plugin options via telegram.updateConfig", async () => {
    const spy = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      method: "telegram.updateConfig",
      id: "1",
      result: { saved: true },
    } as never);
    const onChanged = vi.fn();
    render(<TelegramSettingsDialog onCancel={vi.fn()} onChanged={onChanged} />);

    expect(screen.getByText("Telegram settings — @liu_worker_bot")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save options/i }));
    expect(spy).toHaveBeenCalledWith(
      "telegram.updateConfig",
      expect.anything(),
      expect.objectContaining({ assistant: expect.anything() }),
      expect.any(Number),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("walks through the delete confirmation and resets via telegram.reset", async () => {
    const spy = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      method: "telegram.reset",
      id: "1",
      result: { reset: true },
    } as never);
    const onCancel = vi.fn();
    render(<TelegramSettingsDialog onCancel={onCancel} onChanged={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /delete bot/i }));
    expect(screen.getByText(/This permanently removes telegram.json/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(spy).toHaveBeenCalledWith("telegram.reset", expect.anything(), null, expect.any(Number));
    expect(onCancel).toHaveBeenCalled();
  });
});
