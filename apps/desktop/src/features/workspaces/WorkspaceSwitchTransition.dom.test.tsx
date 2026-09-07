/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { WorkspaceSwitchTransition } from "./WorkspaceSwitchTransition";

describe("WorkspaceSwitchTransition", () => {
  afterEach(() => {
    useAppStore.getState().setWorkspaceSwitchTarget(null);
    cleanup();
  });

  it("renders children without a skeleton when idle", () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the conversation fully visible during a quick switch", async () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    act(() => useAppStore.getState().setWorkspaceSwitchTarget("/Users/me/Projects/PiAbyss"));

    // Within the grace period the stale content stays visible and interactive —
    // the skeleton is mounted but stays transparent, so a fast switch never flashes.
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.getByText("conversation").closest("[aria-hidden]")).toBeNull();

    // The switch settles quickly: still no transition, and the skeleton unmounts.
    act(() => useAppStore.getState().setWorkspaceSwitchTarget(null));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByText("conversation")).toBeVisible();
    expect(screen.getByText("conversation").closest("[aria-hidden]")).toBeNull();
  });

  it("fades the stale content into a named skeleton once the switch runs long", async () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    act(() => useAppStore.getState().setWorkspaceSwitchTarget("/Users/me/Projects/PiAbyss"));

    // Once the grace period elapses the skeleton fades in and the content hides.
    await waitFor(() => {
      expect(screen.getByText("conversation").closest("[aria-hidden]")).not.toBeNull();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Opening PiAbyss…");
  });

  it("removes the skeleton after the switch settles", async () => {
    render(
      <WorkspaceSwitchTransition>
        <p>conversation</p>
      </WorkspaceSwitchTransition>,
    );
    act(() => useAppStore.getState().setWorkspaceSwitchTarget("/tmp/other"));
    await waitFor(() => {
      expect(screen.getByText("conversation").closest("[aria-hidden]")).not.toBeNull();
    });

    act(() => useAppStore.getState().setWorkspaceSwitchTarget(null));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByText("conversation").closest("[aria-hidden]")).toBeNull();
  });
});
