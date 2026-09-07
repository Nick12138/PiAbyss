import { describe, expect, it } from "vitest";
import type { WorkspaceDirectoryEntry } from "@piabyss/protocol";
import { flattenVisibleFiles, workspaceAbsolutePath } from "./FilesPanel";

const dir = (name: string, path = name): WorkspaceDirectoryEntry => ({
  name,
  path,
  kind: "dir",
  symlink: false,
});
const file = (name: string, path = name): WorkspaceDirectoryEntry => ({
  name,
  path,
  kind: "file",
  symlink: false,
});

describe("workspaceAbsolutePath", () => {
  it("joins portable relative paths for macOS and Windows workspaces", () => {
    expect(workspaceAbsolutePath("/Users/me/project/", "src/App.tsx")).toBe(
      "/Users/me/project/src/App.tsx",
    );
    expect(workspaceAbsolutePath("C:\\repo\\", "src/App.tsx")).toBe("C:\\repo\\src\\App.tsx");
  });
});

describe("flattenVisibleFiles", () => {
  it("only includes descendants of expanded directories", () => {
    const directories = new Map<string, WorkspaceDirectoryEntry[]>([
      ["", [dir("src"), file("README.md")]],
      ["src", [dir("components", "src/components"), file("index.ts", "src/index.ts")]],
      ["src/components", [file("Button.tsx", "src/components/Button.tsx")]],
    ]);

    expect(flattenVisibleFiles(directories, new Set()).map((row) => row.entry.path)).toEqual([
      "src",
      "README.md",
    ]);
    expect(
      flattenVisibleFiles(directories, new Set(["src"])).map((row) => [row.entry.path, row.depth]),
    ).toEqual([
      ["src", 0],
      ["src/components", 1],
      ["src/index.ts", 1],
      ["README.md", 0],
    ]);
  });
});
