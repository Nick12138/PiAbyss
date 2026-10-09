import { describe, expect, it } from "vitest";
import { POPOVER_EDGE_GUTTER, clampPopoverLeft } from "./popover-placement";

/** The pill panels' own width (`w-72` under the 14px root font size). */
const PILL_PANEL_WIDTH = 252;
/** The context-usage panel's own width (`w-64` under the 14px root font size). */
const CONTEXT_PANEL_WIDTH = 224;

describe("clampPopoverLeft", () => {
  it("keeps a panel centred on its pill when it fits the chat column", () => {
    expect(
      clampPopoverLeft({
        desiredLeft: 300 - PILL_PANEL_WIDTH / 2,
        panelWidth: PILL_PANEL_WIDTH,
        boundaryLeft: 100,
        boundaryRight: 700,
        viewportWidth: 800,
      }),
    ).toBe(300 - PILL_PANEL_WIDTH / 2);
  });

  it("pulls a centred panel back inside at the conversation's minimum width", () => {
    // 350px chat column, row centred: the leftmost pill's centred panel would
    // start 12px past the column's left edge, so it sits flush against the
    // edge plus the gutter instead of overflowing it.
    expect(
      clampPopoverLeft({
        desiredLeft: 113.5 - PILL_PANEL_WIDTH / 2,
        panelWidth: PILL_PANEL_WIDTH,
        boundaryLeft: 0,
        boundaryRight: 350,
        viewportWidth: 350,
      }),
    ).toBe(POPOVER_EDGE_GUTTER);
  });

  it("pulls a centred panel back when it would run past the right edge", () => {
    expect(
      clampPopoverLeft({
        desiredLeft: 550 - PILL_PANEL_WIDTH / 2,
        panelWidth: PILL_PANEL_WIDTH,
        boundaryLeft: 200,
        boundaryRight: 600,
        viewportWidth: 800,
      }),
    ).toBe(600 - POPOVER_EDGE_GUTTER - PILL_PANEL_WIDTH);
  });

  it("keeps a right-hung panel on its chip's right edge when it fits", () => {
    // Chip right edge at x=275 inside a 350px column flush with the window:
    // hanging the panel off that edge needs only 51px of the 334px visible.
    expect(
      clampPopoverLeft({
        desiredLeft: 275 - CONTEXT_PANEL_WIDTH,
        panelWidth: CONTEXT_PANEL_WIDTH,
        boundaryLeft: 0,
        boundaryRight: 350,
        viewportWidth: 350,
      }),
    ).toBe(275 - CONTEXT_PANEL_WIDTH);
  });

  it("shifts a right-hung panel left when its edge is past the window", () => {
    // Expanded sidebar pushing the chat column right of a 404px window: the
    // chip's right edge sits at x=522, off-window. The panel keeps its right
    // edge at the last visible pixel instead of overflowing the window.
    expect(
      clampPopoverLeft({
        desiredLeft: 522 - CONTEXT_PANEL_WIDTH,
        panelWidth: CONTEXT_PANEL_WIDTH,
        boundaryLeft: 250,
        boundaryRight: 600,
        viewportWidth: 404,
      }),
    ).toBe(404 - POPOVER_EDGE_GUTTER - CONTEXT_PANEL_WIDTH);
  });

  it("falls back to the window edge when the column is pushed outside", () => {
    // The sidebar can push the chat column part-way out of the window; the
    // visible edge is the stricter of the chat page and the window.
    expect(
      clampPopoverLeft({
        desiredLeft: 90 - CONTEXT_PANEL_WIDTH,
        panelWidth: CONTEXT_PANEL_WIDTH,
        boundaryLeft: -300,
        boundaryRight: 50,
        viewportWidth: 350,
      }),
    ).toBe(POPOVER_EDGE_GUTTER);
  });
});
