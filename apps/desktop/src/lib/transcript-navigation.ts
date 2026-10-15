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
};

type TranscriptScrollHandler = (request: TranscriptScrollRequest) => boolean;

const handlers = new Set<TranscriptScrollHandler>();

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

export function subscribeTranscriptScroll(handler: TranscriptScrollHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * 打开会话之后转写还要挂载 + 投影若干帧，一次请求多半落空。按重试节奏请求，
 * 命中即停；始终落空就安静放弃（会话已经打开，只是没滚过去）。
 */
const SCROLL_RETRY_DELAYS_MS = [0, 60, 180, 400, 900, 1_800];

export function scrollTranscriptToSource(sourceId: string): void {
  let done = false;
  const attempt = (index: number): void => {
    if (done) return;
    if (requestTranscriptScroll({ sourceId })) {
      done = true;
      return;
    }
    const delay = SCROLL_RETRY_DELAYS_MS[index];
    if (delay === undefined) return;
    setTimeout(() => attempt(index + 1), delay);
  };
  attempt(0);
}
