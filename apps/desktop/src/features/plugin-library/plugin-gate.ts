import { useEffect, useState } from "react";
import type { PackageSnapshot, PluginLibraryCatalog } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext, workspaceContext } from "../../lib/bridge/host-context";
import { pluginCardState } from "../plugin-library/plugin-library-model";

const CATALOG_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;

type PluginStatus = "enabled" | "disabled" | "not-installed" | "unknown";

/** A status backed by loaded catalog + package data — never a loading gap. */
type DefinitivePluginStatus = Exclude<PluginStatus, "unknown">;

/**
 * Sticky record of the last definitive status per plugin, scoped to the host
 * instance. The package snapshot is workspace-scoped: switching workspaces
 * (and the pixie page's own foreground switch) drops `packages` to null for
 * a window, which used to flip `usePluginEnabled` to false mid-switch — the
 * App-level guard then kicked the user off the pixie page and the unmount
 * cleanup switched the workspace right back (the "pixie 打不开 + 工作区来回
 * 跳" bug). A transient "unknown" (catalog/packages still loading) must not
 * regress an already-observed definitive answer; definitive answers always
 * overwrite (toggling a plugin in the library takes effect immediately).
 */
let stickyStatuses: { hostId: string; statuses: Map<string, DefinitivePluginStatus> } | null = null;

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
 * Catalog + package snapshot for plugin attribution UI (tool pickers and
 * similar). Same fetch-and-share pattern as `usePluginEnabled`: the catalog is
 * host-scoped and cached, the package snapshot lives in the app store so
 * plugin-library toggles reflect reactively.
 */
export function usePluginCatalogData(): {
  catalog: PluginLibraryCatalog | null;
  packages: PackageSnapshot | null;
} {
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const workspaceServicesReady = workspace?.servicesReady ?? false;
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

  return { catalog, packages: storePackages };
}

/**
 * True while the given plugin-library plugin is installed and enabled. Loads
 * the plugin-library catalog (host-scoped) and the package snapshot
 * (workspace-scoped, shared through the app store) on demand.
 *
 * Used to hide sidebar entries whose backing protocol handlers the Host gates
 * on the same plugin state (memo, pixie, schedule).
 *
 * Transient "unknown" windows (catalog or packages still loading — e.g. the
 * package snapshot drop while switching workspaces) fall back to the last
 * definitive status observed for this host instance, so the entry (and any
 * page guard consuming this) stays stable across the switch instead of
 * flickering off and on.
 */
export function usePluginEnabled(pluginId: string): boolean {
  const { catalog, packages } = usePluginCatalogData();
  const hostId = useAppStore((s) => s.host?.hostInstanceId ?? null);
  const status = pluginStatus(pluginId, catalog, packages);

  // Record definitive answers at commit time (render stays pure).
  useEffect(() => {
    if (hostId === null || status === "unknown") return;
    if (stickyStatuses?.hostId !== hostId) stickyStatuses = { hostId, statuses: new Map() };
    stickyStatuses.statuses.set(pluginId, status);
  }, [hostId, pluginId, status]);

  const sticky =
    hostId !== null && stickyStatuses?.hostId === hostId
      ? stickyStatuses.statuses.get(pluginId)
      : undefined;
  const resolved = status !== "unknown" ? status : sticky;
  return resolved === "enabled";
}
