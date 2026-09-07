import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type WorkspaceDirectoryEntry } from "@piabyss/protocol";

export const MAX_DIRECTORY_WATCHES = 128;
const WATCH_COALESCE_MS = 100;

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("Workspace path contains a null byte");
  const portable = input.replace(/\\/g, "/");
  if (portable === "" || portable === ".") return "";
  if (portable.startsWith("/") || /^[A-Za-z]:/.test(portable)) {
    throw new Error("Workspace path must be relative");
  }
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Workspace path cannot leave the workspace");
  }
  return segments.join("/");
}

function resolveContainedPath(root: string, input: string): { absolute: string; path: string } {
  const path = normalizeWorkspaceRelativePath(input);
  const absolute = path ? resolve(root, ...path.split("/")) : root;
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Workspace path cannot leave the workspace");
  }
  return { absolute, path };
}

async function resolveWorkspaceDirectory(
  root: string,
  input: string,
): Promise<{ absolute: string; path: string }> {
  const resolved = resolveContainedPath(root, input);
  let cursor = root;
  for (const segment of resolved.path.split("/").filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error("Symbolic-link directories cannot be expanded or watched");
    }
  }
  const stats = await lstat(resolved.absolute);
  if (!stats.isDirectory()) throw new Error("Workspace path is not a directory");
  return resolved;
}

export async function listWorkspaceDirectory(
  root: string,
  input: string,
): Promise<{ path: string; entries: WorkspaceDirectoryEntry[] }> {
  const directory = await resolveWorkspaceDirectory(root, input);
  const dirents = await readdir(directory.absolute, { withFileTypes: true });
  const entries = dirents.map((entry): WorkspaceDirectoryEntry => ({
    name: entry.name,
    path: directory.path ? `${directory.path}/${entry.name}` : entry.name,
    kind: entry.isDirectory() && !entry.isSymbolicLink() ? "dir" : "file",
    symlink: entry.isSymbolicLink(),
  }));
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  return { path: directory.path, entries };
}

export class WorkspaceFileService {
  private root: string | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingDirectories = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emit: ((directories: string[]) => void) | null = null;
  private watchGeneration = 0;

  listDirectory(root: string, path: string) {
    return listWorkspaceDirectory(root, path);
  }

  async setDirectoryWatches(
    root: string,
    paths: string[],
    emit: (directories: string[]) => void,
  ): Promise<string[]> {
    const generation = ++this.watchGeneration;
    const normalized = [...new Set(paths.map(normalizeWorkspaceRelativePath))];
    if (normalized.length > MAX_DIRECTORY_WATCHES) {
      throw new Error(`At most ${MAX_DIRECTORY_WATCHES} directories can be watched`);
    }
    const resolved = await Promise.all(
      normalized.map((path) => resolveWorkspaceDirectory(root, path)),
    );
    if (generation !== this.watchGeneration) return normalized;

    if (this.root !== root) this.clearWatchers();
    this.root = root;
    this.emit = emit;

    const wanted = new Set(normalized);
    for (const [path, watcher] of this.watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      this.watchers.delete(path);
    }

    const created: Array<[string, FSWatcher]> = [];
    try {
      for (const directory of resolved) {
        if (this.watchers.has(directory.path)) continue;
        const watcher = watch(directory.absolute, { persistent: false }, () => {
          if (this.root === root) this.queue(directory.path);
        });
        watcher.on("error", () => {
          if (this.root === root) this.queue(directory.path);
        });
        created.push([directory.path, watcher]);
      }
    } catch (error) {
      for (const [, watcher] of created) watcher.close();
      throw error;
    }
    for (const [path, watcher] of created) this.watchers.set(path, watcher);
    return normalized;
  }

  dispose(): void {
    this.watchGeneration += 1;
    this.clearWatchers();
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pendingDirectories.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.root = null;
    this.emit = null;
  }

  private queue(path: string): void {
    this.pendingDirectories.add(path);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const directories = [...this.pendingDirectories].sort();
      this.pendingDirectories.clear();
      if (directories.length > 0) this.emit?.(directories);
    }, WATCH_COALESCE_MS);
    this.timer.unref?.();
  }
}
