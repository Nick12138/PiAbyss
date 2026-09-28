/**
 * Path helpers for files an agent declared as deliverables. Declarations may
 * be workspace-relative (preferred) or absolute — models routinely answer with
 * the absolute path they just wrote — while the dock preview and
 * `workspaceAbsolutePath` only speak workspace-relative, so absolute
 * declarations must be relativized before use.
 */

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/** Forward slashes, no trailing separator, no leading `./`. */
export function normalizeDeclaredPath(declared: string): string {
  const trimmed = declared.trim().replace(/\\/g, "/");
  if (trimmed === "") return "";
  const withoutDot = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  return withoutDot.replace(/\/+$/, "");
}

export function isAbsoluteDeclaredPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("//") || WINDOWS_DRIVE.test(path);
}

/**
 * `D:\workspace` + `D:/workspace/sub/report.pdf` → `sub/report.pdf`.
 * Returns null when the absolute path lives outside the workspace root.
 * Comparison is case-insensitive because Windows/macOS drives are.
 */
export function relativizeAgainstRoot(root: string, absolute: string): string | null {
  const cleanRoot = normalizeDeclaredPath(root).toLowerCase();
  const cleanAbsolute = normalizeDeclaredPath(absolute).toLowerCase();
  if (cleanRoot === "" || cleanAbsolute === "") return null;
  const prefix = cleanRoot.endsWith("/") ? cleanRoot : `${cleanRoot}/`;
  if (!cleanAbsolute.startsWith(prefix)) return null;
  const relative = normalizeDeclaredPath(absolute).slice(prefix.length);
  return relative === "" ? null : relative;
}
