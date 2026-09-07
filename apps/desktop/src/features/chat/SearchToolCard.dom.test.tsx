/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openChatLink: vi.fn() }));

vi.mock("./chat-link", () => ({ openChatLink: mocks.openChatLink }));

import { SearchToolCard } from "./SearchToolCard";
import { ToolCard } from "./ToolCard";
import { ToolView } from "./ToolView";

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

function controlledRegion(toggle: HTMLElement): HTMLElement {
  const contentId = toggle.getAttribute("aria-controls");
  expect(contentId).toBeTruthy();
  const region = document.getElementById(contentId!);
  expect(region).toHaveAttribute("data-collapsible-region");
  return region!;
}

function middleClick(target: Element): void {
  fireEvent(target, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
}

beforeEach(() => {
  mocks.openChatLink.mockReset().mockReturnValue(true);
  nextFrameId = 1;
  frames = new Map();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tool disclosure motion", () => {
  it("animates a generic tool once while allowing live result updates", () => {
    const { rerender } = render(
      <ToolCard
        name="inspect"
        status="running"
        args={{ path: "src/App.tsx" }}
        result="Initial tool output"
      />,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    const region = controlledRegion(toggle);
    expect(region).toHaveAttribute("data-state", "closed");
    expect(screen.queryByText("Initial tool output")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Initial tool output")).toBeInTheDocument();
    flushFrame();
    flushFrame();
    expect(region).toHaveAttribute("data-state", "open");

    rerender(
      <ToolCard
        name="inspect"
        status="running"
        args={{ path: "src/App.tsx" }}
        result="Updated tool output"
      />,
    );
    expect(screen.getByText("Updated tool output")).toBeInTheDocument();
    expect(region).toHaveAttribute("data-state", "open");
    expect(frames).toHaveLength(0);

    fireEvent.click(toggle);
    expect(region).toHaveAttribute("data-state", "closed");
    expect(screen.getByText("Updated tool output")).toBeInTheDocument();
    fireEvent.transitionEnd(region, { propertyName: "grid-template-rows" });
    expect(screen.queryByText("Updated tool output")).not.toBeInTheDocument();
  });

  it("routes normal and middle clicks through the shared chat-link policy", async () => {
    const user = userEvent.setup();
    render(
      <SearchToolCard
        name="web_search"
        status="done"
        args={{ query: "PiAbyss docs" }}
        result={{
          results: [
            {
              title: "PiAbyss documentation",
              url: "https://example.com/docs",
              snippet: "Documentation",
            },
          ],
        }}
      />,
    );

    const toggle = screen.getByRole("button", { expanded: false });
    const region = controlledRegion(toggle);
    await user.click(toggle);
    flushFrame();
    flushFrame();
    expect(region).toHaveAttribute("data-state", "open");
    const link = screen.getByRole("link", { name: /PiAbyss documentation/u });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).not.toHaveAttribute("target");
    expect(link).toHaveAttribute("title", expect.stringContaining("Open in Dock browser"));

    await user.click(link);
    expect(mocks.openChatLink).toHaveBeenLastCalledWith(
      "https://example.com/docs",
      expect.objectContaining({ button: 0 }),
    );

    middleClick(link);
    expect(mocks.openChatLink).toHaveBeenLastCalledWith(
      "https://example.com/docs",
      expect.objectContaining({ button: 1 }),
    );
  });

  it("uses the same disclosure lifecycle for specialized coding tools", () => {
    render(
      <ToolView
        name="exec_command"
        status="done"
        args={{ command: "pnpm test" }}
        result="All tests passed"
      />,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    const region = controlledRegion(toggle);

    fireEvent.click(toggle);
    expect(screen.getByText("All tests passed")).toBeInTheDocument();
    flushFrame();
    flushFrame();
    expect(region).toHaveAttribute("data-state", "open");

    fireEvent.click(toggle);
    expect(region).toHaveAttribute("aria-hidden", "true");
    expect(region).toHaveAttribute("inert");
    expect(screen.getByText("All tests passed")).toBeInTheDocument();
    fireEvent.transitionEnd(region, { propertyName: "grid-template-rows" });
    expect(screen.queryByText("All tests passed")).not.toBeInTheDocument();
  });
});
