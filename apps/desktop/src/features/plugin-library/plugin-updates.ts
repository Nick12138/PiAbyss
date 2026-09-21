import type {
  HostStatusSnapshot,
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { pluginCardState } from "./plugin-library-model";

const UPDATES_CHECK_TIMEOUT_MS = 60_000;

/** One updatable entry in the plugin-library update popup. Repo plugins all
 *  live inside the single registry-repository package, so they collapse into
 *  one row — updating it refreshes every sub-plugin at once. */
export type PluginUpdateRow = {
  /** Stable key for pending-op tracking and React lists. */
  key: string;
  packageId: string;
  /** Plugin name, or the registry repository's display name for repo rows. */
  label: string;
  /** Repo rows only: how many curated sub-plugins the update bundles. */
  repoPluginCount?: number;
  current?: string;
  available?: string;
};

/* ------------------------------------------------------------ */
/* Session-scoped cache: settings-open prefetch shares its       */
/* result with the plugin-library page via this module state.    */
/* ------------------------------------------------------------ */

let updatesCache: {
  hostId: string;
  workspaceId: string;
  updates: PackageUpdateSummary[];
} | null = null;

/** Cached check result for this host+workspace, or null when the settings-open
 *  prefetch has not produced one yet. */
export function cachedPluginLibraryUpdates(
  hostId: string,
  workspaceId: string,
): PackageUpdateSummary[] | null {
  return updatesCache &&
    updatesCache.hostId === hostId &&
    updatesCache.workspaceId === workspaceId
    ? updatesCache.updates
    : null;
}

/** Test-only: clear the session cache between tests. */
export function resetPluginLibraryUpdatesCache(): void {
  updatesCache = null;
}

/** Run the host-side update check and cache the result for this session. */
export async function checkPluginLibraryUpdates(
  host: HostStatusSnapshot,
  workspace: WorkspaceSnapshot | null,
): Promise<PackageUpdateSummary[]> {
  const response = await hostClient.request(
    "package.checkUpdates",
    workspaceContext(host, workspace),
    null,
    UPDATES_CHECK_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(response.error?.message ?? "package.checkUpdates failed");
  }
  updatesCache = {
    hostId: host.hostInstanceId,
    workspaceId: workspace?.id ?? host.workspaceId ?? "",
    updates: response.result.updates,
  };
  return response.result.updates;
}

/** Drop cached rows for packages that were just updated so the update button
 *  and popup reflect completion without another network roundtrip. */
export function markPluginLibraryUpdatesApplied(
  hostId: string,
  workspaceId: string,
  packageIds: ReadonlySet<string>,
): void {
  if (
    !updatesCache ||
    updatesCache.hostId !== hostId ||
    updatesCache.workspaceId !== workspaceId
  ) {
    return;
  }
  updatesCache = {
    ...updatesCache,
    updates: updatesCache.updates.filter((update) => !packageIds.has(update.packageId)),
  };
}

/* ------------------------------------------------------------ */
/* Pure derivation: checkUpdates result → popup rows            */
/* ------------------------------------------------------------ */

/** Map a checkUpdates result onto the plugin library view:
 *  - npm/git plugins each become one row keyed by their package;
 *  - every installed repo plugin (registry repository package) collapses into
 *    a single "my-pi-plugins" row, because one package.update refreshes the
 *    whole repository and therefore all of its sub-plugins.
 *  Packages that no longer exist in the snapshot (removed meanwhile) or that
 *  map to no installed curated plugin are ignored. */
export function computePluginUpdateRows(
  catalog: PluginLibraryCatalog,
  packages: PackageSnapshot,
  updates: readonly PackageUpdateSummary[],
): PluginUpdateRow[] {
  const byPackageId = new Map(updates.map((update) => [update.packageId, update]));
  const rows: PluginUpdateRow[] = [];
  const seenPackageIds = new Set<string>();
  for (const entry of catalog.plugins) {
    const state = pluginCardState(entry, catalog, packages);
    const record = state.packageRecord;
    if (state.status === "not-installed" || !record) continue;
    const summary = byPackageId.get(record.id);
    if (!summary) continue;
    if (entry.install.type === "repo") {
      const existing = rows.find(
        (row) => row.key === `repo:${record.id}`,
      );
      if (existing) {
        existing.repoPluginCount = (existing.repoPluginCount ?? 0) + 1;
      } else {
        rows.push({
          key: `repo:${record.id}`,
          packageId: record.id,
          label: record.displayName || entry.id,
          repoPluginCount: 1,
          current: summary.current,
          available: summary.available,
        });
      }
    } else if (!seenPackageIds.has(record.id)) {
      seenPackageIds.add(record.id);
      rows.push({
        key: `plugin:${record.id}`,
        packageId: record.id,
        label: entry.name,
        current: summary.current,
        available: summary.available,
      });
    }
  }
  return rows;
}
