/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { Transcript } from "./Transcript";
import { MenuHost } from "../../components/Menu";
import { piWorkingVariants } from "../../lib/i18n";
import { PROGRESSIVE_BATCH_ROWS } from "./progressive-mount";
import { requestTranscriptScroll } from "../../lib/transcript-navigation";
import { clearTranscriptScrollPositions } from "./transcript-scroll-memory";
import { buildTranscriptRows } from "./transcript-model";

const linkMocks = vi.hoisted(() => ({
  requestDockBrowser: vi.fn(),
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/dock-browser", () => ({
  requestDockBrowser: linkMocks.requestDockBrowser,
}));

vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: linkMocks.openSystemUrl,
}));

const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function longSession(sessionId: string, messageCount: number): SessionSnapshot {
  return {
    ...session(sessionId, "seed"),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: "user" as const,
      content: `Message ${index + 1}`,
    })),
  };
}

function session(sessionId: string, text: string): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [{ role: "user", content: text }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

let nextIdleId = 1;
let idleCallbacks = new Map<number, () => void>();

function flushIdle() {
  act(() => {
    const pending = [...idleCallbacks.values()];
    idleCallbacks.clear();
    pending.forEach((callback) => callback());
  });
}

/** Each flush runs one mount batch; loop until the idle queue settles. */
function flushIdleToConvergence(maxBatches = 60) {
  for (let batch = 0; batch < maxBatches && idleCallbacks.size > 0; batch++) {
    flushIdle();
  }
}

describe("Transcript Session-open scrolling", () => {
  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    TestResizeObserver.instances = [];
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
    nextIdleId = 1;
    idleCallbacks = new Map();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        const id = nextIdleId++;
        idleCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => {
        idleCallbacks.delete(id);
      }),
    );
    useAppStore.setState({
      session: session(SESSION_A, "First Session"),
      desktopSettings: {
        theme: "system",
        language: "en",
        autoRestartHostOnce: true,
        extensionDecisionPresentation: "auto",
        terminalProfile: "auto",
      },
    });
    linkMocks.requestDockBrowser.mockReset().mockReturnValue(true);
    linkMocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
    clearTranscriptScrollPositions();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as { clipboard?: Clipboard }).clipboard;
    useAppStore.setState({ session: null, desktopSettings: null });
  });

  it("keeps a newly opened Session at the bottom through late content growth", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 900;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    flushFrames();
    expect(scroll.scrollTop).toBe(900);

    scrollHeight = 1_400;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(1_400);
  });

  it("stops following manual history reads and resets to the bottom for the next Session", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    flushFrames();

    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    scrollHeight = 1_300;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(100);

    scrollHeight = 1_700;
    act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
    flushFrames();
    expect(scroll.scrollTop).toBe(1_700);
  });

  it("releases a small upward gesture before a queued tail alignment", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 680;
    fireEvent.scroll(scroll);
    flushFrames();

    expect(scroll.scrollTop).toBe(680);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();

    scroll.scrollTop = 695;
    fireEvent.scroll(scroll);
    scrollHeight = 1_100;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();
    expect(scroll.scrollTop).toBe(800);
  });

  it("keeps following when content shrinkage lowers the maximum scroll position", () => {
    const { container } = render(<Transcript />);
    const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
    let scrollHeight = 1_000;
    const clientHeight = 300;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    flushFrames();
    expect(scroll.scrollTop).toBe(700);

    scrollHeight = 900;
    scroll.scrollTop = 600;
    fireEvent.scroll(scroll);
    scrollHeight = 950;
    act(() => TestResizeObserver.instances.at(-1)?.trigger());
    flushFrames();

    expect(scroll.scrollTop).toBe(650);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).not.toBeInTheDocument();
  });

  it("opens a row context menu and copies the complete message", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("First Session"));
  });

  it("adds Dock, external-browser, and copy actions when right-clicking a link", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    const row = container.querySelector<HTMLElement>(".transcript-row")!;
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.textContent = "Documentation";
    row.append(link);

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    expect(await screen.findByRole("menuitem", { name: "Open in Dock" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open in external browser" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy message" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Open in Dock" }));
    expect(linkMocks.requestDockBrowser).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Open in external browser" }));
    expect(linkMocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/docs");

    fireEvent.contextMenu(link, { clientX: 24, clientY: 32 });
    await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/docs"));

    expect(row).toBeInTheDocument();
  });

  it("leaves development Shift-right-click available for the native menu", () => {
    const { container } = render(
      <>
        <Transcript />
        <MenuHost />
      </>,
    );
    fireEvent.contextMenu(container.querySelector(".transcript-row")!, {
      clientX: 24,
      clientY: 32,
      shiftKey: true,
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows dangling tool calls as stopped after an interrupted Session becomes idle", () => {
    act(() =>
      useAppStore.setState({
        session: {
          ...session(SESSION_A, "Interrupted Session"),
          messages: [
            {
              role: "assistant",
              stopReason: "toolUse",
              content: [
                { type: "toolCall", id: "stale-a", name: "bash", arguments: {} },
                { type: "toolCall", id: "stale-b", name: "bash", arguments: {} },
              ],
            },
          ],
        },
      }),
    );

    render(<Transcript />);

    expect(screen.getByText("Stopped after 2 actions")).toBeInTheDocument();
    expect(screen.queryByText("Running 2 actions")).not.toBeInTheDocument();
  });

  describe("progressive mounting", () => {
    /** Fake metrics, then release the tail pin with an upward history read. */
    function unfollow(scroll: HTMLElement) {
      let scrollTop = 0;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 1_000 },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.max(0, Math.min(value, 700));
          },
        },
      });
      flushFrames();
      scroll.scrollTop = 650;
      fireEvent.scroll(scroll);
    }

    it("opens with only the tail mounted, then converges once the reader unpins", async () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 150) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(
        screen.getByRole("button", { name: "Show earlier messages (90 hidden)" }),
      ).toBeInTheDocument();

      unfollow(scroll);
      // A genuine user scroll pauses idle mounting for the quiet window.
      await new Promise((resolve) => setTimeout(resolve, 200));
      flushIdleToConvergence();

      expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
      expect(
        screen.queryByRole("button", { name: /Show earlier messages/ }),
      ).not.toBeInTheDocument();
    });

    it("yields idle mounting to a followed stream and converges after it settles", async () => {
      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: true, isIdle: false },
        }),
      );
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;

      expect(idleCallbacks.size).toBe(0);
      flushIdleToConvergence();
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      act(() =>
        useAppStore.setState({
          session: { ...longSession(SESSION_A, 150), isStreaming: false, isIdle: true },
        }),
      );
      unfollow(scroll);
      await new Promise((resolve) => setTimeout(resolve, 200));
      flushIdleToConvergence();
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(150);
    });

    it("jumps to an unmounted row, mounting it", () => {
      const longA = longSession(SESSION_A, 150);
      act(() => useAppStore.setState({ session: longA }));
      const { container } = render(<Transcript />);
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      const targetKey = buildTranscriptRows(longA.messages)[5]!.key;
      let handled = false;
      act(() => {
        handled = requestTranscriptScroll({ rowKey: targetKey });
      });

      expect(handled).toBe(true);
      // hidden dropped to the target index minus context rows (5 - 3 = 2).
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(148);
      expect(container.querySelector(`[data-row-key="${CSS.escape(targetKey)}"]`)).not.toBeNull();
    });

    it("restores the reading position when switching back to a session", () => {
      const longA = longSession(SESSION_A, 150);
      act(() => useAppStore.setState({ session: longA }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      unfollow(scroll);
      expect(scroll.scrollTop).toBe(650);

      act(() => useAppStore.setState({ session: session(SESSION_B, "Second Session") }));
      flushFrames();
      expect(scroll.scrollTop).toBe(700);

      act(() => useAppStore.setState({ session: longA }));
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);
      expect(scroll.scrollTop).toBe(650);
      expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
    });

    it("mounts the next batch synchronously when the reader nears the top edge", () => {
      act(() => useAppStore.setState({ session: longSession(SESSION_A, 300) }));
      const { container } = render(<Transcript />);
      const scroll = container.querySelector<HTMLElement>("[data-transcript-scroll]")!;
      Object.defineProperties(scroll, {
        clientHeight: { configurable: true, get: () => 300 },
        scrollHeight: { configurable: true, get: () => 2_000 },
        scrollTop: { configurable: true, writable: true, value: 500 },
      });
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(60);

      fireEvent.scroll(scroll);

      // One synchronous boost batch at the initial adaptive size.
      expect(container.querySelectorAll(".transcript-row")).toHaveLength(
        60 + PROGRESSIVE_BATCH_ROWS,
      );
    });
  });

  describe("working status placeholder", () => {
    function workingSession() {
      return { ...session(SESSION_A, "First Session"), isStreaming: true, isIdle: false };
    }

    const enVariants = piWorkingVariants("en");
    /** Matches the playful status span (never the static "Pi is working..." fallback). */
    function statusSpan(element: Element | null): element is HTMLSpanElement {
      return element?.tagName === "SPAN" && enVariants.includes(element.textContent ?? "");
    }
    function currentStatus(): string {
      const span = screen.getAllByText((content, element) => statusSpan(element)).at(-1)!;
      return span.textContent!;
    }

    it("picks a random status when the Transcript mounts into an already-working Session", () => {
      act(() => useAppStore.setState({ session: workingSession() }));
      render(<Transcript />);

      expect(enVariants).toContain(currentStatus());
      expect(screen.queryByText("Pi is working...")).not.toBeInTheDocument();
    });

    it("picks a random status when an idle Session starts working", () => {
      render(<Transcript />);
      act(() => useAppStore.setState({ session: workingSession() }));

      expect(enVariants).toContain(currentStatus());
      expect(screen.queryByText("Pi is working...")).not.toBeInTheDocument();
    });

    it("keeps the status stable across snapshot updates within one request", () => {
      act(() => useAppStore.setState({ session: workingSession() }));
      render(<Transcript />);

      const first = currentStatus();
      act(() =>
        useAppStore.setState({
          session: { ...workingSession(), revision: 2, isIdle: false },
        }),
      );
      expect(currentStatus()).toBe(first);
    });

    it("clears the status once the Session goes idle again", () => {
      act(() => useAppStore.setState({ session: workingSession() }));
      render(<Transcript />);
      expect(enVariants).toContain(currentStatus());

      act(() => useAppStore.setState({ session: session(SESSION_A, "First Session") }));
      expect(screen.queryByText((content, element) => statusSpan(element))).not.toBeInTheDocument();
    });

    it("picks a fresh random status for the next request in the same Session", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        act(() => useAppStore.setState({ session: workingSession() }));
        render(<Transcript />);
        expect(currentStatus()).toBe(enVariants[0]);

        random.mockReturnValue(0.5);
        act(() => useAppStore.setState({ session: session(SESSION_A, "First Session") }));
        act(() => useAppStore.setState({ session: workingSession() }));

        expect(currentStatus()).toBe(enVariants[Math.floor(0.5 * enVariants.length)]);
      } finally {
        random.mockRestore();
      }
    });
  });

  describe("retry button", () => {
    const HOST_ID = "11111111-1111-4111-8111-111111111111";

    function host(): HostStatusSnapshot {
      return {
        protocolVersion: 1,
        hostInstanceId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRevision: 1,
        sessionId: SESSION_A,
        sessionRevision: 1,
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

    function sessionWithMessages(messages: SessionSnapshot["messages"]): SessionSnapshot {
      return { ...session(SESSION_A, "First Session"), messages };
    }

    it("shows a retry button after a failed answer, re-sends it, and clears the failed bubble", async () => {
      useAppStore.getState().setHost(host());
      useAppStore.getState().setWorkspace(workspace());
      useAppStore.getState().applySessionSnapshot(
        sessionWithMessages([
          { role: "user", content: "First Session" },
          { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider failed" },
        ]),
      );
      const request = vi.spyOn(hostClient, "request").mockResolvedValue({
        ok: true,
        result: { accepted: true, runId: "run-1" },
      } as never);

      const { container } = render(<Transcript />);
      const user = userEvent.setup();
      const retryButton = await screen.findByRole("button", { name: "Retry" });
      await user.click(retryButton);

      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "agent.prompt",
          expect.objectContaining({
            expectedHostInstanceId: HOST_ID,
            expectedSessionId: SESSION_A,
          }),
          { text: "First Session" },
          null,
        ),
      );
      await waitFor(() =>
        expect(container.querySelector('[data-row-key="assistant:1"]')).not.toBeInTheDocument(),
      );
      request.mockRestore();
    });

    it("hides the retry button once a complete answer exists", () => {
      useAppStore.getState().setHost(host());
      useAppStore.getState().setWorkspace(workspace());
      useAppStore.getState().applySessionSnapshot(
        sessionWithMessages([
          { role: "user", content: "First Session" },
          { role: "assistant", content: "ok" },
        ]),
      );
      render(<Transcript />);
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("shows a Go On button on the latest failed answer and sends 'Continue'", async () => {
      useAppStore.getState().setHost(host());
      useAppStore.getState().setWorkspace(workspace());
      useAppStore.getState().applySessionSnapshot(
        sessionWithMessages([
          { role: "user", content: "First message" },
          { role: "assistant", content: [], stopReason: "error", errorMessage: "First failure" },
          { role: "user", content: "Second message" },
          { role: "assistant", content: [], stopReason: "error", errorMessage: "Second failure" },
        ]),
      );
      let resolvePrompt!: (value: unknown) => void;
      const request = vi.spyOn(hostClient, "request").mockReturnValue(
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }) as never,
      );

      render(<Transcript />);
      const user = userEvent.setup();

      // Only 1 Go On button rendered even though there are 2 failed turns
      const goOnButtons = screen.getAllByRole("button", { name: "Go On" });
      expect(goOnButtons).toHaveLength(1);

      await user.click(goOnButtons[0]);

      // The optimistic Continue row appears immediately — before the Host
      // request resolves.
      expect(await screen.findByText("Continue")).toBeInTheDocument();

      resolvePrompt({
        ok: true,
        result: { accepted: true, runId: "run-2" },
      });
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "agent.prompt",
          expect.objectContaining({
            expectedHostInstanceId: HOST_ID,
            expectedSessionId: SESSION_A,
          }),
          { text: "Continue" },
          null,
        ),
      );
      request.mockRestore();
    });
  });
});
