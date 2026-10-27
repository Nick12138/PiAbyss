/**
 * Host-side plugin gates for protocol handlers whose UI surface (memo page,
 * pixie page) only makes sense while the backing plugin is enabled.
 *
 * The plugin library toggles write the user-level `packages[]` entry for the
 * my-pi-plugins repo, in two shapes depending on the code path that ran:
 *  - `pluginLibraryApply` uses a plain directory include
 *    (`packages/<name>/extensions/**`),
 *  - resource preferences (`setPreferences`) use the concrete entry file
 *    (`+/-packages/<name>/extensions/<file>.ts`).
 * Both must be recognized. The same evaluation as `package-snapshot.ts`'s
 * `resolveResourceState` decides whether the plugin's extension would load in
 * a fresh session; this module mirrors that decision for host-scoped handlers
 * (which have no workspace context, so project-level overrides are
 * intentionally out of scope — the pages are global).
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isEnabledByPackagePatterns } from "./package-filters.js";
import type { PackageSource } from "./package-filters.js";
import { PLUGIN_LIBRARY_REPO_SOURCE } from "./plugin-library-catalog.js";

/** The my-pi-plugins repo install source every gated plugin belongs to. */
const PLUGIN_REPO_SOURCE = PLUGIN_LIBRARY_REPO_SOURCE;

export const MEMO_PLUGIN_ENTRY_FILE = "packages/pi-memo/extensions/pi-memo.ts";
/** Pre-v0.8 my-pi-plugins checkouts used this path; still recognized so a
 *  Host update does not disable the memo page before the repo is updated. */
export const MEMO_PLUGIN_ENTRY_FILE_LEGACY = "packages/piabyss-memo/extensions/piabyss-memo.ts";
export const PIXIE_PLUGIN_ENTRY_FILE = "packages/pi-pixie/extensions/pi-pixie.ts";

function repoExtensionPatterns(packages: PackageSource[] | undefined): string[] | undefined {
  const entry = (packages ?? []).find(
    (source) =>
      typeof source === "object" &&
      !Array.isArray(source) &&
      (source as { source?: unknown }).source === PLUGIN_REPO_SOURCE,
  ) as { extensions?: string[] } | undefined;
  return entry?.extensions;
}

/**
 * Whether a repo plugin's extension is enabled at the user level. This mirrors
 * `package-snapshot.ts`'s `resolveResourceState` (and therefore the SDK's own
 * load decision): the concrete entry file must be covered by an include glob
 * (or a `+` force-include) and not force-excluded. `+`/`-` entries are
 * exact-matched by the SDK against concrete files only, so a directory glob
 * always arrives as a plain include. An absent repo entry (or empty extensions
 * list) means nothing loads.
 */
export function isRepoPluginEnabled(agentDir: string, entryFile: string): boolean {
  try {
    const settings = SettingsManager.create(process.cwd(), agentDir, {
      projectTrusted: false,
    });
    const patterns = repoExtensionPatterns(
      settings.getGlobalSettings().packages as PackageSource[] | undefined,
    );
    if (!patterns || patterns.length === 0) return false;
    return isEnabledByPackagePatterns(entryFile, patterns);
  } catch {
    // A settings file that cannot be read must not brick the handler set;
    // fail open and let the page surface its own error if the plugin really
    // is off.
    return true;
  }
}

/**
 * Memo plugin gate. The registry entry was renamed (piabyss-memo → pi-memo),
 * so settings written by older hosts may still reference the legacy path.
 * Recognize either candidate: the rename migration rewrites them when the new
 * checkout is present, while this keeps an un-updated repo working.
 */
export function isMemoPluginEnabled(agentDir: string): boolean {
  return (
    isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE) ||
    isRepoPluginEnabled(agentDir, MEMO_PLUGIN_ENTRY_FILE_LEGACY)
  );
}
