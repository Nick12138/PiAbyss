import { useEffect, useState } from "react";
import type { PackageSnapshot, PluginLibraryCatalog } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext, workspaceContext } from "../../lib/bridge/host-context";
import { pluginCardState } from "../plugin-library/plugin-library-model";

/** The plugin-library entry that backs the Schedule page. */
export const SCHEDULE_PLUGIN_ID = "pi-schedule";

const CATALOG_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;

type PluginStatus = "enabled" | "disabled" | "not-installed" | "unknown";

/** Pure derivation: the schedule page entry shows only while the plugin is
 *  installed AND all of its extension resources are enabled. */
export function schedulePluginStatus(
  catalog: PluginLibraryCatalog | null,
  packages: PackageSnapshot | null,
): PluginStatus {
  if (!catalog || !packages) return "unknown";
  const entry = catalog.plugins.find((plugin) => plugin.id === SCHEDULE_PLUGIN_ID);
  if (!entry) return "not-installed";
  return pluginCardState(entry, catalog, packages).status;
}

/** Module-level catalog cache keyed by host instance: the sidebar gate mounts
 *  once per app shell, so refetching per navigation is wasteful. */
let catalogCache: { hostId: string; catalog: PluginLibraryCatalog } | null = null;

/**
 * True while the pi-schedule plugin is installed and enabled. Loads the
 * plugin-library catalog (host-scoped) and the package snapshot
 * (workspace-scoped, shared through the app store) on demand.
 */
export function useSchedulePluginEnabled(): boolean {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const workspaceServicesReady = workspace?.servicesReady ?? false;
  const storePackages = useAppStore((s) => s.packages);
  const applyPackageSnapshot = useAppStore((s) => s.applyPackageSnapshot);
  const hostId = host?.hostInstanceId ?? null;

  const [catalog, setCatalog] = useState<PluginLibraryCatalog | null>(() =>
    catalogCache && catalogCache.hostId === hostId ? catalogCache.catalog : null,
  );
  const [packages, setPackages] = useState<PackageSnapshot | null>(storePackages);

  useEffect(() => {
    setCatalog(catalogCache && catalogCache.hostId === hostId ? catalogCache.catalog : null);
  }, [hostId]);

  // Catalog is host-scoped: fetch once per host instance.
  useEffect(() => {
    if (!host || catalog) return;
    let cancelled = false;
    const expectedHostId = host.hostInstanceId;
    void hostClient
      .request("pluginLibrary.catalog", hostContext(host), {}, CATALOG_TIMEOUT_MS)
      .then((response) => {
        if (cancelled || !response.ok) return;
        if (useAppStore.getState().host?.hostInstanceId !== expectedHostId) return;
        catalogCache = { hostId: expectedHostId, catalog: response.result };
        setCatalog(response.result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host, catalog]);

  // Packages are workspace-scoped: fetch when neither the store nor the local
  // state has a snapshot for the current workspace.
  useEffect(() => {
    if (!host || !workspaceServicesReady || packages) return;
    let cancelled = false;
    void hostClient
      .request(
        "package.list",
        workspaceContext(host, workspace),
        { scope: "all" },
        PACKAGE_LIST_TIMEOUT_MS,
      )
      .then((response) => {
        if (cancelled || !response.ok) return;
        setPackages(response.result);
        // Share the snapshot so other consumers (PackagesPage) skip the fetch.
        if (!useAppStore.getState().packages) applyPackageSnapshot(response.result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host, workspace, workspaceServicesReady, packages, applyPackageSnapshot]);

  return schedulePluginStatus(catalog, packages ?? storePackages) === "enabled";
}
