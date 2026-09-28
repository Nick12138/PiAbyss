import { describe, expect, it } from "vitest";
import type { GitStatusSnapshot } from "@piabyss/protocol";
import {
  buildGitListRows,
  canDiscardAllGitChanges,
  canDiscardGitChange,
  gitChangeLetter,
  parseUnifiedDiffLines,
} from "./ChangesPanel";

describe("ChangesPanel helpers", () => {
  it("shows the same file in unstaged and staged groups", () => {
    const status: Extract<GitStatusSnapshot, { state: "ready" }> = {
      state: "ready",
      revision: 1,
      repositoryRoot: "/repo",
      workspaceIsRepositoryRoot: true,
      branch: "main",
      detached: false,
      unborn: false,
      headSha: "a".repeat(40),
      upstream: null,
      ahead: 0,
      behind: 0,
      indexGeneration: "b".repeat(64),
      warnings: [],
      files: [
        {
          path: "src/app.ts",
          staged: "modified",
          unstaged: "modified",
          conflict: false,
          submodule: false,
          pathSupported: true,
        },
      ],
    };
    const rows = buildGitListRows(status);
    expect(rows.filter((row) => row.kind === "file")).toEqual([
      expect.objectContaining({ area: "unstaged" }),
      expect.objectContaining({ area: "staged" }),
    ]);
  });

  it("tracks old and new line numbers across hunks", () => {
    const lines = parseUnifiedDiffLines(
      "@@ -2,2 +2,2 @@\n old\n-removed\n+added\n\\ No newline at end of file",
    );
    expect(lines).toEqual([
      expect.objectContaining({ kind: "hunk", oldLine: null, newLine: null }),
      expect.objectContaining({ kind: "context", oldLine: 2, newLine: 2 }),
      expect.objectContaining({ kind: "deletion", oldLine: 3, newLine: null }),
      expect.objectContaining({ kind: "addition", oldLine: null, newLine: 3 }),
      expect.objectContaining({ kind: "meta", oldLine: null, newLine: null }),
    ]);
  });

  it("resets line numbering between files in a commit diff", () => {
    const lines = parseUnifiedDiffLines(
      [
        "diff --git a/one.ts b/one.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/two.ts b/two.ts",
        "index 1111111..2222222 100644",
        "--- a/two.ts",
        "+++ b/two.ts",
        "@@ -8 +8 @@",
        " second",
      ].join("\n"),
    );
    expect(lines[4]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(lines[5]).toMatchObject({ kind: "meta", oldLine: null, newLine: null });
    expect(lines[9]).toMatchObject({ kind: "context", oldLine: 8, newLine: 8 });
  });

  it("uses compact, stable status letters", () => {
    expect(gitChangeLetter("untracked")).toBe("U");
    expect(gitChangeLetter("conflicted")).toBe("!");
  });

  it("allows discard for safe worktree changes including new (untracked) files", () => {
    const file = {
      path: "src/app.ts",
      staged: null,
      unstaged: "modified" as const,
      conflict: false,
      submodule: false,
      pathSupported: true,
    };
    expect(canDiscardGitChange(file)).toBe(true);
    expect(canDiscardGitChange({ ...file, unstaged: "untracked" })).toBe(true);
    expect(canDiscardGitChange({ ...file, unstaged: "renamed" })).toBe(false);
    expect(canDiscardGitChange({ ...file, conflict: true })).toBe(false);
    expect(canDiscardGitChange({ ...file, submodule: true })).toBe(false);
    expect(canDiscardGitChange({ ...file, pathSupported: false })).toBe(false);
  });

  it("allows batch discard only when every listed change is safe", () => {
    const file = {
      path: "src/app.ts",
      staged: null,
      unstaged: "modified" as const,
      conflict: false,
      submodule: false,
      pathSupported: true,
    };
    const snapshot = (files: typeof file[]) =>
      ({
        state: "ready",
        revision: 7,
        files,
      }) as Parameters<typeof canDiscardAllGitChanges>[0];
    expect(canDiscardAllGitChanges(snapshot([]))).toBe(false);
    expect(canDiscardAllGitChanges(snapshot([file]))).toBe(true);
    expect(canDiscardAllGitChanges(snapshot([file, { ...file, conflict: true }]))).toBe(false);
    expect(canDiscardAllGitChanges(snapshot([file, { ...file, submodule: true }]))).toBe(false);
    expect(canDiscardAllGitChanges(snapshot([file, { ...file, pathSupported: false }]))).toBe(
      false,
    );
  });
});
