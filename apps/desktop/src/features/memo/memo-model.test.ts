import { describe, expect, it } from "vitest";
import type { MemoNote } from "@piabyss/protocol";
import {
  collectTags,
  collectWorkspaces,
  composeMemoPrompt,
  composeMemoResultSection,
  defaultProjectWorkspacePath,
  deriveTitle,
  extractTags,
  filterNotes,
  formatTags,
  noteExcerpt,
  noteMatchesWorkspace,
  pathBasename,
  resolveWorkspaceHint,
  sortNotesForList,
  statusCounts,
  tagHue,
  withMemoPrompt,
  workspaceMismatch,
} from "./memo-model";

let seq = 0;

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  seq += 1;
  return {
    id: `note-${seq}`,
    type: "memo",
    title: `记录 ${seq}`,
    contentMd: "正文",
    status: "open",
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 1000 + seq,
    updatedAt: 1000 + seq,
    completedAt: null,
    result: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("pathBasename", () => {
  it("handles separators and trailing slashes", () => {
    expect(pathBasename("D:/work/PiAbyss")).toBe("PiAbyss");
    expect(pathBasename("D:\\work\\PiAbyss\\")).toBe("PiAbyss");
    expect(pathBasename("PiAbyss")).toBe("PiAbyss");
  });
});

describe("noteExcerpt", () => {
  it("skips the title line and strips markdown headings", () => {
    expect(noteExcerpt(note({ contentMd: "# 标题\n\n## 小节\n正文" }))).toBe("小节");
  });
  it("returns empty when the note only has a title line", () => {
    expect(noteExcerpt(note({ contentMd: "只有一行" }))).toBe("");
  });
  it("truncates long lines", () => {
    expect(noteExcerpt(note({ contentMd: "标题\n" + "a".repeat(120) }))).toHaveLength(96);
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line and strips heading markers", () => {
    expect(deriveTitle("\n\n## 修复登录 bug\n正文")).toBe("修复登录 bug");
  });
  it("returns empty for blank content", () => {
    expect(deriveTitle("   \n  ")).toBe("");
  });
  it("truncates to maxLength", () => {
    expect(deriveTitle("a".repeat(120))).toHaveLength(100);
  });
});

describe("extractTags", () => {
  it("extracts inline #tags, dedupes case-insensitively, keeps order", () => {
    expect(extractTags("记一下 #Bug 和 #bug #p0\n再一个 #P0")).toEqual(["Bug", "p0"]);
  });
  it("ignores headings and code fences, strips trailing punctuation", () => {
    expect(extractTags("# 这是标题\n正文 #refactor。\n```\n#not_a_tag\n```\n结尾 #done!")).toEqual([
      "refactor",
      "done",
    ]);
  });
  it("ignores bare # tokens", () => {
    expect(extractTags("# \n## #")).toEqual([]);
  });
});

describe("filterNotes / statusCounts / sortNotesForList", () => {
  const notes = [
    note({ status: "open", tags: ["refactor"], contentMd: "alpha", updatedAt: 3 }),
    note({ status: "done", tags: ["bug"], completedAt: 9, updatedAt: 1 }),
    note({ status: "done", tags: ["bug"], completedAt: 5, updatedAt: 2 }),
    note({ status: "archived", title: "旧想法 archive", updatedAt: 4 }),
  ];

  it("counts statuses", () => {
    expect(statusCounts(notes)).toEqual({ open: 1, done: 2, archived: 1 });
  });

  it("filters by status, tag, query", () => {
    expect(
      filterNotes(notes, { status: "done", tag: null, workspace: null, query: "" }),
    ).toHaveLength(2);
    expect(
      filterNotes(notes, { status: "done", tag: "BUG", workspace: null, query: "" }),
    ).toHaveLength(2);
    expect(
      filterNotes(notes, { status: "archived", tag: null, workspace: null, query: "archive" }),
    ).toHaveLength(1);
    expect(
      filterNotes(notes, { status: "open", tag: "bug", workspace: null, query: "" }),
    ).toHaveLength(0);
  });

  it("sorts done by completedAt, others by updatedAt", () => {
    const doneFilter = { status: "done" as const, tag: null, workspace: null, query: "" };
    const done = sortNotesForList(filterNotes(notes, doneFilter), "done");
    expect(done.map((entry) => entry.completedAt)).toEqual([9, 5]);
    const open = sortNotesForList(notes, "open");
    expect(open.map((entry) => entry.updatedAt)).toEqual([4, 3, 2, 1]);
  });
});

describe("tags", () => {
  it("formats tags for display", () => {
    expect(formatTags(["a", "b"])).toBe("#a #b");
  });
  it("assigns stable hues per tag content", () => {
    expect(tagHue("测试")).toBe(tagHue("测试"));
    expect(tagHue("a")).not.toBe(tagHue("b"));
    expect(tagHue("")).toBe(tagHue(""));
    const hues = ["x", "y", "z", "w"].map(tagHue);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
  it("collects distinct tags preserving first casing", () => {
    expect(collectTags([note({ tags: ["A"] }), note({ tags: ["a", "b"] })])).toEqual(["A", "b"]);
  });
});

describe("workspace hints", () => {
  it("matches by basename or substring", () => {
    expect(noteMatchesWorkspace(note({ workspaceHint: "PiAbyss" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "piabyss" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "D:/work" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "Other" }), "D:/work/PiAbyss")).toBe(false);
    expect(noteMatchesWorkspace(note({ workspaceHint: null }), "D:/work/PiAbyss")).toBe(false);
  });
  it("reports mismatches for the detail view", () => {
    expect(workspaceMismatch(note({ workspaceHint: "Other" }), "D:/work/PiAbyss")).toBe("Other");
    expect(workspaceMismatch(note({ workspaceHint: "PiAbyss" }), "D:/work/PiAbyss")).toBeNull();
    expect(workspaceMismatch(note({ workspaceHint: "Other" }), null)).toBe("Other");
    expect(workspaceMismatch(note({ workspaceHint: null }), null)).toBeNull();
  });
  it("collects distinct workspace hints", () => {
    expect(
      collectWorkspaces([note({ workspaceHint: "A" }), note({ workspaceHint: "a" }), note()]),
    ).toEqual(["A"]);
  });
});

describe("resolveWorkspaceHint", () => {
  const candidates = ["D:/work/PiAbyss", "D:/work/other-app", "D:/work/PiAbyss/packages/client"];
  it("prefers exact path match over basename and substring", () => {
    expect(resolveWorkspaceHint("d:/work/piabyss", candidates)).toBe("D:/work/PiAbyss");
    expect(resolveWorkspaceHint("PiAbyss", candidates)).toBe("D:/work/PiAbyss");
    expect(resolveWorkspaceHint("packages/client", candidates)).toBe(
      "D:/work/PiAbyss/packages/client",
    );
  });
  it("ignores surrounding whitespace and is case-insensitive", () => {
    expect(resolveWorkspaceHint("  Other-App  ", candidates)).toBe("D:/work/other-app");
  });
  it("returns null for empty/blank hints and unmatched hints", () => {
    expect(resolveWorkspaceHint(null, candidates)).toBeNull();
    expect(resolveWorkspaceHint("  ", candidates)).toBeNull();
    expect(resolveWorkspaceHint("Nope", candidates)).toBeNull();
    expect(resolveWorkspaceHint("PiAbyss", [])).toBeNull();
  });
  it("keeps the first candidate when several match equally", () => {
    expect(resolveWorkspaceHint("shared", ["D:/a/shared", "D:/b/shared"])).toBe("D:/a/shared");
  });
});

describe("defaultProjectWorkspacePath", () => {
  it("joins the agent dir with piabyss/DefaultProject (windows backslashes)", () => {
    expect(defaultProjectWorkspacePath("C:\\Users\\liu\\.pi\\agent")).toBe(
      "C:\\Users\\liu\\.pi\\agent\\piabyss\\DefaultProject",
    );
  });
  it("joins with forward slashes for posix-style agent dirs", () => {
    expect(defaultProjectWorkspacePath("/home/liu/.pi/agent")).toBe(
      "/home/liu/.pi/agent/piabyss/DefaultProject",
    );
  });
  it("trims trailing separators instead of doubling them", () => {
    expect(defaultProjectWorkspacePath("C:\\a\\b\\")).toBe("C:\\a\\b\\piabyss\\DefaultProject");
    expect(defaultProjectWorkspacePath("/a/b/")).toBe("/a/b/piabyss/DefaultProject");
  });
  it("returns null for empty or missing agent dirs", () => {
    expect(defaultProjectWorkspacePath(null)).toBeNull();
    expect(defaultProjectWorkspacePath(undefined)).toBeNull();
    expect(defaultProjectWorkspacePath("   ")).toBeNull();
  });
});

describe("composeMemoPrompt", () => {
  it("renders a structured reference block with image paths", () => {
    const block = composeMemoPrompt(
      note({
        type: "task",
        status: "open",
        title: "修复 bug",
        contentMd: "步骤：\n1. 复现\n2. 修复",
        tags: ["bug", "p0"],
        workspaceHint: "PiAbyss",
        images: [{ id: "img", fileName: "a.png", mediaType: "image/png", bytes: 8 }],
      }),
    );
    expect(block).toContain('<piabyss-memo id="note-');
    expect(block).toContain('type="task" status="open"');
    expect(block).toContain('tags="bug,p0"');
    expect(block).toContain('workspace="PiAbyss"');
    expect(block).toContain("# 修复 bug");
    expect(block).toContain("piabyss/memo/images/");
    expect(block).toContain("- piabyss/memo/images/");
    expect(block.trim().endsWith("</piabyss-memo>")).toBe(true);
  });

  it("omits optional attributes when absent", () => {
    const block = composeMemoPrompt(note());
    expect(block).not.toContain("tags=");
    expect(block).not.toContain("workspace=");
    expect(block).not.toContain("图片：");
  });
});

describe("withMemoPrompt", () => {
  it("orders block, instruction, then existing draft", () => {
    const merged = withMemoPrompt("已有草稿", "BLOCK", "INSTRUCTION");
    expect(merged).toBe("BLOCK\n\nINSTRUCTION\n\n已有草稿");
  });
  it("keeps empty existing drafts out", () => {
    expect(withMemoPrompt("   ", "BLOCK", "INSTRUCTION")).toBe("BLOCK\n\nINSTRUCTION");
  });
});

describe("composeMemoResultSection", () => {
  it("returns empty string for notes without an agent result", () => {
    expect(composeMemoResultSection(note())).toBe("");
  });

  it("wraps the latest summary and session metadata", () => {
    const block = composeMemoResultSection(
      note({
        result: {
          resultMd: "已完成重构，测试全部通过。",
          sessionId: "session-1",
          sessionPath: "D:/sessions/session-1.jsonl",
          sessionTitle: "重构 memo",
          sessionCwd: "D:/work/PiAbyss",
          at: 1700000000000,
        },
      }),
    );
    expect(block).toContain('<piabyss-memo-result noteId="note-');
    expect(block).toContain('sessionId="session-1"');
    expect(block).toContain('sessionTitle="重构 memo"');
    expect(block).toContain("已完成重构，测试全部通过。");
    expect(block.trim().endsWith("</piabyss-memo-result>")).toBe(true);
  });
});
