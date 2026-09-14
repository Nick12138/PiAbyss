import type { JsonValue, SerializableSessionTreeNode } from "@piabyss/protocol";

/** Role bucket of a conversation entry, shared by the excerpt helper and the
 *  inline branch navigators' turn model. */
type TreeRowKind = "user" | "assistant" | "other";

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
function currentPathIds(nodes: SerializableSessionTreeNode[], leafId: string | null): Set<string> {
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

/** One switchable sibling branch of a turn on the current path. */
type TreeBranchAlternative = { targetId: string; excerpt: string };

/** Sibling alternatives for a turn, keyed by the turn's last entry id. */
export type TreeBranchPoint = {
  alternatives: TreeBranchAlternative[];
  /** Index of the currently active alternative within `alternatives`. */
  activeIndex: number;
};

/** Tooltip length for inline alternative titles. */
const BRANCH_EXCERPT_LIMIT = 120;

/**
 * Branch points along the current leaf path for the inline ‹ n/m › navigators:
 * every on-path turn whose parent has more than one child (multiple user
 * messages from the same fork, or multiple replies to the same user message).
 * Keyed by the turn-chain's last entry id, which is exactly what transcript
 * rows can look up (`sourceId` for user rows, `sourceEndId` for assistant
 * rows) and what `agent.navigateTree` accepts as `targetId`. Only on-path
 * turns appear in the result, and the walk descends only into the active
 * child, so the cost is linear in the visible path length.
 */
export function branchAlternatives(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
): Map<string, TreeBranchPoint> {
  const result = new Map<string, TreeBranchPoint>();
  if (!leafId) return result;
  const path = currentPathIds(nodes, leafId);
  const visit = (siblings: TurnNode[]): void => {
    const activeIndex = siblings.findIndex((sibling) => sibling.ids.some((id) => path.has(id)));
    if (activeIndex < 0) return;
    if (siblings.length > 1) {
      const alternatives = siblings.map((sibling) => ({
        targetId: sibling.ids[sibling.ids.length - 1]!,
        excerpt: sibling.excerpt,
      }));
      siblings.forEach((sibling, index) => {
        result.set(sibling.ids[sibling.ids.length - 1]!, { alternatives, activeIndex: index });
      });
    }
    visit(siblings[activeIndex]!.children);
  };
  visit(buildConversationTurns(nodes, BRANCH_EXCERPT_LIMIT));
  return result;
}
