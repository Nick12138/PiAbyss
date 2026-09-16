import type { WorkspaceActivity } from "./stores/app-store";

/**
 * The Rust Host pool lowercases workspace keys on Windows, and the activity
 * snapshot returns each entry's Rust-canonicalized cwd — which can differ from
 * the renderer's casing. Normalize both sides the same way for lookups.
 */
export function normalizedActivityKey(path: string): string {
  return /^win/i.test(navigator.platform) ? path.toLowerCase() : path;
}

/**
 * Host-pool activity for one workspace cwd, keyed the same way the picker
 * stores it. Returns undefined when the cwd is unknown or the pool has no
 * entry (older pools / no bound Host).
 */
export function workspaceActivityFor(
  activities: Record<string, WorkspaceActivity>,
  cwd: string | null | undefined,
): WorkspaceActivity | undefined {
  if (!cwd) return undefined;
  return activities[normalizedActivityKey(cwd)];
}
