type TreeOverlayHandler = () => boolean;

const handlers = new Set<TreeOverlayHandler>();
let pending = false;

/** Ask the session-tree overlay to open (the AppTopBar button, /tree). */
export function requestTreeOverlay(): void {
  let consumed = false;
  for (const handler of handlers) consumed = handler() || consumed;
  if (!consumed) pending = true;
}

export function subscribeTreeOverlay(handler: TreeOverlayHandler): () => void {
  handlers.add(handler);
  if (pending && handler()) pending = false;
  return () => handlers.delete(handler);
}

export function clearPendingTreeOverlayForTest(): void {
  pending = false;
}
