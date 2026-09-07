import type { JsonValue, SerializableSessionTreeNode } from "@piabyss/protocol";

export type TreeRowKind = "user" | "assistant" | "other";

type TreeRailMark = { lane: number; accent: boolean };

export type TreeRow = {
  id: string;
  kind: TreeRowKind;
  excerpt: string;
  /** Branch label recorded on the node, if any. */
  label?: string;
  /** True when the row lies on the path from the root to the current leaf. */
  onPath: boolean;
  /** Deepest visible row on the current leaf path. */
  isCurrent: boolean;
  /** Rail lane of the node dot; the trunk is lane 0. */
  lane: number;
  /** Upper half-link at the node's lane (from the parent or a fork connector). */
  linkUp: boolean;
  linkUpAccent: boolean;
  /** Lower half-link at the node's lane (to the chain child on the next row). */
  linkDown: boolean;
  linkDownAccent: boolean;
  /** Fork curves leaving this row's node toward a branch lane. */
  forks: TreeRailMark[];
  /** Branch connectors passing vertically through this row. */
  passes: TreeRailMark[];
};

export type SessionTreeLayout = { rows: TreeRow[]; laneCount: number };

/** Hard ceiling (CSS ellipsis handles the precise width-based cutoff). */
const EXCERPT_LIMIT = 512;
const ASSISTANT_PLACEHOLDER = "(assistant message)";

function firstTextLine(text: string, limit: number): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function messageText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      !Array.isArray(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return "";
}

export function entryExcerpt(
  entry: { type: string; [key: string]: JsonValue | undefined },
  limit = EXCERPT_LIMIT,
): {
  kind: TreeRowKind;
  excerpt: string;
} {
  if (entry.type === "message") {
    const message = entry.message;
    if (typeof message === "object" && message !== null && !Array.isArray(message)) {
      const role = message.role;
      const text = firstTextLine(messageText(message.content), limit);
      if (role === "user") return { kind: "user", excerpt: text || "(user message)" };
      if (role === "assistant") {
        return { kind: "assistant", excerpt: text || ASSISTANT_PLACEHOLDER };
      }
      return { kind: "other", excerpt: text || String(role ?? entry.type) };
    }
  }
  return { kind: "other", excerpt: entry.type };
}

/** Ids from the root to the entry with `leafId`, or an empty set. */
export function currentPathIds(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
): Set<string> {
  const path = new Set<string>();
  if (!leafId) return path;
  const visit = (node: SerializableSessionTreeNode, trail: string[]): boolean => {
    const next = [...trail, node.entry.id];
    if (node.entry.id === leafId) {
      for (const id of next) path.add(id);
      return true;
    }
    return node.children.some((child) => visit(child, next));
  };
  nodes.some((node) => visit(node, []));
  return path;
}

/**
 * Conversation-turn view of the tree: keep user/assistant message nodes and
 * collapse everything else (tool results, model changes, session_info, …) so
 * their children reattach to the nearest visible ancestor. A hidden node's
 * branch label survives on its first visible descendant.
 */
export function filterConversationTree(
  nodes: SerializableSessionTreeNode[],
): SerializableSessionTreeNode[] {
  const visit = (node: SerializableSessionTreeNode): SerializableSessionTreeNode[] => {
    const children = node.children.flatMap(visit);
    if (entryExcerpt(node.entry).kind !== "other") {
      return [{ ...node, children }];
    }
    if (node.label && children.length > 0 && !children[0]!.label) {
      children[0] = { ...children[0]!, label: node.label };
    }
    return children;
  };
  return nodes.flatMap(visit);
}

type TurnNode = {
  /** Member entry ids in chain order; the last one is the navigation target. */
  ids: string[];
  kind: TreeRowKind;
  excerpt: string;
  label?: string;
  children: TurnNode[];
};

/**
 * Group the conversation-turn view into turns: a linear run of assistant
 * entries (tool-call segments) collapses into one node ending at the last
 * segment. Branch points break the run so every branch stays addressable.
 */
function buildConversationTurns(nodes: SerializableSessionTreeNode[], limit: number): TurnNode[] {
  const toTurn = (node: SerializableSessionTreeNode): TurnNode => {
    const { kind, excerpt } = entryExcerpt(node.entry, limit);
    const ids = [node.entry.id];
    let turnExcerpt = excerpt;
    let label = node.label;
    let tail = node;
    if (kind === "assistant") {
      while (tail.children.length === 1) {
        const next = tail.children[0]!;
        const nextInfo = entryExcerpt(next.entry);
        if (nextInfo.kind !== "assistant") break;
        ids.push(next.entry.id);
        if (turnExcerpt === ASSISTANT_PLACEHOLDER) turnExcerpt = nextInfo.excerpt;
        if (!label && next.label) label = next.label;
        tail = next;
      }
    }
    return {
      ids,
      kind,
      excerpt: turnExcerpt,
      ...(label ? { label } : {}),
      children: tail.children.map(toTurn),
    };
  };
  return filterConversationTree(nodes).map((node) => toTurn(node));
}

/**
 * Commit-graph layout of the conversation turns, DFS order. The trunk (first
 * child chain) keeps its parent's lane; every later sibling gets a fresh lane
 * that stays free from its fork row down to its first row, so connectors
 * never overlap another branch's chain. The current path is a continuous
 * accent rail; the current marker lands on the deepest visible turn along the
 * leaf path — the actual leaf entry may be a collapsed one (e.g. a tool
 * result).
 */
export function flattenSessionTree(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
  maxChars = EXCERPT_LIMIT,
): SessionTreeLayout {
  const path = currentPathIds(nodes, leafId);
  const rows: TreeRow[] = [];
  const members: string[][] = [];
  let laneCount = 1;

  // Returns the maximum lane used inside the subtree, so a later sibling can
  // pick the first lane that is free across every row its connector spans.
  const visit = (
    turn: TurnNode,
    lane: number,
    parentIndex: number | null,
    isBranch: boolean,
  ): number => {
    const index = rows.length;
    const onPath = turn.ids.some((id) => path.has(id));
    rows.push({
      id: turn.ids[turn.ids.length - 1]!,
      kind: turn.kind,
      excerpt: turn.excerpt,
      ...(turn.label ? { label: turn.label } : {}),
      onPath,
      isCurrent: false,
      lane,
      linkUp: false,
      linkUpAccent: false,
      linkDown: false,
      linkDownAccent: false,
      forks: [],
      passes: [],
    });
    members.push(turn.ids);
    if (parentIndex !== null) {
      if (isBranch) {
        rows[parentIndex]!.forks.push({ lane, accent: onPath });
        for (let i = parentIndex + 1; i < index; i += 1) {
          rows[i]!.passes.push({ lane, accent: onPath });
        }
      } else {
        rows[parentIndex]!.linkDown = true;
        rows[parentIndex]!.linkDownAccent = onPath;
      }
      rows[index]!.linkUp = true;
      rows[index]!.linkUpAccent = onPath;
    }
    let maxLane = lane;
    turn.children.forEach((child, childIndex) => {
      const childLane = childIndex === 0 ? lane : maxLane + 1;
      maxLane = Math.max(maxLane, visit(child, childLane, index, childIndex > 0));
    });
    laneCount = Math.max(laneCount, maxLane + 1);
    return maxLane;
  };

  let rootMax = -1;
  buildConversationTurns(nodes, maxChars).forEach((turn, index) => {
    rootMax = Math.max(rootMax, visit(turn, index === 0 ? 0 : rootMax + 1, null, false));
  });

  const rowIndexByMember = new Map<string, number>();
  members.forEach((ids, index) => {
    for (const id of ids) rowIndexByMember.set(id, index);
  });
  for (const id of [...path].reverse()) {
    const index = rowIndexByMember.get(id);
    if (index !== undefined) {
      rows[index]!.isCurrent = true;
      break;
    }
  }
  return { rows, laneCount };
}
