/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateButton } from "./AppUpdateButton";
import { useAppStore } from "../lib/stores/app-store";
import type { AppUpdate } from "../lib/updater";

afterEach(() => {
  cleanup();
  useAppStore.setState({ appUpdatePhase: { state: "idle" } });
  vi.clearAllMocks();
});

function availableUpdate(): AppUpdate {
  return {
    version: "0.2.0",
    download: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  };
}

function setPhase(phase: ReturnType<typeof useAppStore.getState>["appUpdatePhase"]) {
  useAppStore.getState().setAppUpdatePhase(phase);
}

describe("AppUpdateButton", () => {
  it("stays hidden without an available update", () => {
    render(<AppUpdateButton />);
    expect(screen.queryByRole("button", { name: "Download and update" })).not.toBeInTheDocument();
  });

  it("downloads on click, then automatically restarts once complete", async () => {
    const user = userEvent.setup();
    const update = availableUpdate();
    setPhase({ state: "available", update });
    render(<AppUpdateButton />);

    await user.click(screen.getByRole("button", { name: "Download and update" }));

    expect(update.download).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(useAppStore.getState().appUpdatePhase.state).toBe("installing");
    });
    expect(update.restart).toHaveBeenCalledOnce();
  });

  it("shows a live 0-100% download progress label", () => {
    const update = availableUpdate();
    setPhase({
      state: "downloading",
      update,
      downloadedBytes: 3500,
      totalBytes: 10000,
    });
    render(<AppUpdateButton />);

    expect(screen.getByRole("button", { name: "Downloading 35%" })).toBeInTheDocument();
  });

  it("falls back to an indeterminate label without a content length", () => {
    const update = availableUpdate();
    setPhase({
      state: "downloading",
      update,
      downloadedBytes: 2048,
      totalBytes: null,
    });
    render(<AppUpdateButton />);

    expect(screen.getByRole("button", { name: "Downloading update…" })).toBeInTheDocument();
  });

  it("restarts automatically once the download completes", async () => {
    const user = userEvent.setup();
    const update = availableUpdate();
    update.download = vi.fn(async (onProgress) => {
      onProgress?.({ phase: "downloading", downloadedBytes: 10, totalBytes: 10 });
      onProgress?.({ phase: "installing" });
    });
    setPhase({ state: "available", update });
    render(<AppUpdateButton />);

    await user.click(screen.getByRole("button", { name: "Download and update" }));

    await waitFor(() => {
      expect(update.restart).toHaveBeenCalledOnce();
    });
    expect(useAppStore.getState().appUpdatePhase.state).toBe("installing");
  });

  it("returns to the available state when the download or restart fails", async () => {
    const user = userEvent.setup();
    const update = availableUpdate();
    update.download = vi.fn(async () => {
      throw new Error("network gone");
    });
    setPhase({ state: "available", update });
    render(<AppUpdateButton />);

    await user.click(screen.getByRole("button", { name: "Download and update" }));

    await waitFor(() => {
      expect(useAppStore.getState().appUpdatePhase.state).toBe("available");
    });
    expect(screen.getByRole("button", { name: "Download and update" })).toBeInTheDocument();
  });
});
