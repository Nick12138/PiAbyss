import type { PackageRecord, PackageSnapshot } from "@piabyss/protocol";

/** The telegram plugin's install source (npm package). */
export const TELEGRAM_PLUGIN_SOURCE = "npm:@llblab/pi-telegram";

/** True when a package record is the telegram plugin, installed. */
export function isTelegramPluginRecord(record: PackageRecord): boolean {
  if (!record.installed) return false;
  const wanted = TELEGRAM_PLUGIN_SOURCE.toLocaleLowerCase();
  return (
    record.identity.toLocaleLowerCase() === wanted ||
    record.source.toLocaleLowerCase() === wanted
  );
}

/** True when the snapshot lists the telegram plugin as installed. */
export function isTelegramPluginInstalled(snapshot: PackageSnapshot): boolean {
  return snapshot.configured.some(isTelegramPluginRecord);
}