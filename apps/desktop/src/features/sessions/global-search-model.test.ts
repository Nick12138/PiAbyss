import { describe, expect, it } from "vitest";
import type { SessionSearchResultItem } from "@piabyss/protocol";
import {
  groupResultsByWorkspace,
  highlightSegments,
  searchQueryTerms,
  shouldRunGlobalSearch,
} from "./global-search-model";

function item(overrides: Partial<SessionSearchResultItem>): SessionSearchResultItem {
  return {
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionPath: "/sessions/a.jsonl",
    cwd: "/proj/a",
    archived: false,
    updatedAt: 1,
    matchCount: 1,
    matches: [],
    nameMatched: false,
    ...overrides,
  };
}

describe("searchQueryTerms", () => {
  it("lowercases, splits, dedupes, and caps", () => {
    expect(searchQueryTerms("  Foo   BAR foo ")).toEqual(["foo", "bar"]);
    expect(searchQueryTerms("a b c d e f g h i")).toHaveLength(8);
    expect(searchQueryTerms("   ")).toEqual([]);
  });
});

describe("highlightSegments", () => {
  it("marks case-insensitive occurrences of every term", () => {
    const segments = highlightSegments("Fix the LOGIN timeout login", ["login", "timeout"]);
    expect(segments).toEqual([
      { text: "Fix the ", matched: false },
      { text: "LOGIN", matched: true },
      { text: " ", matched: false },
      { text: "timeout", matched: true },
      { text: " ", matched: false },
      { text: "login", matched: true },
    ]);
  });

  it("merges overlapping term ranges", () => {
    const segments = highlightSegments("abcd", ["abc", "bcd"]);
    expect(segments).toEqual([{ text: "abcd", matched: true }]);
  });

  it("returns the whole text unmatched when no term occurs", () => {
    expect(highlightSegments("nothing here", ["zzz"])).toEqual([
      { text: "nothing here", matched: false },
    ]);
    expect(highlightSegments("nothing here", [])).toEqual([
      { text: "nothing here", matched: false },
    ]);
  });
});

describe("groupResultsByWorkspace", () => {
  it("groups by cwd preserving recency order of first appearance", () => {
    const items = [
      item({ sessionPath: "/s/1.jsonl", cwd: "/proj/b", updatedAt: 30 }),
      item({ sessionPath: "/s/2.jsonl", cwd: "/proj/a", updatedAt: 20 }),
      item({ sessionPath: "/s/3.jsonl", cwd: "/proj/b", updatedAt: 10 }),
    ];
    const groups = groupResultsByWorkspace(items);
    expect(groups.map((group) => group.cwd)).toEqual(["/proj/b", "/proj/a"]);
    expect(groups[0]?.items.map((entry) => entry.sessionPath)).toEqual([
      "/s/1.jsonl",
      "/s/3.jsonl",
    ]);
  });
});

describe("shouldRunGlobalSearch", () => {
  it("requires at least one non-space character", () => {
    expect(shouldRunGlobalSearch("")).toBe(false);
    expect(shouldRunGlobalSearch("   ")).toBe(false);
    expect(shouldRunGlobalSearch("登")).toBe(true);
    expect(shouldRunGlobalSearch(" a ")).toBe(true);
  });
});
