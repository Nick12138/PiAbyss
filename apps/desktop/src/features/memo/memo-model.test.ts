import { describe, expect, it } from "vitest";
import type { MemoNote } from "@piabyss/protocol";
import {
  collectWorkspaces,
  composeMemoPrompt,
  composeMemoResultSection,
  defaultProjectWorkspacePath,
  deriveTitle,
  extractTags,
  noteExcerpt,
  noteMatchesWorkspace,
  memoFullContentMd,
  memoImagePath,
  pathBasename,
  resolveWorkspaceHint,
  sortNotesForList,
  tagHue,
  withMemoPrompt,
} from "./memo-model";

let seq = 0;

function note(overrides: Partial<MemoNote> = {}): MemoNote {
  seq += 1;
  return {
    id: `note-${seq}`,
    title: `记录 ${seq}`,
    contentMd: "正文",
    status: "open",
    sessionId: null,
    tags: [],
    workspaceHint: null,
    images: [],
    createdAt: 1000 + seq,
    updatedAt: 1000 + seq,
    completedAt: null,
    result: null,
    deletedAt: null,
    dueAt: null,
    recurrence: null,
    nextDueAt: null,
    lastDoneAt: null,
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

describe("memoFullContentMd", () => {
  it("keeps the content as-is when its first line already is the title", () => {
    const n = note({ title: "回复邮件", contentMd: "回复邮件\n正文两行" });
    expect(memoFullContentMd(n)).toBe("回复邮件\n正文两行");
  });
  it("prepends the title when the content starts elsewhere", () => {
    const n = note({ title: "点2杯美式", contentMd: "提醒：点 2 杯美式 ☕" });
    expect(memoFullContentMd(n)).toBe("点2杯美式\n\n提醒：点 2 杯美式 ☕");
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

describe("sortNotesForList", () => {
  const notes = [
    note({ status: "open", tags: ["refactor"], contentMd: "alpha", updatedAt: 3 }),
    note({ status: "in_progress", sessionId: "session-1", updatedAt: 4 }),
    note({ status: "done", tags: ["bug"], completedAt: 9, updatedAt: 1 }),
    note({ status: "done", tags: ["bug"], completedAt: 5, updatedAt: 2 }),
    note({ status: "done", title: "旧想法 archive", updatedAt: 4 }),
  ];

  it("sorts done by completedAt, others by updatedAt", () => {
    const done = sortNotesForList(
      notes.filter((entry) => entry.status === "done"),
      "done",
    );
    expect(done.map((entry) => entry.completedAt)).toEqual([9, 5, null]);
    const open = sortNotesForList(notes, "open");
    expect(open.map((entry) => entry.updatedAt)).toEqual([4, 4, 3, 2, 1]);
  });
});

describe("tagHue", () => {
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
});

describe("workspace hints", () => {
  it("matches by basename or contiguous path fragment", () => {
    expect(noteMatchesWorkspace(note({ workspaceHint: "PiAbyss" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "piabyss" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "D:/work" }), "D:/work/PiAbyss")).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "Other" }), "D:/work/PiAbyss")).toBe(false);
    expect(noteMatchesWorkspace(note({ workspaceHint: null }), "D:/work/PiAbyss")).toBe(false);
  });
  it("does not match an ancestor path segment (regression: DefaultProject vs piabyss hint)", () => {
    // DefaultProject 的路径是 <agentDir>/piabyss/DefaultProject：其中的 piabyss
    // 只是祖先段，不能因此把 PiAbyss 工作区的记录误判为「就在当前工作区」。
    const defaultProject = "C:\\Users\\example\\.pi\\agent\\piabyss\\DefaultProject";
    expect(noteMatchesWorkspace(note({ workspaceHint: "PiAbyss" }), defaultProject)).toBe(false);
    expect(noteMatchesWorkspace(note({ workspaceHint: "DefaultProject" }), defaultProject)).toBe(
      true,
    );
    expect(noteMatchesWorkspace(note({ workspaceHint: "PiAbyss" }), "D:\\我的项目\\PiAbyss")).toBe(
      true,
    );
  });
  it("does not match partial segments (no raw substring)", () => {
    expect(noteMatchesWorkspace(note({ workspaceHint: "abyss" }), "D:/work/PiAbyss")).toBe(false);
    expect(noteMatchesWorkspace(note({ workspaceHint: "Pi" }), "D:/work/PiAbyss")).toBe(false);
  });
  it("multi-segment hints match contiguous fragments only", () => {
    expect(noteMatchesWorkspace(note({ workspaceHint: "work/PiAbyss" }), "D:/work/PiAbyss")).toBe(
      true,
    );
    expect(
      noteMatchesWorkspace(note({ workspaceHint: "work/PiAbyss" }), "D:/work/PiAbyss/packages"),
    ).toBe(true);
    expect(noteMatchesWorkspace(note({ workspaceHint: "other/PiAbyss" }), "D:/work/PiAbyss")).toBe(
      false,
    );
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
  it("does not substring-match an ancestor path segment (regression)", () => {
    const defaultProject = "C:\\Users\\example\\.pi\\agent\\piabyss\\DefaultProject";
    const piabyss = "D:\\我的项目\\PiAbyss";
    // 末段优先：真正的工作区胜出，不再被 DefaultProject 的祖先段截胡。
    expect(resolveWorkspaceHint("PiAbyss", [defaultProject, piabyss])).toBe(piabyss);
    // 候选里只有 DefaultProject 时，"piabyss" 提示不再误领它（回退默认工作区）。
    expect(resolveWorkspaceHint("PiAbyss", [defaultProject])).toBeNull();
    // 半截段不匹配。
    expect(resolveWorkspaceHint("abyss", ["D:/work/PiAbyss"])).toBeNull();
  });
});

describe("defaultProjectWorkspacePath", () => {
  it("joins the agent dir with piabyss/DefaultProject (windows backslashes)", () => {
    expect(defaultProjectWorkspacePath("C:\\Users\\example\\.pi\\agent")).toBe(
      "C:\\Users\\example\\.pi\\agent\\piabyss\\DefaultProject",
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

describe("memoImagePath", () => {
  it("joins the agent dir with piabyss/memo/images (windows backslashes)", () => {
    expect(memoImagePath("C:\\Users\\example\\.pi\\agent", "note-1", "a.png")).toBe(
      "C:\\Users\\example\\.pi\\agent\\piabyss\\memo\\images\\note-1\\a.png",
    );
  });

  it("trims trailing separators and uses forward slashes otherwise", () => {
    expect(memoImagePath("/home/liu/.pi/agent/", "note-1", "a.png")).toBe(
      "/home/liu/.pi/agent/piabyss/memo/images/note-1/a.png",
    );
    expect(memoImagePath("C:/Users/example/.pi/agent/", "note-1", "a.png")).toBe(
      "C:/Users/example/.pi/agent/piabyss/memo/images/note-1/a.png",
    );
  });

  it("falls back to the cloud-relative key when agentDir is missing", () => {
    expect(memoImagePath(null, "note-1", "a.png")).toBe("piabyss/memo/images/note-1/a.png");
    expect(memoImagePath("   ", "note-1", "a.png")).toBe("piabyss/memo/images/note-1/a.png");
  });
});

describe("composeMemoPrompt", () => {
  it("renders a structured reference block with absolute image paths", () => {
    const block = composeMemoPrompt(
      note({
        status: "open",
        title: "修复 bug",
        contentMd: "步骤：\n1. 复现\n2. 修复",
        tags: ["bug", "p0"],
        workspaceHint: "PiAbyss",
        images: [{ id: "img", fileName: "a.png", mediaType: "image/png", bytes: 8 }],
      }),
      "C:\\Users\\example\\.pi\\agent",
    );
    expect(block).toContain('<piabyss-memo id="note-');
    expect(block).toContain('status="open"');
    expect(block).toContain('tags="bug,p0"');
    expect(block).toContain('workspace="PiAbyss"');
    expect(block).toContain("# 修复 bug");
    expect(block).toContain("- C:\\Users\\example\\.pi\\agent\\piabyss\\memo\\images\\note-");
    expect(block).toContain("\\a.png");
    expect(block.trim().endsWith("</piabyss-memo>")).toBe(true);
  });

  it("falls back to relative image keys without agentDir", () => {
    const block = composeMemoPrompt(
      note({ images: [{ id: "img", fileName: "a.png", mediaType: "image/png", bytes: 8 }] }),
    );
    expect(block).toContain("- piabyss/memo/images/");
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
