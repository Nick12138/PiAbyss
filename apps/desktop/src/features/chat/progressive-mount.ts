/**
 * Idle-time progressive mounting for the transcript.
 *
 * The transcript opens with only its tail mounted and then converges toward a
 * fully mounted DOM during idle time, so row-level navigation (outline, find,
 * scroll restoration) can rely on target rows existing. Mounted rows render
 * at their real height immediately — estimated placeholder heights (e.g.
 * `content-visibility` intrinsic sizes) drift during upward scrolling, so the
 * cost model is instead "small batches, each fully laid out". Sessions larger
 * than {@link FULL_MOUNT_MAX_ROWS} keep their oldest rows behind the manual
 * "show earlier" control as a memory escape hatch.
 */

/**
 * Upper bound on automatically mounted rows per session.
 *
 * Every auto-mounted row is a live DOM subtree with text, code highlighting
 * and layout boxes — a long session settles at hundreds of MB of renderer
 * memory once it converges. 1200 keeps a working window around the reader
 * (and all of it reachable through "show earlier") while bounding that cost.
 */
export const FULL_MOUNT_MAX_ROWS = 1200;

/**
 * Initial rows per idle slice. Each mounted row pays full render and layout;
 * {@link createBatchSizer} then adapts the batch size to measured cost so a
 * slice stays within roughly one frame of idle-time work.
 */
export const PROGRESSIVE_BATCH_ROWS = 16;

/** Target main-thread time for one mount batch. */
const BATCH_TIME_BUDGET_MS = 12;

const MIN_BATCH_ROWS = 4;
const MAX_BATCH_ROWS = 200;

/** Idle mounting stays paused while the reader scrolled within this window. */
export const SCROLL_QUIET_MS = 150;

export type BatchSizer = {
  size: () => number;
  record: (durationMs: number) => void;
};

/**
 * Adapts rows-per-batch to the session's measured row cost: heavy markdown
 * shrinks batches to stay smooth, light chatter grows them to converge fast.
 */
export function createBatchSizer(initial = PROGRESSIVE_BATCH_ROWS): BatchSizer {
  let rows = initial;
  return {
    size: () => rows,
    record: (durationMs) => {
      if (durationMs > BATCH_TIME_BUDGET_MS * 1.5) {
        rows = Math.max(MIN_BATCH_ROWS, Math.floor(rows / 2));
      } else if (durationMs < BATCH_TIME_BUDGET_MS * 0.6) {
        rows = Math.min(MAX_BATCH_ROWS, Math.ceil(rows * 1.5));
      }
    },
  };
}

/**
 * When the reader is closer to the top of the mounted region than this many
 * viewport heights, the next batch mounts synchronously so fast upward
 * scrolling never hits the edge.
 */
export const NEAR_TOP_BOOST_VIEWPORTS = 2;

/**
 * Force a scheduled batch to run even under sustained load once it has waited
 * this long; streaming-sensitive callers guard before scheduling instead.
 */
const IDLE_TIMEOUT_MS = 500;

/** Fallback pacing for hosts without requestIdleCallback (e.g. WKWebView). */
const FALLBACK_DELAY_MS = 48;

/**
 * The hidden-row floor the idle loop converges to. Rows below the floor are
 * only reachable through the manual "show earlier" control.
 */
export function autoMountFloor(rowCount: number, cap = FULL_MOUNT_MAX_ROWS): number {
  return Math.max(0, rowCount - cap);
}

type IdleCallbackHost = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Schedule one mount batch during idle time. Returns a cancel function; the
 * caller reschedules from its effect when the batch changes state.
 */
export function scheduleIdleMount(run: () => void): () => void {
  const host = globalThis as IdleCallbackHost;
  if (typeof host.requestIdleCallback === "function") {
    const id = host.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => host.cancelIdleCallback?.(id);
  }
  const id = setTimeout(run, FALLBACK_DELAY_MS);
  return () => clearTimeout(id);
}
