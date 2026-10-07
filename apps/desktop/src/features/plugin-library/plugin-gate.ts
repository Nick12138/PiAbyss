import { useEffect, useState } from "react";
import type { PackageSnapshot, PluginLibraryCatalog } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext, workspaceContext } from "../../lib/bridge/host-context";
import { pluginCardState } from "../plugin-library/plugin-library-model";

const CATALOG_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;

type PluginStatus = "enabled" | "disabled" | "not-installed" | "unknown";

/** Pure derivation: the feature entry shows only while the plugin is
 *  installed AND all of its extension resources are enabled. */
function pluginStatus(
  pluginId: string,
  catalog: PluginLibraryCatalog | null,
  packages: PackageSnapshot | null,
): PluginStatus {
  if (!catalog || !packages) return "unknown";
  const entry = catalog.plugins.find((plugin) => plugin.id === pluginId);
  if (!entry) return "not-installed";
  return pluginCardState(entry, catalog, packages).status;
}

/** Module-level catalog cache keyed by host instance: these gates mount once
 *  per app shell, so refetching per navigation is wasteful. */
let catalogCache: { hostId: string; catalog: PluginLibraryCatalog } | null = null;

/**
 * True while the given plugin-library plugin is installed and enabled. Loads
 * the plugin-library catalog (host-scoped) and the package snapshot
 * (workspace-scoped, shared through the app store) on demand.
 *
 * Used to hide sidebar entries whose backing protocol handlers the Host gates
 * on the same plugin state (memo, pixie, schedule).
 */
export function usePluginEnabled(pluginId: string): boolean {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const workspaceServicesReady = workspace?.servicesReady ?? false;
  // The shared store's snapshot is the single source of truth: plugin-library
  // toggles flow back through applyPackageMutationResult, so reading it
  // reactively makes the gate flip the moment a toggle lands (no remount /
  // reload needed). The local fetch below only seeds the store.
  const storePackages = useAppStore((s) => s.packages);
  const applyPackageSnapshot = useAppStore((s) => s.applyPackageSnapshot);
  const hostId = host?.hostInstanceId ?? null;

  const [catalog, setCatalog] = useState<PluginLibraryCatalog | null>(() =>
    catalogCache && catalogCache.hostId === hostId ? catalogCache.catalog : null,
  );

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

  // Packages are workspace-scoped: fetch when the store has no snapshot yet
  // for the current workspace (first mount before any page fetched one).
  useEffect(() => {
    if (!host || !workspaceServicesReady || storePackages) return;
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
        // Share the snapshot so other consumers (PackagesPage) skip the fetch.
        if (!useAppStore.getState().packages) applyPackageSnapshot(response.result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [host, workspace, workspaceServicesReady, storePackages, applyPackageSnapshot]);

  return pluginStatus(pluginId, catalog, storePackages) === "enabled";
}
