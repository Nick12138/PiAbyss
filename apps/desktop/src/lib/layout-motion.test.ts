/** lib/layout-motion: drag-burst classification and the time-boxed
 *  suppression signal that keeps programmatic layout changes from
 *  animating transition-driven layout (the settings nav). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAG_RESIZE_BURST_MIN,
  DRAG_RESIZE_BURST_MS,
  classifyDragResize,
  suppressLayoutMotion,
  useLayoutMotionStore,
} from "./layout-motion";

describe("classifyDragResize", () => {
  it("treats lone events as programmatic until the burst threshold", () => {
    // First event after a long gap (window open / tray re-show / snap).
    let state = classifyDragResize(0, 0, 1000);
    expect(state.isDrag).toBe(false);

    // Second event quickly after — still below the threshold.
    state = classifyDragResize(state.at, state.count, 1000 + 16);
    expect(state.isDrag).toBe(false);

    // Third back-to-back event — a live drag.
    state = classifyDragResize(state.at, state.count, state.at + 16);
    expect(state.isDrag).toBe(true);
  });

  it("resets the burst after a gap longer than the window", () => {
    let state = classifyDragResize(0, 0, 1000);
    state = classifyDragResize(state.at, state.count, state.at + 16);
    state = classifyDragResize(state.at, state.count, state.at + 16);
    expect(state.isDrag).toBe(true);

    // A pause past the burst window restarts the count from one.
    state = classifyDragResize(state.at, state.count, state.at + DRAG_RESIZE_BURST_MS + 50);
    expect(state.count).toBe(1);
    expect(state.isDrag).toBe(false);
  });

  it("keeps a continuous stream classified as a drag", () => {
    let state = classifyDragResize(0, 0, 0);
    for (let i = 0; i < 30; i += 1) {
      state = classifyDragResize(state.at, state.count, state.at + 16);
      if (i >= DRAG_RESIZE_BURST_MIN - 1) expect(state.isDrag).toBe(true);
    }
  });
});

describe("suppressLayoutMotion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLayoutMotionStore.setState({ suppressedUntil: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a time-boxed suppression window from now", () => {
    const now = Date.now();
    suppressLayoutMotion();
    const until = useLayoutMotionStore.getState().suppressedUntil;
    expect(until).toBeGreaterThan(now);
    expect(until).toBeLessThanOrEqual(now + 500);
  });

  it("clears once the suppression window has passed", () => {
    suppressLayoutMotion();
    expect(useLayoutMotionStore.getState().suppressedUntil).toBeGreaterThan(0);

    vi.advanceTimersByTime(1000);
    // The expiry is applied by the hook's timer; the store itself only
    // ever moves forward, so a stale timestamp simply reads as inactive.
    expect(Date.now()).toBeGreaterThanOrEqual(useLayoutMotionStore.getState().suppressedUntil);
  });
});
