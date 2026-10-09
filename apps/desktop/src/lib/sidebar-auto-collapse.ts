/**
 * Window-width auto-collapse policy for the left sidebar (nav).
 *
 * The app keeps the conversation column at its configured minimum width.
 * The native window's minimum-width floor stays at the COLLAPSED-sidebar
 * level (conversation min + frame insets — see the floor effect in
 * Sidebar.tsx), because the OS only reads size constraints when a resize
 * drag starts: a floor that tracked the expanded sidebar would stall the
 * drag mid-shrink until the user released and re-grabbed the edge. This
 * policy provides the reactive protection instead:
 *
 *   • COLLAPSE — when a window resize brings the window width down to the
 *     expanded floor (conversation min + sidebar + insets: the point where
 *     the column has no room left beside the sidebar), the sidebar
 *     collapses by itself — instantly, inside the same resize event, so
 *     the drag continues into the freed space and the column never dips
 *     below its minimum.
 *
 *   • EXPAND — when the window later widens past the floor plus a
 *     hysteresis band, an auto-collapsed sidebar springs back open. Only
 *     an automatic collapse may be automatically expanded: a manually
 *     collapsed sidebar is the user's decision and stays collapsed no
 *     matter how wide the window gets (the `sidebarAutoCollapsed` flag in
 *     app-store is the authority).
 *
 * The collapse is edge-triggered — it fires only when a resize actually
 * crosses the threshold from above (or on the first evaluation after
 * mount). A manual expand while the window is still below the floor
 * therefore sticks; the next resize event does not silently revert it.
 */

/** Extra window width beyond the collapse point required before an
 * auto-collapsed sidebar expands again. Keeps the collapse and expand
 * thresholds apart so a window parked at the boundary (or a 1px resize
 * wiggle, or DPI-scale rounding) can never oscillate between the two. */
export const SIDEBAR_AUTO_EXPAND_HYSTERESIS = 120;

/** The collapse threshold sits a few pixels above the exact floor.
 * `window.innerWidth` is rounded while the floor is summed from fractional
 * computed styles and scale-factor conversions, so the exact crossing can
 * land 1–2px off the computed floor; a small epsilon makes sure it is
 * still seen. Collapsing a couple of pixels early is imperceptible. */
const SIDEBAR_COLLAPSE_EPSILON = 4;

export type SidebarAutoAction = "collapse" | "expand";

export interface SidebarAutoEvaluationInput {
  /** Live window (viewport) width in CSS pixels. */
  windowWidth: number;
  /** Window width at which the conversation column sits exactly at its
   * configured minimum while the sidebar is expanded: conversation min +
   * live sidebar width + content-frame insets. Computed with the same
   * helper the native window floor uses (which pins the sidebar width to
   * 0 — the OS floor stays at the collapsed level; see
   * `sidebarFloorWindowWidth`). */
  expandedFloorWidth: number;
  /** Current sidebar collapse state from app-store. */
  sidebarCollapsed: boolean;
  /** True only when the current collapse was applied by this policy (the
   * store clears it on every manual toggle). */
  sidebarAutoCollapsed: boolean;
  /** Window width observed at the previous evaluation, or null when this is
   * the first evaluation (mount / fresh subscription). */
  previousWindowWidth: number | null;
}

/** Window width at which the conversation column hits its configured minimum
 * for a given sidebar width: `conversationMinWidth + sidebarWidth +
 * frameMarginH`. Shared by the native window floor effect and the auto
 * collapse/expand watcher so the two can never drift apart. With
 * `sidebarWidth = 0` this is the collapsed-sidebar floor. */
export function sidebarFloorWindowWidth(
  conversationMinWidth: number,
  sidebarWidth: number,
  frameMarginH: number,
): number {
  return conversationMinWidth + sidebarWidth + frameMarginH;
}

/** Decide whether the window width demands an automatic sidebar collapse or
 * expand. Returns null when the current state should be left alone. */
export function evaluateSidebarAutoAction(
  input: SidebarAutoEvaluationInput,
): SidebarAutoAction | null {
  const collapseAt = input.expandedFloorWidth + SIDEBAR_COLLAPSE_EPSILON;
  const expandAt = input.expandedFloorWidth + SIDEBAR_AUTO_EXPAND_HYSTERESIS;

  if (!input.sidebarCollapsed) {
    // Edge-triggered: only a resize that crosses the threshold from above
    // collapses (or the first evaluation after mount, which treats any
    // at/below-floor width as a crossing). This keeps a manual expand while
    // the window is still narrow from being reverted by the next resize.
    const crossedBelow =
      input.previousWindowWidth === null || input.previousWindowWidth > collapseAt;
    return input.windowWidth <= collapseAt && crossedBelow ? "collapse" : null;
  }

  // Only an auto-collapse auto-expands; a manual collapse sticks until the
  // user (or an explicit reveal/toggle) opens the sidebar again.
  if (input.sidebarAutoCollapsed && input.windowWidth >= expandAt) return "expand";
  return null;
}
