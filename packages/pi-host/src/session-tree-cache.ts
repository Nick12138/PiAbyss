import { toJsonValue, type SerializableSessionEntry, type SerializableSessionTreeNode } from "@piabyss/protocol";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Cached `session.getTree` projection for the CURRENT active Session of a
 * workspace graph. Renderer refetches the tree right after a session switch —
 * exactly while the switch still holds the service graph lock — so a valid
 * cache lets the Host serve that read lock-free instead of answering
 * SERVICE_GRAPH_BUSY and forcing the renderer down its retry ladder.
 */
export type SessionTreeCacheEntry = {
  sessionId: string;
  sessionRevision: number;
  leafId: string | null;
  tree: SerializableSessionTreeNode[];
};

export type SdkSessionTreeNode = {
  entry: unknown;
  children: SdkSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

/**
 * SDK tree nodes carry `label: undefined` keys; toJsonValue would turn those
 * into nulls, which the wire contract rejects — optional keys must be absent.
 */
function toWireTreeNode(node: SdkSessionTreeNode): SerializableSessionTreeNode {
  return {
    entry: toJsonValue(node.entry) as SerializableSessionEntry,
    children: node.children.map(toWireTreeNode),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.labelTimestamp !== undefined ? { labelTimestamp: node.labelTimestamp } : {}),
  };
}

/** Serialize the SDK tree once; callers must cache the returned entry as-is. */
export function toWireTree(nodes: SdkSessionTreeNode[]): SerializableSessionTreeNode[] {
  return nodes.map(toWireTreeNode);
}

export function buildSessionTreeCacheEntry(
  sessionManager: SessionManager,
  sessionId: string,
  sessionRevision: number,
): SessionTreeCacheEntry | null {
  try {
    return {
      sessionId,
      sessionRevision,
      leafId: sessionManager.getLeafId() ?? null,
      tree: (sessionManager.getTree() as SdkSessionTreeNode[]).map(toWireTreeNode),
    };
  } catch {
    // A session manager without tree support (test doubles, exotic builds)
    // simply leaves the graph uncached; reads fall back to the locked path.
    return null;
  }
}

export function invalidateSessionTreeCache(graph: {
  sessionTreeCache?: SessionTreeCacheEntry;
}): void {
  graph.sessionTreeCache = undefined;
}
