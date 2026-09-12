/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantOrderedContent, ExecutionTrace, ThinkingBlock } from "./Transcript";
import { useAppStore } from "../../lib/stores/app-store";

vi.mock("./MarkdownMessage", () => ({
  MarkdownMessage: ({ content, className }: { content: string; className?: string }) => (
    <div className={className}>{content}</div>
  ),
}));

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve() {}
  disconnect() {
    this.target = null;
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

function setScrollMetrics(element: HTMLElement, initialHeight = 800) {
  let scrollHeight = initialHeight;
  const clientHeight = 320;
  let scrollTop = 0;
  const setScrollTop = (value: number) => {
    scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
  };
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => setScrollTop(top ?? 0));
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: setScrollTop,
    },
    scrollTo: { configurable: true, value: scrollTo },
  });
  return {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      setScrollTop(value);
    },
    setScrollHeight(value: number) {
      scrollHeight = value;
    },
    scrollTo,
  };
}

function triggerThoughtResize() {
  const observer = TestResizeObserver.instances.find((instance) =>
    instance.target?.hasAttribute("data-thinking-content"),
  );
  expect(observer).toBeDefined();
  act(() => observer?.trigger());
}

describe("ThinkingBlock scrolling", () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
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
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ desktopSettings: null });
  });

  it("caps long streaming content and follows its tail until the reader scrolls upward", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkingBlock content="Initial thought" defaultOpen streaming />);
    const scroll = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-thinking-scroll]");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const metrics = setScrollMetrics(scroll);

    triggerThoughtResize();
    expect(scroll).toHaveClass("thinking-scroll-region", "overflow-y-auto");
    expect(scroll).toHaveAttribute("role", "region");
    expect(scroll).toHaveAttribute("aria-label", "Thinking");
    expect(scroll).toHaveAttribute("tabindex", "0");
    expect(metrics.scrollTop).toBe(480);
    expect(scroll).toHaveAttribute("data-following", "true");

    expect(fireEvent.wheel(scroll, { deltaY: -24 })).toBe(true);
    metrics.scrollTop = 120;
    fireEvent.scroll(scroll);
    expect(scroll).toHaveAttribute("data-following", "false");
    expect(screen.getByRole("button", { name: "Jump to latest thought" })).toBeInTheDocument();

    // The reader scrolls without clicking the header — the block still folds
    // once the reasoning ends (see the auto-collapse suite below).
    metrics.setScrollHeight(1_000);
    rerender(
      <ThinkingBlock content="Initial thought with more streamed text" defaultOpen streaming />,
    );
    triggerThoughtResize();
    expect(metrics.scrollTop).toBe(120);

    // Pin the disclosure open by hand (two clicks: close then re-open) so the
    // mid-read tail bubble below is tested independently of the auto-fold, and
    // so the settled rerender keeps its content mounted.
    const toggle = () => screen.getByRole("button", { name: "Thinking" });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    rerender(
      <ThinkingBlock
        content="Initial thought with more streamed text"
        defaultOpen={false}
        streaming={false}
      />,
    );
    expect(document.querySelector("[data-thinking-scroll]")).toBeInTheDocument();

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    metrics.scrollTop = 120;
    fireEvent.scroll(scroll);
    expect(scroll).toHaveAttribute("data-following", "false");
    await user.click(screen.getByRole("button", { name: "Jump to latest thought" }));
    expect(metrics.scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" });
    expect(scroll).toHaveAttribute("data-following", "true");

    metrics.setScrollHeight(1_200);
    rerender(<ThinkingBlock content="A later streaming update" defaultOpen streaming />);
    triggerThoughtResize();
    expect(metrics.scrollTop).toBe(880);
  });

  it("keeps a static thought top-aligned when it is opened", async () => {
    render(<ThinkingBlock content="Historical thought" defaultOpen />);
    const scroll = await waitFor(() =>
      document.querySelector<HTMLElement>("[data-thinking-scroll]"),
    );
    expect(scroll).not.toBeNull();
    const metrics = setScrollMetrics(scroll!);

    triggerThoughtResize();

    expect(metrics.scrollTop).toBe(0);
  });

  it("does not treat wheel handoff over short content as reading older thoughts", async () => {
    const { rerender } = render(<ThinkingBlock content="Short thought" defaultOpen streaming />);
    const scroll = await waitFor(() =>
      document.querySelector<HTMLElement>("[data-thinking-scroll]"),
    );
    expect(scroll).not.toBeNull();
    setScrollMetrics(scroll!, 200);

    triggerThoughtResize();
    expect(scroll).not.toHaveAttribute("role");
    expect(fireEvent.wheel(scroll!, { deltaY: -24 })).toBe(true);

    rerender(<ThinkingBlock content="Short thought" defaultOpen={false} streaming={false} />);
    const region = scroll!.closest<HTMLElement>("[data-collapsible-region]");
    expect(region).toHaveAttribute("data-state", "closed");
    expect(document.querySelector("[data-thinking-scroll]")).toBeInTheDocument();
    fireEvent.transitionEnd(region!, { propertyName: "grid-template-rows" });
    expect(document.querySelector("[data-thinking-scroll]")).not.toBeInTheDocument();
  });

  it("uses the shared disclosure motion for an execution trace", async () => {
    render(
      <ExecutionTrace
        blocks={[{ kind: "text", text: "Trace detail" }]}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );
    const toggle = screen.getByRole("button", { name: "1 action completed" });
    const region = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(region).toHaveAttribute("data-state", "closed");
    expect(screen.queryByText("Trace detail")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(region).toHaveAttribute("data-state", "closed");
    await waitFor(() => expect(screen.getByText("Trace detail")).toBeInTheDocument());
    flushFrame();
    flushFrame();
    expect(region).toHaveAttribute("data-state", "open");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region).toHaveAttribute("data-state", "closed");
    expect(screen.getByText("Trace detail")).toBeInTheDocument();
    fireEvent.transitionEnd(region!, { propertyName: "grid-template-rows" });
    expect(screen.queryByText("Trace detail")).not.toBeInTheDocument();
  });

  it("expands the process while the turn runs and folds it after completion", async () => {
    const blocks = [{ kind: "text" as const, text: "Trace detail" }];
    const { rerender } = render(
      <ExecutionTrace
        blocks={blocks}
        stepCount={1}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );

    const toggle = screen.getByRole("button", { name: "Running 1 action" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByText("Trace detail")).toBeInTheDocument());

    rerender(
      <ExecutionTrace
        blocks={blocks}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const settled = screen.getByRole("button", { name: "1 action completed" });
    expect(settled).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(settled.getAttribute("aria-controls")!);
    expect(region).toHaveAttribute("data-state", "closed");
    fireEvent.transitionEnd(region!, { propertyName: "grid-template-rows" });
    expect(screen.queryByText("Trace detail")).not.toBeInTheDocument();
  });

  it("keeps a manual toggle across active transitions", () => {
    const blocks = [{ kind: "text" as const, text: "Trace detail" }];
    const { rerender } = render(
      <ExecutionTrace
        blocks={blocks}
        stepCount={1}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );

    const toggle = screen.getByRole("button", { name: "Running 1 action" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Still active: the manual collapse survives the active sync.
    rerender(
      <ExecutionTrace
        blocks={blocks}
        stepCount={1}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The turn completes: the manual expansion survives the fold.
    rerender(
      <ExecutionTrace
        blocks={blocks}
        stepCount={1}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );
    expect(screen.getByRole("button", { name: "1 action completed" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("ThinkingBlock auto-collapse when reasoning ends", () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    nextFrameId = 1;
    frames = new Map();
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
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
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ desktopSettings: null });
  });

  function thinkingToggle() {
    return screen.getByRole("button", { name: /Thought process|Thinking/ });
  }

  it("folds as soon as the thought reports its end, while the turn still streams", () => {
    const thought = { kind: "thinking" as const, text: "Reasoning", endedAt: undefined };
    const { rerender } = render(
      <AssistantOrderedContent blocks={[thought]} mode="streaming" showCaret turnActive />,
    );
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "true");

    // Same streaming render path — only the thought itself has ended.
    rerender(
      <AssistantOrderedContent
        blocks={[{ kind: "thinking", text: "Reasoning", endedAt: 1_000 }]}
        mode="streaming"
        showCaret
        turnActive
      />,
    );
    const toggle = thinkingToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(region).toHaveAttribute("data-state", "closed");
  });

  it("folds a finished thought even while a tool call keeps the trace running", () => {
    const tool = {
      kind: "tool" as const,
      tool: { id: "t1", name: "bash", status: "running" as const },
    };
    const { rerender } = render(
      <ExecutionTrace
        blocks={[tool, { kind: "thinking", text: "Reasoning" }]}
        stepCount={1}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ExecutionTrace
        blocks={[tool, { kind: "thinking", text: "Reasoning", endedAt: 1_000 }]}
        stepCount={1}
        mode="streaming"
        showCaret={false}
        turnActive
      />,
    );
    // The trace itself is still active (its tool is running)…
    expect(screen.getByRole("button", { name: "Running 1 action" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // …but the reasoning inside it has already folded.
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("does not let reading the thought body pin it open", async () => {
    const { rerender } = render(<ThinkingBlock content="Long reasoning" defaultOpen streaming />);
    const scroll = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-thinking-scroll]");
      expect(element).toBeInTheDocument();
      return element!;
    });
    const metrics = setScrollMetrics(scroll);
    triggerThoughtResize();

    // The reader scrolls up to read earlier reasoning.
    fireEvent.wheel(scroll, { deltaY: -24 });
    metrics.scrollTop = 0;
    fireEvent.scroll(scroll);
    expect(scroll).toHaveAttribute("data-following", "false");

    // Reasoning ends: the block still folds rather than staying pinned open.
    rerender(<ThinkingBlock content="Long reasoning" defaultOpen streaming ended />);
    const toggle = screen.getByRole("button", { name: "Thinking" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("still honours a deliberate click on the header", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkingBlock content="Reasoning" defaultOpen streaming />);
    const toggle = screen.getByRole("button", { name: "Thinking" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Re-opened by hand; the automatic fold must not override the reader.
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    rerender(<ThinkingBlock content="Reasoning" defaultOpen streaming ended />);
    expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
