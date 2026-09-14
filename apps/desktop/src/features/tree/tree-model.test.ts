import { describe, expect, it } from "vitest";
import type { SerializableSessionTreeNode } from "@piabyss/protocol";
import { branchAlternatives, entryExcerpt, filterConversationTree } from "./tree-model";

function userNode(
  id: string,
  text: string,
  children: SerializableSessionTreeNode[] = [],
  label?: string,
): SerializableSessionTreeNode {
  return {
    entry: { id, type: "message", message: { role: "user", content: text } },
    children,
    ...(label ? { label } : {}),
  };
}

function assistantNode(
  id: string,
  text: string,
  children: SerializableSessionTreeNode[] = [],
): SerializableSessionTreeNode {
  return {
    entry: {
      id,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    children,
  };
}

function otherNode(
  id: string,
  type: string,
  children: SerializableSessionTreeNode[] = [],
  label?: string,
): SerializableSessionTreeNode {
  return { entry: { id, type }, children, ...(label ? { label } : {}) };
}

function toolResultNode(
  id: string,
  children: SerializableSessionTreeNode[] = [],
): SerializableSessionTreeNode {
  return {
    entry: {
      id,
      type: "message",
      message: { role: "toolResult", content: "tool output" },
    },
    children,
  };
}

describe("entryExcerpt", () => {
  it("extracts user and assistant text from string and block content", () => {
    expect(entryExcerpt(userNode("u", "hello\nworld").entry)).toEqual({
      kind: "user",
      excerpt: "hello",
    });
    expect(entryExcerpt(assistantNode("a", "  reply  ").entry)).toEqual({
      kind: "assistant",
      excerpt: "reply",
    });
  });

  it("classifies non-conversation entries as other", () => {
    expect(entryExcerpt(otherNode("c", "compaction").entry).kind).toBe("other");
    expect(entryExcerpt(otherNode("m", "model_change").entry).kind).toBe("other");
    expect(entryExcerpt(toolResultNode("t").entry).kind).toBe("other");
  });

  it("truncates long first lines to the supplied limit", () => {
    const { excerpt } = entryExcerpt(userNode("u", "x".repeat(200)).entry, 96);
    expect(excerpt.length).toBeLessThanOrEqual(96);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("keeps text under the supplied limit without truncating", () => {
    const { excerpt } = entryExcerpt(userNode("u", "short").entry, 200);
    expect(excerpt).toBe("short");
  });
});

// u1 → mc1(model_change) → a1 → { u2 → tr1(toolResult, leaf), h1(labeled) → u3 }
const TREE = [
  userNode("u1", "first ask", [
    otherNode("mc1", "model_change", [
      assistantNode("a1", "the answer", [
        userNode("u2", "trunk follow-up", [toolResultNode("tr1")]),
        otherNode("h1", "branch_summary", [userNode("u3", "abandoned")], "experiment"),
      ]),
    ]),
  ]),
];

describe("filterConversationTree", () => {
  it("collapses non-conversation nodes and reattaches their children", () => {
    const visible = filterConversationTree(TREE);
    expect(visible.map((node) => node.entry.id)).toEqual(["u1"]);
    expect(visible[0]!.children.map((node) => node.entry.id)).toEqual(["a1"]);
    expect(visible[0]!.children[0]!.children.map((node) => node.entry.id)).toEqual(["u2", "u3"]);
    expect(visible[0]!.children[0]!.children[0]!.children).toEqual([]);
  });

  it("carries a hidden node's label to its first visible descendant", () => {
    const visible = filterConversationTree(TREE);
    const u3 = visible[0]!.children[0]!.children[1]!;
    expect(u3.entry.id).toBe("u3");
    expect(u3.label).toBe("experiment");
  });

  it("drops hidden subtrees without visible descendants", () => {
    expect(filterConversationTree([otherNode("m", "model_change", [], "orphan-label")])).toEqual(
      [],
    );
  });
});

describe("branchAlternatives", () => {
  it("exposes sibling branches for an on-path turn", () => {
    const points = branchAlternatives(TREE, "u3");
    // u2 (trunk, alternative 1) and u3 (active, alternative 2) are siblings
    // under the assistant turn a1.
    const point = points.get("u2")!;
    expect(point.alternatives).toEqual([
      { targetId: "u2", excerpt: "trunk follow-up" },
      { targetId: "u3", excerpt: "abandoned" },
    ]);
    expect(point.activeIndex).toBe(0);
    expect(points.get("u3")).toEqual({ alternatives: point.alternatives, activeIndex: 1 });
  });

  it("tracks the active alternative when the leaf moves", () => {
    const trunk = branchAlternatives(TREE, "tr1").get("u2")!;
    expect(trunk.activeIndex).toBe(0);
  });

  it("ignores linear turns and off-path branches", () => {
    const points = branchAlternatives(TREE, "tr1");
    // u1 has a single child (a1); a1's branch point is keyed on u2/u3 only.
    expect(points.has("u1")).toBe(false);
    expect(points.has("a1")).toBe(false);
  });

  it("returns nothing without a leaf", () => {
    expect(branchAlternatives(TREE, null).size).toBe(0);
  });

  it("groups multiple replies to one user message into one branch point", () => {
    const tree = [
      userNode("u1", "ask", [
        assistantNode("a1", "first reply"),
        assistantNode("a2", "second reply"),
      ]),
    ];
    const point = branchAlternatives(tree, "a2")!.get("a2")!;
    expect(point.alternatives.map((alt) => alt.targetId)).toEqual(["a1", "a2"]);
    expect(point.activeIndex).toBe(1);
  });
});
