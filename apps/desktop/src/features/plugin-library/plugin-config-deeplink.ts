/**
 * Deep link into the plugin-library config dialog.
 *
 * Other pages (e.g. the memo sync dialog) navigate to Settings → Plugins and
 * want a specific plugin's configuration dialog to open right away — the
 * R2 credentials for memo cloud sync live there now. Module-level handoff,
 * consumed once by PluginLibraryPage after its catalog loads:
 * request → openSettingsSection("plugins") → PluginLibraryPage opens the
 * entry's config dialog (or just scrolls to the card when the entry is
 * missing/not configurable).
 */

let pending: { pluginId: string; requestedAt: number } | null = null;

/** Stale handoffs (e.g. the page never opened) are dropped after 30 seconds. */
const PENDING_TTL_MS = 30_000;

/** Request the plugin-library page to open this plugin's config dialog. */
export function requestPluginConfigDeepLink(pluginId: string): void {
  pending = { pluginId, requestedAt: Date.now() };
}

/**
 * Take the pending deep link (if any, and still fresh).
 * Returns the plugin id exactly once; null when nothing is pending.
 */
export function takePluginConfigDeepLink(): string | null {
  if (pending === null) return null;
  const { pluginId, requestedAt } = pending;
  pending = null;
  if (Date.now() - requestedAt > PENDING_TTL_MS) return null;
  return pluginId;
}
