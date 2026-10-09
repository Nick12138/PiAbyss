/**
 * Window-width auto collapse/expand policy for the left sidebar.
 *
 * Scenario constants mirror a realistic layout: conversation min 480,
 * sidebar 268, content-frame insets 32 → the window hits the expanded
 * floor at 780px. Collapse fires at floor + 4 (epsilon), expand at
 * floor + 120 (hysteresis).
 */
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_AUTO_EXPAND_HYSTERESIS,
  evaluateSidebarAutoAction,
  sidebarFloorWindowWidth,
} from "./sidebar-auto-collapse";

const CONVERSATION_MIN = 480;
const SIDEBAR_WIDTH = 268;
const FRAME_MARGIN = 32;
const FLOOR = sidebarFloorWindowWidth(CONVERSATION_MIN, SIDEBAR_WIDTH, FRAME_MARGIN);
const COLLAPSE_AT = FLOOR + 4;
const EXPAND_AT = FLOOR + SIDEBAR_AUTO_EXPAND_HYSTERESIS;

describe("sidebarFloorWindowWidth", () => {
  it("sums the conversation minimum, sidebar width and frame insets", () => {
    expect(FLOOR).toBe(780);
    expect(sidebarFloorWindowWidth(480, 0, 32)).toBe(512);
  });
});

describe("evaluateSidebarAutoAction", () => {
  it("collapses when a shrinking window reaches the expanded floor", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: FLOOR,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: 1000,
      }),
    ).toBe("collapse");
  });

  it("collapses even when the resize jumps far below the floor in one step", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 600,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: 1000,
      }),
    ).toBe("collapse");
  });

  it("collapses within the rounding epsilon above the floor, but not beyond it", () => {
    const input = (windowWidth: number) => ({
      windowWidth,
      expandedFloorWidth: FLOOR,
      sidebarCollapsed: false,
      sidebarAutoCollapsed: false,
      previousWindowWidth: 1000,
    });
    expect(evaluateSidebarAutoAction(input(COLLAPSE_AT))).toBe("collapse");
    expect(evaluateSidebarAutoAction(input(COLLAPSE_AT + 1))).toBeNull();
  });

  it("leaves an expanded sidebar alone while the conversation still has room", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 900,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: 1000,
      }),
    ).toBeNull();
  });

  it("collapses on the first evaluation when the window starts at/below the floor", () => {
    // A window restored (or opened) narrower than the expanded floor must
    // not keep the sidebar wedged in.
    expect(
      evaluateSidebarAutoAction({
        windowWidth: FLOOR,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: null,
      }),
    ).toBe("collapse");
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 900,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: null,
      }),
    ).toBeNull();
  });

  it("does not revert a manual expand while the window is still below the floor", () => {
    // The user expanded the sidebar at a narrow width (accepting the
    // squeeze); the next resize event must not immediately re-collapse it.
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 690,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: 700,
      }),
    ).toBeNull();
  });

  it("re-arms the collapse after the window climbs above the floor", () => {
    // Widened past the floor, then shrunk back onto it → crossing fires.
    expect(
      evaluateSidebarAutoAction({
        windowWidth: COLLAPSE_AT,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: false,
        sidebarAutoCollapsed: false,
        previousWindowWidth: COLLAPSE_AT + 20,
      }),
    ).toBe("collapse");
  });

  it("expands an auto-collapsed sidebar once the window clears the hysteresis band", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: EXPAND_AT,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
        previousWindowWidth: FLOOR,
      }),
    ).toBe("expand");
    expect(
      evaluateSidebarAutoAction({
        windowWidth: EXPAND_AT - 1,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
        previousWindowWidth: FLOOR,
      }),
    ).toBeNull();
  });

  it("never expands a manually collapsed sidebar, no matter how wide the window gets", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 4000,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: true,
        sidebarAutoCollapsed: false,
        previousWindowWidth: 1000,
      }),
    ).toBeNull();
  });

  it("keeps an auto-collapsed sidebar collapsed while the window shrinks further", () => {
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 600,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
        previousWindowWidth: 700,
      }),
    ).toBeNull();
  });

  it("expands on the first evaluation when a persisted auto-collapse meets a wide window", () => {
    // App restarted with a wide window while the sidebar had been
    // auto-collapsed — the automatic state resolves itself on mount.
    expect(
      evaluateSidebarAutoAction({
        windowWidth: 1200,
        expandedFloorWidth: FLOOR,
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
        previousWindowWidth: null,
      }),
    ).toBe("expand");
  });

  it("walks the full shrink → auto-collapse → widen → auto-expand lifecycle", () => {
    const input = (windowWidth: number, previousWindowWidth: number | null) => ({
      windowWidth,
      expandedFloorWidth: FLOOR,
      sidebarCollapsed: false,
      sidebarAutoCollapsed: false,
      previousWindowWidth,
    });
    // Drag from 1280 down towards the wall: still room at 800…
    expect(evaluateSidebarAutoAction(input(800, 1280))).toBeNull();
    // …onto the floor → collapse.
    expect(evaluateSidebarAutoAction(input(COLLAPSE_AT, 800))).toBe("collapse");
    // Collapsed now; widening inside the hysteresis band stays collapsed…
    expect(
      evaluateSidebarAutoAction({
        ...input(EXPAND_AT - 1, COLLAPSE_AT),
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
      }),
    ).toBeNull();
    // …past the band it springs back open.
    expect(
      evaluateSidebarAutoAction({
        ...input(EXPAND_AT, EXPAND_AT - 1),
        sidebarCollapsed: true,
        sidebarAutoCollapsed: true,
      }),
    ).toBe("expand");
  });
});
