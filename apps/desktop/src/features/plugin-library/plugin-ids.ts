/**
 * Plugin-library ids that were renamed in my-pi-plugins.
 *
 * Keep both spellings: the live registry now publishes the generic ids, while
 * an older catalog (or a repo checkout that has not been updated yet) still
 * publishes the PiAbyss-prefixed ones. UI gates treat either as installed.
 */
export const MEMO_PLUGIN_ID = "pi-memo";
export const MEMO_PLUGIN_ID_LEGACY = "piabyss-memo";
export const PRESENT_FILES_PLUGIN_ID = "pi-present-files";
export const PRESENT_FILES_PLUGIN_ID_LEGACY = "piabyss-present-files";
