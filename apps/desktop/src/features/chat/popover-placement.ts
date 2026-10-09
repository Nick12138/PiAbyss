/**
 * Horizontal placement for the small popovers anchored to the stats chips
 * under the composer (the session-stats and token-usage pill panels and the
 * context-usage chip's panel). Each panel keeps a pure-CSS resting position
 * — centred on its pill, or hanging off its chip's right edge — and this
 * module adds the measured clamp that keeps it inside the visible chat
 * column while it is open.
 *
 * The column can be as narrow as the conversation minimum (350px) — too
 * narrow for a centred panel on the row's outer pills — and it can even be
 * pushed part-way out of the window by the sidebar or dock, so the clamp
 * prefers the chat page clipped to the window and falls back to the window
 * itself when that visible column cannot hold the panel.
 */

import { useLayoutEffect, useState, type RefObject } from "react";

/** Gutter kept between a popover panel and the visible edge. */
export const POPOVER_EDGE_GUTTER = 8;

/** Clamp `desired` into the horizontal range that fits a `width`-wide panel
 * between `left` and `right` (both already gutter-adjusted): a range narrower
 * than the panel anchors the panel at `left` instead. */
function clampIntoRange(desired: number, width: number, left: number, right: number): number {
  return Math.min(Math.max(desired, left), Math.max(left, right - width));
}

/** Left edge (viewport space) for an anchored popover panel: `desiredLeft`
 * when it fits, otherwise shifted just enough to stay inside the visible
 * chat column — the chat page clipped to the window, minus the gutter.
 *
 * When even that visible column cannot hold the panel (the sidebar or dock
 * pushed the chat page mostly out of the window), the window itself becomes
 * the boundary: overlaying the sidebar or dock beats being clipped by the
 * window edge, on either side. */
export function clampPopoverLeft(args: {
  desiredLeft: number;
  panelWidth: number;
  boundaryLeft: number;
  boundaryRight: number;
  viewportWidth: number;
}): number {
  const windowLeft = POPOVER_EDGE_GUTTER;
  const windowRight = args.viewportWidth - POPOVER_EDGE_GUTTER;
  const chatLeft = Math.max(args.boundaryLeft, 0) + POPOVER_EDGE_GUTTER;
  const chatRight = Math.min(args.boundaryRight, args.viewportWidth) - POPOVER_EDGE_GUTTER;
  if (chatRight - chatLeft >= args.panelWidth) {
    return clampIntoRange(args.desiredLeft, args.panelWidth, chatLeft, chatRight);
  }
  return clampIntoRange(args.desiredLeft, args.panelWidth, windowLeft, windowRight);
}

/**
 * Clamped left offset (px, relative to the anchor element) for a popover
 * panel while it is open; null until first measured, so the caller's CSS
 * resting position stands. `align` picks the desired position the clamp
 * starts from: "center" centres the panel on its anchor (the pill panels),
 * "right" hangs it off the anchor's right edge (the context-usage panel).
 * Re-measures on window resize and on chat column or anchor size changes
 * (sidebar/dock toggles, live label edits).
 */
export function usePopoverLeft(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  align: "center" | "right",
): number | null {
  const [left, setLeft] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const chatPage = anchor.closest<HTMLElement>("[data-chat-page]");
    const measure = () => {
      const panelWidth = panel.offsetWidth;
      // jsdom has no layout: keep the CSS resting position instead of guessing.
      if (panelWidth === 0) return;
      const anchorRect = anchor.getBoundingClientRect();
      const chatRect = chatPage?.getBoundingClientRect();
      const desiredLeft =
        align === "center"
          ? anchorRect.left + anchorRect.width / 2 - panelWidth / 2
          : anchorRect.right - panelWidth;
      const next = Math.round(
        clampPopoverLeft({
          desiredLeft,
          panelWidth,
          boundaryLeft: chatRect?.left ?? 0,
          boundaryRight: chatRect?.right ?? window.innerWidth,
          viewportWidth: window.innerWidth,
        }) - anchorRect.left,
      );
      setLeft((current) => (current === next ? current : next));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (chatPage) observer?.observe(chatPage);
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [open, anchorRef, panelRef, align]);

  return left;
}
