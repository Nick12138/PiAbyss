import { describe, expect, it } from "vitest";
import type { SerializableSessionTreeNode } from "@piabyss/protocol";
import {
  branchAlternatives,
  currentPathIds,
  entryExcerpt,
  filterConversationTree,
  flattenSessionTree,
} from "./tree-model";

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

describe("assistant turn merging", () => {
  it("merges a linear assistant run into one row ending at the last segment", () => {
    const tree = [
      userNode("u1", "ask", [
        assistantNode("a1", "part one", [
          toolResultNode("tr1", [
            assistantNode("a2", "", [
              assistantNode("a3", "final words", [userNode("u2", "next ask")]),
            ]),
          ]),
        ]),
      ]),
    ];
    const { rows } = flattenSessionTree(tree, "u2");
    expect(rows.map(({ id, kind, lane }) => [id, kind, lane])).toEqual([
      ["u1", "user", 0],
      ["a3", "assistant", 0],
      ["u2", "user", 0],
    ]);
    expect(rows[1]!.excerpt).toBe("part one");
    expect(rows[1]!.onPath).toBe(true);
  });

  it("uses the first segment with text when the run starts without text", () => {
    const tree = [assistantNode("a1", "", [assistantNode("a2", "real answer")])];
    const { rows } = flattenSessionTree(tree, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("a2");
    expect(rows[0]!.excerpt).toBe("real answer");
  });

  it("marks the merged turn current when the leaf is inside it", () => {
    const tree = [
      userNode("u1", "ask", [assistantNode("a1", "one", [assistantNode("a2", "two")])]),
    ];
    const { rows } = flattenSessionTree(tree, "a1");
    expect(rows.find((row) => row.id === "a2")?.isCurrent).toBe(true);
  });

  it("does not merge across branch points", () => {
    const tree = [
      assistantNode("a1", "root", [assistantNode("a2", "left"), assistantNode("a3", "right")]),
    ];
    const { rows, laneCount } = flattenSessionTree(tree, null);
    expect(rows.map(({ id, lane }) => [id, lane])).toEqual([
      ["a1", 0],
      ["a2", 0],
      ["a3", 1],
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0]!.forks).toEqual([{ lane: 1, accent: false }]);
    expect(rows[0]!.linkDown).toBe(true);
    expect(rows[2]!.linkUp).toBe(true);
  });
});

describe("rail layout", () => {
  it("routes a branch connector through intervening rows", () => {
    // TREE: fork at a1; u2's subtree sits between the fork and u3's row.
    const { rows } = flattenSessionTree(TREE, "tr1");
    const a1 = rows.find((row) => row.id === "a1")!;
    const u2 = rows.find((row) => row.id === "u2")!;
    const u3 = rows.find((row) => row.id === "u3")!;
    expect(a1.forks).toEqual([{ lane: 1, accent: false }]);
    expect(u2.passes).toEqual([{ lane: 1, accent: false }]);
    expect(u3.lane).toBe(1);
    expect(u3.linkUp).toBe(true);
  });

  it("paints the accent rail along the current path only", () => {
    const { rows } = flattenSessionTree(TREE, "u3");
    const u1 = rows.find((row) => row.id === "u1")!;
    const a1 = rows.find((row) => row.id === "a1")!;
    const u2 = rows.find((row) => row.id === "u2")!;
    const u3 = rows.find((row) => row.id === "u3")!;
    expect(u1.linkDownAccent).toBe(true);
    // The trunk continues to u2, which is off-path once the leaf moved to u3.
    expect(a1.linkDownAccent).toBe(false);
    expect(a1.forks).toEqual([{ lane: 1, accent: true }]);
    expect(u2.passes).toEqual([{ lane: 1, accent: true }]);
    expect(u3.linkUpAccent).toBe(true);
  });

  it("gives each concurrent branch its own lane", () => {
    const tree = [
      userNode("p", "root", [
        assistantNode("c1", "first"),
        assistantNode("c2", "second"),
        assistantNode("c3", "third"),
      ]),
    ];
    const { rows, laneCount } = flattenSessionTree(tree, null);
    expect(rows.map(({ id, lane }) => [id, lane])).toEqual([
      ["p", 0],
      ["c1", 0],
      ["c2", 1],
      ["c3", 2],
    ]);
    expect(laneCount).toBe(3);
    // c3's connector must pass c2's row on its own lane.
    expect(rows.find((row) => row.id === "c2")!.passes).toEqual([{ lane: 2, accent: false }]);
    expect(rows.find((row) => row.id === "p")!.forks).toEqual([
      { lane: 1, accent: false },
      { lane: 2, accent: false },
    ]);
  });
});

describe("flattenSessionTree", () => {
  it("keeps the trunk on lane 0 and gives branches their own lanes", () => {
    const { rows, laneCount } = flattenSessionTree(TREE, "tr1");
    expect(rows.map(({ id, lane }) => [id, lane])).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["u2", 0],
      ["u3", 1],
    ]);
    expect(laneCount).toBe(2);
    expect(rows.find((row) => row.id === "u3")?.label).toBe("experiment");
  });

  it("marks the current path and puts the marker on the deepest visible row", () => {
    const { rows } = flattenSessionTree(TREE, "tr1");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual(["u1", "a1", "u2"]);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.id)).toEqual(["u2"]);
  });

  it("follows the marker when the leaf moves to another branch", () => {
    const { rows } = flattenSessionTree(TREE, "u3");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual(["u1", "a1", "u3"]);
    expect(rows.find((row) => row.id === "u3")?.isCurrent).toBe(true);
  });

  it("marks nothing without a leaf", () => {
    expect(currentPathIds(TREE, null).size).toBe(0);
    expect(flattenSessionTree(TREE, null).rows.some((row) => row.isCurrent)).toBe(false);
  });

  it("shortens excerpts as the maxChars budget shrinks", () => {
    const long = userNode("u", "a".repeat(200), []);
    const wide = flattenSessionTree([long], null, 200);
    const narrow = flattenSessionTree([long], null, 20);
    expect(wide.rows[0]!.excerpt.length).toBe(200);
    expect(narrow.rows[0]!.excerpt.length).toBeLessThanOrEqual(20);
    expect(narrow.rows[0]!.excerpt.endsWith("…")).toBe(true);
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
