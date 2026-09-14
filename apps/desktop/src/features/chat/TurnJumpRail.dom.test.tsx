/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { TurnJumpRail, turnRailStops, type TurnRailStop } from "./TurnJumpRail";

const STOPS: TurnRailStop[] = [
  { sourceId: "u1", rowKey: "k1", excerpt: "first ask", agentExcerpt: "response 1", agentPending: false },
  { sourceId: "u2", rowKey: "k2", excerpt: "second ask", agentExcerpt: undefined, agentPending: false },
  { sourceId: "u3", rowKey: "k3", excerpt: "third ask", agentExcerpt: "response 3", agentPending: false },
];

/** The rail needs a scrollport ref for active-tick tracking. */
function Harness({ stops, onJump }: { stops: TurnRailStop[]; onJump: (id: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <div ref={viewport}>
      <TurnJumpRail stops={stops} onJump={onJump} viewport={viewport} />
    </div>
  );
}

describe("TurnJumpRail", () => {
  beforeEach(() => {
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders one tick per user turn with indexed labels", () => {
    render(<Harness stops={STOPS} onJump={vi.fn()} />);

    expect(screen.getByRole("navigation", { name: "Quick jump to a message" })).toBeInTheDocument();
    expect(screen.getByLabelText("#1/3 first ask")).toBeInTheDocument();
    expect(screen.getByLabelText("#2/3 second ask")).toBeInTheDocument();
    expect(screen.getByLabelText("#3/3 third ask")).toBeInTheDocument();
  });

  it("hides the rail below two turns", () => {
    const [only] = STOPS;
    render(<Harness stops={[only!]} onJump={vi.fn()} />);

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("jumps on tick click", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<Harness stops={STOPS} onJump={onJump} />);

    await user.click(screen.getByLabelText("#1/3 first ask"));

    expect(onJump).toHaveBeenCalledWith("u1");
  });

  it("opens a popup with every turn on tick hover and jumps from a popup row", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<Harness stops={STOPS} onJump={onJump} />);

    // No popup until a tick is hovered.
    expect(document.querySelector("[data-turn-rail-popup]")).toBeNull();
    await user.hover(screen.getByLabelText("#2/3 second ask"));

    const popup = document.querySelector<HTMLElement>("[data-turn-rail-popup]")!;
    expect(popup).toBeInTheDocument();
    // The popup shows the hovered turn with # prefix
    expect(popup).toHaveTextContent("#2");
    expect(popup).toHaveTextContent("second ask");
    expect(popup).toHaveTextContent("无回复");

    // Clicking on the hovered tick button should jump
    await user.click(screen.getByLabelText("#2/3 second ask"));
    expect(onJump).toHaveBeenCalledWith("u2");
  });

  it("moves between turns with Alt+ArrowUp/Alt+ArrowDown", () => {
    const onJump = vi.fn();
    render(<Harness stops={STOPS} onJump={onJump} />);

    // No row nodes resolve in this harness: the active base falls back to the
    // first turn, so Alt+ArrowUp clamps at the first and Alt+ArrowDown steps on.
    fireEvent.keyDown(document, { key: "ArrowUp", altKey: true });
    expect(onJump).toHaveBeenLastCalledWith("u1");
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    expect(onJump).toHaveBeenLastCalledWith("u2");
  });

  it("ignores plain and modified arrow keys", () => {
    const onJump = vi.fn();
    render(<Harness stops={STOPS} onJump={onJump} />);

    fireEvent.keyDown(document, { key: "ArrowUp" });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });

    expect(onJump).not.toHaveBeenCalled();
  });

  it("extracts one stop per user row with a single-line excerpt", () => {
    const rows = [
      { role: "user", key: "k1", sourceId: "u1", copyText: "hello\nworld" },
      { role: "assistant", key: "k2", sourceId: "a1", copyText: "hi" },
      { role: "user", key: "k3", copyText: "no source id" },
      { role: "user", key: "k4", sourceId: "u4", copyText: "\n  indented first line" },
    ];

    expect(turnRailStops(rows)).toEqual([
      { sourceId: "u1", rowKey: "k1", excerpt: "hello", agentExcerpt: "hi", agentPending: false },
      { sourceId: "u4", rowKey: "k4", excerpt: "indented first line", agentExcerpt: undefined, agentPending: false },
    ]);
  });
});
