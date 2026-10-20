/**
 * Imperative row-level navigation into the active transcript.
 *
 * Follows the request/subscribe pattern: the mounted Transcript
 * registers a handler, and any feature (outline, find, global search) can ask
 * it to bring a row into view without holding a component reference.
 */

export type TranscriptScrollRequest = {
  /** Stable transcript row key (TranscriptRow.key). */
  rowKey?: string;
  /** A session entry id (TranscriptRow.sourceId/sourceEndId) to bring into view. */
  sourceId?: string;
  /**
   * Text to land on inside the row (e.g. the global-search term). The row is
   * scrolled so the first rendered occurrence sits at the top of the viewport
   * and flashes briefly. Absent = center the row as before.
   */
  focusText?: string;
};

type TranscriptScrollHandler = (request: TranscriptScrollRequest) => boolean;

const handlers = new Set<TranscriptScrollHandler>();

/**
 * 「打开会话后立刻跳消息」的请求要等新的 Transcript 挂载（或换行）后才能落地，
 * 所以先挂在这里；订阅/换行时由 flushPendingTranscriptScroll 补投。
 * 超出 TTL 的请求直接丢弃——再晚的重试已经不是用户刚才那次点击了。
 */
const PENDING_TTL_MS = 10_000;
let pending: { request: TranscriptScrollRequest; at: number } | null = null;

/** Ask the active transcript to scroll a row into view. True when handled. */
export function requestTranscriptScroll(request: TranscriptScrollRequest): boolean {
  for (const handler of handlers) {
    try {
      if (handler(request)) return true;
    } catch {
      // A broken handler must not block other subscribers.
    }
  }
  return false;
}

/**
 * Ask the transcript to scroll a row into view, tolerating the gap between
 * opening a session and its Transcript mounting (workspace switches render a
 * loading screen first). The request stays pending until a handler handles it
 * or PENDING_TTL_MS elapses.
 */
export function requestTranscriptScrollWhenReady(request: TranscriptScrollRequest): boolean {
  pending = { request: { ...request }, at: Date.now() };
  if (requestTranscriptScroll(pending.request)) {
    pending = null;
    return true;
  }
  return false;
}

/**
 * Re-deliver a pending jump after the transcript mounted or its rows changed
 * (session switch, progressive mount). No-op when nothing is pending.
 */
export function flushPendingTranscriptScroll(): void {
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return;
  }
  if (requestTranscriptScroll(pending.request)) pending = null;
}

export function subscribeTranscriptScroll(handler: TranscriptScrollHandler): () => void {
  handlers.add(handler);
  flushPendingTranscriptScroll();
  return () => handlers.delete(handler);
}

/** pending 是模块级状态，测试用例之间必须复位。 */
export function clearPendingTranscriptScrollForTest(): void {
  pending = null;
}
