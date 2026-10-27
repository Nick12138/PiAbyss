/**
 * Legacy plugin env aliases.
 *
 * my-pi-plugins dropped the PiAbyss-specific prefixes:
 *   PIABYSS_MEMO_* → PI_MEMO_*
 *   PIABYSS_PIXIE_* → PI_PIXIE_*
 * Desktop settings keep storing config under these env names, and an existing
 * desktop install still holds the old keys. Copy the legacy value to the new
 * name when the new name is absent so updated plugins keep reading the user's
 * saved configuration without opening every config form again. The legacy name
 * is left in place for plugin versions that only know the old contract.
 */

const PLUGIN_ENV_ALIASES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["PIABYSS_MEMO_R2_ACCOUNT_ID", "PI_MEMO_R2_ACCOUNT_ID"],
  ["PIABYSS_MEMO_R2_ACCESS_KEY_ID", "PI_MEMO_R2_ACCESS_KEY_ID"],
  ["PIABYSS_MEMO_R2_SECRET_ACCESS_KEY", "PI_MEMO_R2_SECRET_ACCESS_KEY"],
  ["PIABYSS_MEMO_R2_BUCKET", "PI_MEMO_R2_BUCKET"],
  ["PIABYSS_MEMO_AUTO_SYNC", "PI_MEMO_AUTO_SYNC"],
  ["PIABYSS_MEMO_DIR", "PI_MEMO_DIR"],
  ["PIABYSS_MEMO_SYNC_PORT", "PI_MEMO_SYNC_PORT"],
  ["PIABYSS_MEMO_SYNC_TOKEN", "PI_MEMO_SYNC_TOKEN"],
  ["PIABYSS_PIXIE_WORKSPACE", "PI_PIXIE_WORKSPACE"],
  ["PIABYSS_PIXIE_MODEL", "PI_PIXIE_MODEL"],
  ["PIABYSS_PIXIE_STALE_MS", "PI_PIXIE_STALE_MS"],
  ["PIABYSS_PIXIE_STALE_NOTIFY", "PI_PIXIE_STALE_NOTIFY"],
  ["PIABYSS_PIXIE_HTTP_PORT", "PI_PIXIE_HTTP_PORT"],
  ["PIABYSS_PIXIE_HTTP_TOKEN", "PI_PIXIE_HTTP_TOKEN"],
  ["PIABYSS_PIXIE_RESIDENT", "PI_PIXIE_RESIDENT"],
];

/** Copy legacy env values onto their generic names (new name always wins). */
export function applyPluginEnvAliases(env: NodeJS.ProcessEnv = process.env): number {
  let applied = 0;
  for (const [legacy, current] of PLUGIN_ENV_ALIASES) {
    const value = env[legacy];
    if (!value?.trim()) continue;
    if (env[current]?.trim()) continue;
    env[current] = value;
    applied += 1;
  }
  return applied;
}
