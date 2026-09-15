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
