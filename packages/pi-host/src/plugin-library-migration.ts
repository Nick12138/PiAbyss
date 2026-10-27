/**
 * One-way settings migration for plugins renamed in my-pi-plugins.
 *
 * `piabyss-memo` / `piabyss-present-files` became `pi-memo` / `pi-present-files`.
 * The plugin-library toggles persist user-scope `packages[]` extension patterns
 * that embed the repo-relative path, so an old install keeps pointing at a
 * directory the new checkout no longer contains. Rewrite those patterns once
 * the new plugin file actually exists on disk — doing it unconditionally would
 * break users who updated PiAbyss before pulling the new plugin repo.
 *
 * Project-scope settings are intentionally untouched: the plugin library only
 * writes the user layer, and a Host update must not modify a project checkout.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";
import type { PackageSource } from "./package-filters.js";
import { PLUGIN_LIBRARY_REPO_SOURCE } from "./plugin-library-catalog.js";

type PluginPathRename = {
  /** Substring present in old settings patterns (dir + entry file). */
  from: string;
  /** Replacement substring. */
  to: string;
  /** Repo-relative file whose presence proves the new checkout is installed. */
  marker: string;
};

const PLUGIN_PATH_RENAMES: PluginPathRename[] = [
  {
    from: "piabyss-memo",
    to: "pi-memo",
    marker: "packages/pi-memo/extensions/pi-memo.ts",
  },
  {
    from: "piabyss-present-files",
    to: "pi-present-files",
    marker: "packages/pi-present-files/extensions/pi-present-files.ts",
  },
];

function rewritePatterns(patterns: string[], rename: PluginPathRename): string[] {
  const next: string[] = [];
  for (const pattern of patterns) {
    const mapped = pattern.replaceAll(rename.from, rename.to);
    if (!next.includes(mapped)) next.push(mapped);
  }
  return next;
}

function samePatterns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Rewrite renamed plugin paths in the user-scope `packages[].extensions`
 * filters. Returns the renames that were applied (empty when nothing changed).
 * Best-effort: a broken settings file throws and the caller logs a warning.
 */
export async function migratePluginLibraryRenames(agentDir: string): Promise<string[]> {
  const settings = SettingsManager.create(process.cwd(), agentDir, {
    projectTrusted: false,
  });
  const current = [...((settings.getGlobalSettings().packages ?? []) as PackageSource[])];
  const repoEntryIndex = current.findIndex(
    (entry) =>
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { source?: unknown }).source === PLUGIN_LIBRARY_REPO_SOURCE,
  );
  if (repoEntryIndex < 0) return [];
  const repoEntry = current[repoEntryIndex] as { extensions?: unknown };
  if (!Array.isArray(repoEntry.extensions)) return [];
  const patterns = repoEntry.extensions.filter(
    (value): value is string => typeof value === "string",
  );
  if (patterns.length === 0) return [];

  const packageManager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager: settings,
  });
  const installedPath = packageManager.getInstalledPath(PLUGIN_LIBRARY_REPO_SOURCE, "user");
  if (!installedPath) return [];

  const applied: string[] = [];
  let nextPatterns = patterns;
  for (const rename of PLUGIN_PATH_RENAMES) {
    if (!existsSync(join(installedPath, rename.marker))) continue;
    const rewritten = rewritePatterns(nextPatterns, rename);
    if (samePatterns(rewritten, nextPatterns)) continue;
    nextPatterns = rewritten;
    applied.push(`${rename.from} → ${rename.to}`);
  }
  if (applied.length === 0) return [];

  const next = [...current];
  next[repoEntryIndex] = {
    ...(repoEntry as { source: string }),
    extensions: nextPatterns,
  } as PackageSource;
  settings.setPackages(next as never);
  await settings.flush();
  logger.info("Migrated renamed plugin paths in settings", { applied });
  return applied;
}
