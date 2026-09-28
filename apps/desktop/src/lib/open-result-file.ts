import { hostClient } from "./bridge/host-client";
import { workspaceContext } from "./bridge/host-context";
import {
  isAbsoluteDeclaredPath,
  normalizeDeclaredPath,
  relativizeAgainstRoot,
} from "./declared-path";
import { openFileWithDefaultApp } from "./desktop-file-access";
import { requestOpenWorkspaceFileTab } from "./dock-file-tabs";
import { workspaceAbsolutePath } from "../features/dock/FilesPanel";
import { useAppStore } from "./stores/app-store";

/**
 * Extensions the dock preview can never render — documents the OS has a
 * registered handler for, plus archives and binaries. Anything else goes to a
 * dock file tab (with an "unsupported" fallback that still offers the system
 * app if the preview turns the file down).
 */
const SYSTEM_OPEN_EXTENSIONS = new Set([
  // documents
  "pdf",
  "doc",
  "docx",
  "docm",
  "dot",
  "dotx",
  "dotm",
  "rtf",
  "odt",
  "wps",
  "wpt",
  // spreadsheets & slides
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "xlt",
  "xltx",
  "et",
  "ppt",
  "pptx",
  "pptm",
  "pps",
  "ppsx",
  "pot",
  "potx",
  "dps",
  "odp",
  // archives
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "iso",
  // executables & libraries
  "exe",
  "msi",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "apk",
  "bin",
  "dll",
  "so",
  "dylib",
  "jar",
  // fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // media
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "mp4",
  "mkv",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  // design sources
  "psd",
  "ai",
  "sketch",
]);

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isSystemOpenExtension(path: string): boolean {
  return SYSTEM_OPEN_EXTENSIONS.has(fileExtension(path));
}

export type ResultFileResult = {
  outcome: "system" | "dock" | "no-workspace" | "failed";
  /** Why the launch failed, straight from the desktop shell — for the toast. */
  error?: string;
};

function launchWithDefaultApp(absolute: string): Promise<ResultFileResult> {
  return openFileWithDefaultApp(absolute).then((error) =>
    error ? { outcome: "failed" as const, error } : { outcome: "system" as const },
  );
}

/**
 * Resolves a declared path against the current workspace: absolute
 * declarations are relativized when they fall inside it. Returns nulls when
 * there is no workspace or the declaration is empty.
 */
export function resolveDeclaredFile(path: string): {
  relative: string | null;
  absolute: string | null;
} {
  const { workspace } = useAppStore.getState();
  if (!workspace) return { relative: null, absolute: null };
  const normalized = normalizeDeclaredPath(path);
  if (normalized === "") return { relative: null, absolute: null };
  if (isAbsoluteDeclaredPath(normalized)) {
    return {
      relative: relativizeAgainstRoot(workspace.canonicalCwd, normalized),
      absolute: normalized,
    };
  }
  return {
    relative: normalized,
    absolute: workspaceAbsolutePath(workspace.canonicalCwd, normalized),
  };
}

/**
 * Opens a file the agent declared as a deliverable: documents the dock cannot
 * preview go to the system default app, everything else opens in its own dock
 * file tab. An unpreviewable file never lands as an empty tab — it falls back
 * to the system app.
 *
 * Declarations may be absolute; those are relativized against the workspace
 * when they fall inside it, and handed straight to the system app when they
 * do not (the dock cannot preview outside the workspace anyway).
 */
export async function openResultFile(path: string): Promise<ResultFileResult> {
  const { host, workspace } = useAppStore.getState();
  if (!host || !workspace) return { outcome: "no-workspace" };
  const { relative, absolute } = resolveDeclaredFile(path);
  if (!relative || !absolute) return { outcome: "failed", error: "empty path" };
  const previewName = relative;

  if (isSystemOpenExtension(previewName)) {
    return launchWithDefaultApp(absolute);
  }
  // Outside the workspace the dock has nothing to preview — hand it to the OS.
  if (!relative) return launchWithDefaultApp(absolute);
  try {
    const response = await hostClient.request(
      "workspace.readFilePreview",
      workspaceContext(host, workspace),
      { path: relative },
    );
    if (!response.ok || response.result.kind === "unsupported") {
      return launchWithDefaultApp(absolute);
    }
  } catch (error) {
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  requestOpenWorkspaceFileTab(relative);
  return { outcome: "dock" };
}
