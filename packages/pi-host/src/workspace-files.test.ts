import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DIRECTORY_WATCHES,
  WorkspaceFileService,
  listWorkspaceDirectory,
  normalizeWorkspaceRelativePath,
} from "./workspace-files.js";

// Node 24.18.0 predates the Windows fs-event fix in libuv/libuv#5152 and can abort here.
const hasBrokenWindowsFsWatch =
  process.platform === "win32" && process.versions.node === "24.18.0";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "piabyss-workspace-files-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "src", "index.ts"), "export {};");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace relative paths", () => {
  it("normalizes portable relative paths and rejects escapes", () => {
    expect(normalizeWorkspaceRelativePath("")).toBe("");
    expect(normalizeWorkspaceRelativePath("src\\components/./Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
    expect(() => normalizeWorkspaceRelativePath("../outside")).toThrow(/cannot leave/);
    expect(() => normalizeWorkspaceRelativePath("C:\\outside")).toThrow(/relative/);
    expect(() => normalizeWorkspaceRelativePath("/outside")).toThrow(/relative/);
  });
});

describe("listWorkspaceDirectory", () => {
  it("returns a directory-first, workspace-relative listing", async () => {
    await expect(listWorkspaceDirectory(root, "")).resolves.toEqual({
      path: "",
      entries: [
        { name: "src", path: "src", kind: "dir", symlink: false },
        { name: "README.md", path: "README.md", kind: "file", symlink: false },
      ],
    });
  });

  it("does not traverse symbolic-link directories", async () => {
    try {
      await symlink(join(root, "src"), join(root, "linked-src"), "dir");
    } catch {
      return;
    }
    const listing = await listWorkspaceDirectory(root, "");
    expect(listing.entries.find((entry) => entry.name === "linked-src")).toEqual({
      name: "linked-src",
      path: "linked-src",
      kind: "file",
      symlink: true,
    });
    await expect(listWorkspaceDirectory(root, "linked-src")).rejects.toThrow(/Symbolic-link/);
  });
});

describe("WorkspaceFileService", () => {
  it("rejects more than the bounded number of watches", async () => {
    const service = new WorkspaceFileService();
    const paths = Array.from({ length: MAX_DIRECTORY_WATCHES + 1 }, (_, index) => `d${index}`);
    await expect(service.setDirectoryWatches(root, paths, () => {})).rejects.toThrow(/At most/);
    service.dispose();
  });

  it.skipIf(hasBrokenWindowsFsWatch)(
    "coalesces changes for watched expanded directories",
    async () => {
      const service = new WorkspaceFileService();
      const changed = new Promise<string[]>((resolve) => {
        void service.setDirectoryWatches(root, ["src"], resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(root, "src", "second.ts"), "export const second = true;");
      await expect(changed).resolves.toEqual(["src"]);
      service.dispose();
    },
  );
});
