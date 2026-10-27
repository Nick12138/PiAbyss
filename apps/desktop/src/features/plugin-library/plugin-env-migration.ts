/**
 * One-time desktop-settings migration for the my-pi-plugins rename.
 *
 * Plugin config values are persisted in `desktopSettings.pluginEnv` keyed by
 * plugin id, then injected into the Host process on spawn. The registry renamed
 * `piabyss-memo` → `pi-memo`, `piabyss-present-files` → `pi-present-files`, and
 * dropped the `PIABYSS_` env prefixes. Without this migration an existing
 * install would appear to lose its R2 credentials / pixie settings after the
 * update, because the new config form looks under the new id and env names.
 *
 * Canonical ids and env names always win over legacy copies. The caller
 * persists the returned map when it differs.
 */
import {
  MEMO_PLUGIN_ID,
  MEMO_PLUGIN_ID_LEGACY,
  PRESENT_FILES_PLUGIN_ID,
  PRESENT_FILES_PLUGIN_ID_LEGACY,
} from "./plugin-ids";

const PLUGIN_ID_ALIASES: Record<string, string> = {
  [MEMO_PLUGIN_ID_LEGACY]: MEMO_PLUGIN_ID,
  [PRESENT_FILES_PLUGIN_ID_LEGACY]: PRESENT_FILES_PLUGIN_ID,
};

const ENV_ALIASES: Record<string, string> = {
  PIABYSS_MEMO_R2_ACCOUNT_ID: "PI_MEMO_R2_ACCOUNT_ID",
  PIABYSS_MEMO_R2_ACCESS_KEY_ID: "PI_MEMO_R2_ACCESS_KEY_ID",
  PIABYSS_MEMO_R2_SECRET_ACCESS_KEY: "PI_MEMO_R2_SECRET_ACCESS_KEY",
  PIABYSS_MEMO_R2_BUCKET: "PI_MEMO_R2_BUCKET",
  PIABYSS_MEMO_AUTO_SYNC: "PI_MEMO_AUTO_SYNC",
  PIABYSS_MEMO_DIR: "PI_MEMO_DIR",
  PIABYSS_MEMO_SYNC_PORT: "PI_MEMO_SYNC_PORT",
  PIABYSS_MEMO_SYNC_TOKEN: "PI_MEMO_SYNC_TOKEN",
  PIABYSS_PIXIE_WORKSPACE: "PI_PIXIE_WORKSPACE",
  PIABYSS_PIXIE_MODEL: "PI_PIXIE_MODEL",
  PIABYSS_PIXIE_STALE_MS: "PI_PIXIE_STALE_MS",
  PIABYSS_PIXIE_STALE_NOTIFY: "PI_PIXIE_STALE_NOTIFY",
  PIABYSS_PIXIE_HTTP_PORT: "PI_PIXIE_HTTP_PORT",
  PIABYSS_PIXIE_HTTP_TOKEN: "PI_PIXIE_HTTP_TOKEN",
  PIABYSS_PIXIE_RESIDENT: "PI_PIXIE_RESIDENT",
};

export type PluginEnvMap = Record<string, Record<string, string>>;

/**
 * Rewrite legacy plugin ids/env names onto their generic counterparts.
 * Returns null when the map is already canonical.
 */
export function migratePluginEnvAliases(
  pluginEnv: PluginEnvMap | null | undefined,
): PluginEnvMap | null {
  if (!pluginEnv) return null;
  let changed = false;
  const next: PluginEnvMap = {};
  for (const [pluginId, vars] of Object.entries(pluginEnv)) {
    const canonicalId = PLUGIN_ID_ALIASES[pluginId] ?? pluginId;
    if (canonicalId !== pluginId) changed = true;
    const isLegacyId = canonicalId !== pluginId;
    const target = next[canonicalId] ?? {};
    for (const [name, value] of Object.entries(vars)) {
      const canonicalName = ENV_ALIASES[name] ?? name;
      if (canonicalName !== name) changed = true;
      const isLegacyName = canonicalName !== name;
      // Legacy entries only fill gaps; a canonical id/env always overwrites.
      if ((isLegacyId || isLegacyName) && target[canonicalName] !== undefined) continue;
      target[canonicalName] = value;
    }
    next[canonicalId] = target;
  }
  return changed ? next : null;
}

/** Legacy ids to drop when a plugin config is saved under its canonical id. */
export function legacyPluginIdsFor(pluginId: string): string[] {
  return Object.entries(PLUGIN_ID_ALIASES)
    .filter(([, canonical]) => canonical === pluginId)
    .map(([legacy]) => legacy);
}
