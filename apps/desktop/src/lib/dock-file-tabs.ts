type FileTabOpenHandler = (path: string) => boolean;

const handlers = new Set<FileTabOpenHandler>();
let pending: string[] = [];

/**
 * Ask the right dock to open (or focus) a dock page showing one workspace
 * file. Requests that arrive before the dock mounts are queued, mirroring the
 * Changes panel bus.
 */
export function requestOpenWorkspaceFileTab(path: string): void {
  let consumed = false;
  for (const handler of handlers) consumed = handler(path) || consumed;
  if (!consumed) pending.push(path);
}

export function subscribeOpenWorkspaceFileTab(handler: FileTabOpenHandler): () => void {
  handlers.add(handler);
  if (pending.length > 0) {
    const queued = pending;
    pending = [];
    // Re-route through the requester so an unconsumed path stays queued.
    for (const path of queued) requestOpenWorkspaceFileTab(path);
  }
  return () => handlers.delete(handler);
}

export function clearPendingFileTabsForTest(): void {
  pending = [];
}
