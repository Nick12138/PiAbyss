import { join, resolve as pathResolve } from "node:path";
import { sessionArchiveDir, workspaceStorageKey } from "./piabyss-data.js";

export function sessionStorageDirs(agentDir: string, cwd: string): {
  activeDir: string;
  archiveDir: string;
} {
  const resolvedCwd = pathResolve(cwd);
  const safePath = workspaceStorageKey(resolvedCwd);
  const activeDir = join(pathResolve(agentDir), "sessions", safePath);
  return { activeDir, archiveDir: sessionArchiveDir(agentDir, resolvedCwd) };
}
