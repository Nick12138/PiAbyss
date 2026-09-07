const LEGACY_KEY_PREFIX = "pideck.";
const KEY_PREFIX = "piabyss.";

/**
 * Copies persisted `pideck.*` localStorage entries to their `piabyss.*`
 * replacements, then removes the legacy keys. Idempotent and safe to run on
 * every startup.
 *
 * This module must be imported before any store module evaluates (i.e. as the
 * first import of `main.tsx`), because several stores read their storage keys
 * at module-evaluation time.
 */
export function migrateLegacyStorageKeys(): void {
  try {
    const storage = window.localStorage;
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(LEGACY_KEY_PREFIX)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const nextKey = `${KEY_PREFIX}${key.slice(LEGACY_KEY_PREFIX.length)}`;
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(nextKey) === null) {
        storage.setItem(nextKey, value);
      }
      storage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable (privacy mode, corrupted profile);
    // fall back to defaults rather than blocking startup.
  }
}

migrateLegacyStorageKeys();
