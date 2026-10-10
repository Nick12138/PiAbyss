/**
 * Layout-motion suppression: a shared, time-boxed signal that tells
 * transition-animated layout (the settings nav's icon collapse) to render
 * the CURRENT change instantly instead of animating it.
 *
 * The rule mirrors the sidebar auto-collapse policy (lib/sidebar-auto-collapse.ts):
 * a width change reads as intentional motion only when the user is driving it —
 * a live window-edge drag, or a manual toggle. Everything else — the window
 * opening, a tray re-show, a snap, an automatic sidebar action at startup —
 * must simply appear at its settled size; animating there read as the UI
 * "moving on its own" (the sidebar growing from half width on every window
 * open, the settings nav sliding out at launch).
 *
 * Producers:
 *   • app-store's autoCollapseSidebar / autoExpandSidebar mark their instant
 *     (non-drag) commits via suppressLayoutMotion().
 *   • Components that classify resize streams (classifyDragResize) suppress
 *     on lone, programmatic resize events — window shown from tray, snap,
 *     restore, DPI change — while a live drag's dense burst stays animated.
 */
import { useEffect } from "react";
import { create } from "zustand";

/** How long a programmatic layout change suppresses transition animations.
 *  Long enough for the change to commit and paint at its settled size;
 *  interactive changes afterwards animate again immediately. */
const LAYOUT_MOTION_SUPPRESS_MS = 400;

/** Resize-burst classification: a live window-edge drag delivers resize
 *  events back-to-back (one per frame), while programmatic resizes arrive
 *  as at most a couple of lone events. Only a dense burst counts as a
 *  drag. Shared by the sidebar auto rule and the settings nav so the two
 *  can never disagree about what is "interactive". */
export const DRAG_RESIZE_BURST_MS = 250;
export const DRAG_RESIZE_BURST_MIN = 3;

interface LayoutMotionState {
  /** Epoch ms until which layout transitions are suppressed; 0 = animate. */
  suppressedUntil: number;
}

/** Internal store; exported for tests and the suppression hook. */
export const useLayoutMotionStore = create<LayoutMotionState>(() => ({
  suppressedUntil: 0,
}));

/** Mark the in-flight layout change as programmatic: transition-animated
 *  layout renders it instantly, at its settled size. */
export function suppressLayoutMotion(): void {
  useLayoutMotionStore.setState({ suppressedUntil: Date.now() + LAYOUT_MOTION_SUPPRESS_MS });
}

/** True while the latest layout change should render without animation.
 *  Re-renders when the suppression window expires. */
export function useLayoutMotionSuppressed(): boolean {
  const suppressedUntil = useLayoutMotionStore((s) => s.suppressedUntil);
  useEffect(() => {
    if (!suppressedUntil) return;
    const remaining = suppressedUntil - Date.now();
    const clear = () => useLayoutMotionStore.setState({ suppressedUntil: 0 });
    if (remaining <= 0) {
      clear();
      return;
    }
    const timer = setTimeout(clear, remaining + 16);
    return () => clearTimeout(timer);
  }, [suppressedUntil]);
  return suppressedUntil > Date.now();
}

/** Fold one resize event into the drag-burst classification.
 *  Feed the returned `at`/`count` into the next call; `isDrag` says whether
 *  this event belongs to a live interactive drag. */
export function classifyDragResize(
  previousAt: number,
  previousCount: number,
  now: number,
): { at: number; count: number; isDrag: boolean } {
  const inBurst = previousAt > 0 && now - previousAt < DRAG_RESIZE_BURST_MS;
  const count = inBurst ? previousCount + 1 : 1;
  return { at: now, count, isDrag: count >= DRAG_RESIZE_BURST_MIN };
}
