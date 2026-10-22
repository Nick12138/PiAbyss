import type {
  PackageRecord,
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  PluginLibraryEntry,
  ResourcePreferenceUpdate,
  ResourceRecord,
  ResourceType,
} from "@piabyss/protocol";
import {
  PACKAGE_RESOURCE_TYPES,
  canConfigureResource,
  resourcePreference,
  type ResourceMode,
} from "../packages/packages-model";
import { pluginCardState, pluginWorkspaceCardState } from "../plugin-library/plugin-library-model";
import { computePluginUpdateRows, type PluginUpdateRow } from "../plugin-library/plugin-updates";

/**
 * Unified "extension" model: the merged page shows registry plugins and
 * installed packages in one grid, so both are projected onto a single
 * `LibraryItem` shape. Everything here is pure — the page owns the I/O.
 */

/** Registry that curated plugins come from; shown as the card's source tag. */
export const PLUGIN_REGISTRY_NAME = "my-pi-plugins";

/** Which layer the library is currently managing. Packages are user-level,
 *  so they render in every scope, but their switches write the managed
 *  layer's resource preference. */
export type LibraryScope =
  | { kind: "global" }
  | { kind: "workspace"; /** True for the active workspace (not a preview). */ current: boolean };

export type LibraryStatusFilter = "all" | "installed" | "not-installed" | "updatable";

/** "plugin" / "package" select the item kind; the resource types narrow to the
 *  kinds of resource an item provides. */
export type LibraryTypeFilter = "all" | "plugin" | "package" | ResourceType;

export type LibraryFilters = {
  query: string;
  status: LibraryStatusFilter;
  type: LibraryTypeFilter;
};

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
  query: "",
  status: "all",
  type: "all",
};

export type LibraryItem = {
  kind: "plugin" | "package";
  /** Stable identity: the plugin id or the package record id. */
  id: string;
  name: string;
  description: string;
  author?: string;
  version?: string;
  icon?: string;
  tags: string[];
  installed: boolean;
  enabled: boolean;
  /** A switch may write a preference at the managed scope. */
  toggleable: boolean;
  /** Registry-restricted to global toggling (`toggleScopes: ["user"]`). */
  globalOnly: boolean;
  /** A legacy project override still decides the effective state. */
  hasProjectOverride: boolean;
  /** Plugin entries only. */
  entry?: PluginLibraryEntry;
  /** Backing package record for installed items. */
  record?: PackageRecord;
  /** Resource kinds this item provides, in PACKAGE_RESOURCE_TYPES order. */
  resourceTypes: ResourceType[];
  /** The plugin declares a config schema (gear shown in the global scope). */
  hasConfig: boolean;
  updatable: boolean;
  /** Newest version reported by the update check, when known. */
  latestVersion?: string;
};

/** Preference scope a package toggle writes: the global filter manages the
 ** user layer, any workspace selection manages that workspace's project layer. */
export function resourceModeForScope(scope: LibraryScope): ResourceMode {
  return scope.kind === "global" ? "user" : "project";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Path marker that scopes resources to one repo plugin inside the registry
 ** package, e.g. "/packages/pi-web/". */
function repoMarker(repoPath: string): string {
  return `/${normalizePath(repoPath).replace(/\/+$/, "")}/`;
}

/** Effective enabled state of a resource at the given preference layer. */
export function effectiveResourceEnabled(resource: ResourceRecord, mode: ResourceMode): boolean {
  if (mode === "user") {
    return (resource.preferences.user ?? (resource.enabled ? "enabled" : "disabled")) === "enabled";
  }
  const project = resource.preferences.project;
  if (project === "enabled") return true;
  if (project === "disabled") return false;
  return effectiveResourceEnabled(resource, "user");
}

function resourceTypesOf(resources: readonly ResourceRecord[]): ResourceType[] {
  const present = new Set(resources.map((resource) => resource.type));
  return PACKAGE_RESOURCE_TYPES.filter((type) => present.has(type));
}

/** Resources belonging to a library item: every resource of its package (plus
 ** resources an extension in that package owns), and for repo plugins only the
 ** ones inside that plugin's folder. */
export function itemResources(
  item: LibraryItem,
  resources: readonly ResourceRecord[],
): ResourceRecord[] {
  const packageId = item.record?.id;
  if (!packageId) return [];
  const marker =
    item.kind === "plugin" && item.entry?.install.type === "repo"
      ? repoMarker(item.entry.install.path)
      : null;
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return resources.filter((resource) => {
    const owner =
      resource.control.kind === "owner-extension"
        ? byId.get(resource.control.ownerResourceId)
        : undefined;
    if (resource.packageId !== packageId && owner?.packageId !== packageId) return false;
    if (marker === null) return true;
    return normalizePath(owner?.path ?? resource.path).includes(marker);
  });
}

export type ResourceGroup = { type: ResourceType; resources: ResourceRecord[] };

/** Group resources by kind in the package display order. */
export function groupResourcesByType(resources: readonly ResourceRecord[]): ResourceGroup[] {
  return PACKAGE_RESOURCE_TYPES.map((type) => ({
    type,
    resources: resources.filter((resource) => resource.type === type),
  })).filter((group) => group.resources.length > 0);
}

export type PreferenceState = "inherit" | "enabled" | "disabled" | "mixed" | null;

/** Package-level segmented state: the shared preference of every configurable
 ** resource, "mixed" when they disagree, null when none is configurable. */
export function packagePreferenceState(
  resources: readonly ResourceRecord[],
  mode: ResourceMode,
): PreferenceState {
  const preferences = new Set(
    resources
      .filter((resource) => canConfigureResource(resource, mode))
      .map((resource) => resourcePreference(resource, mode)),
  );
  if (preferences.size === 0) return null;
  if (preferences.size > 1) return "mixed";
  return (preferences.values().next().value as PreferenceState) ?? null;
}

/** Preference updates that switch a whole package on or off at one layer.
 ** Resources already in the wanted state are skipped. */
export function buildPackageToggleUpdates(
  resources: readonly ResourceRecord[],
  mode: ResourceMode,
  enable: boolean,
): ResourcePreferenceUpdate[] {
  const updates: ResourcePreferenceUpdate[] = [];
  for (const resource of resources) {
    if (!canConfigureResource(resource, mode)) continue;
    if (effectiveResourceEnabled(resource, mode) === enable) continue;
    updates.push({
      resourceId: resource.id,
      targetScope: mode,
      preference: enable ? "enabled" : "disabled",
    });
  }
  return updates;
}

/** Package-level switch position: on when any resource is effectively on. */
function packageEnabled(resources: readonly ResourceRecord[], mode: ResourceMode): boolean {
  return resources.some((resource) => effectiveResourceEnabled(resource, mode));
}

/** True when at least one resource accepts a preference at this layer. */
function packageToggleable(resources: readonly ResourceRecord[], mode: ResourceMode): boolean {
  return resources.some((resource) => canConfigureResource(resource, mode));
}

/** Display name for a resource row: a package's entry file is named after the
 ** package itself, which is what the user recognizes. */
export function resourceDisplayName(resource: ResourceRecord, record: PackageRecord): string {
  if (resource.type === "extension" && /^(?:index|main)\.[cm]?[jt]sx?$/i.test(resource.name)) {
    return record.displayName;
  }
  return resource.name;
}

export type UpdateSummaryMap = ReadonlyMap<string, PackageUpdateSummary>;

/** Update rows for the top-bar popup: registry plugins (repo plugins collapse
 ** into one row) plus any installed package the registry does not cover. */
export function computeExtensionUpdateRows(
  catalog: PluginLibraryCatalog,
  packages: PackageSnapshot,
  updates: readonly PackageUpdateSummary[],
): PluginUpdateRow[] {
  const rows = computePluginUpdateRows(catalog, packages, updates);
  const covered = new Set(rows.map((row) => row.packageId));
  const byPackageId = new Map(updates.map((update) => [update.packageId, update]));
  for (const record of packages.configured) {
    if (covered.has(record.id)) continue;
    const summary = byPackageId.get(record.id);
    if (!summary) continue;
    rows.push({
      key: `package:${record.id}`,
      packageId: record.id,
      label: record.displayName,
      current: summary.current,
      available: summary.available,
    });
  }
  return rows;
}

/**
 * Project the registry catalog plus the managed package snapshot onto the
 * unified grid: plugins first (registry order), then packages (snapshot order).
 * Uninstalled registry plugins stay visible — that is how the library doubles
 * as an install catalog.
 */
export function buildLibraryItems({
  catalog,
  packages,
  scope,
  updates,
}: {
  catalog: PluginLibraryCatalog | null;
  packages: PackageSnapshot | null;
  scope: LibraryScope;
  updates: UpdateSummaryMap;
}): LibraryItem[] {
  const mode = resourceModeForScope(scope);
  const resources = packages?.resources ?? [];
  const items: LibraryItem[] = [];

  for (const entry of catalog?.plugins ?? []) {
    const state = pluginWorkspaceCardState(entry, catalog!, packages);
    const record = pluginCardState(entry, catalog!, packages).packageRecord;
    const owned = record
      ? resources.filter(
          (resource) =>
            resource.packageId === record.id &&
            (entry.install.type !== "repo" ||
              normalizePath(resource.path).includes(repoMarker(entry.install.path))),
        )
      : [];
    const summary = record ? updates.get(record.id) : undefined;
    items.push({
      kind: "plugin",
      id: entry.id,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      version: entry.version,
      icon: entry.icon,
      tags: entry.tags ?? [],
      installed: state.installed,
      enabled: state.enabled,
      toggleable: scope.kind === "global" ? state.userConfigurable : state.workspaceConfigurable,
      globalOnly: state.globalOnly,
      hasProjectOverride: state.hasProjectOverride,
      entry,
      record,
      resourceTypes: resourceTypesOf(owned),
      hasConfig: (entry.config?.length ?? 0) > 0,
      updatable: state.installed && summary !== undefined,
      latestVersion: summary?.available,
    });
  }

  for (const record of packages?.configured ?? []) {
    const owned = resources.filter((resource) => resource.packageId === record.id);
    const summary = updates.get(record.id);
    items.push({
      kind: "package",
      id: record.id,
      name: record.displayName,
      description: record.description ?? "",
      author: record.kind,
      version: record.versionOrRef,
      tags: [],
      // Configured but unresolved (stale settings entry, missing cloud folder)
      // is not installed: the card offers Install through the source install
      // flow again instead of pretending a switch can manage it.
      installed: record.installed,
      enabled: packageEnabled(owned, mode),
      toggleable: packageToggleable(owned, mode),
      globalOnly: false,
      hasProjectOverride: false,
      record,
      resourceTypes: resourceTypesOf(owned),
      hasConfig: false,
      updatable: record.updateAvailable === true || summary !== undefined,
      latestVersion: summary?.available,
    });
  }

  return items;
}

function matchesQuery(item: LibraryItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = [item.name, item.description, item.author, item.record?.source, ...item.tags]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

function matchesType(item: LibraryItem, type: LibraryTypeFilter): boolean {
  if (type === "all") return true;
  if (type === "plugin" || type === "package") return item.kind === type;
  return item.resourceTypes.includes(type);
}

function matchesStatus(item: LibraryItem, status: LibraryStatusFilter): boolean {
  switch (status) {
    case "installed":
      return item.installed;
    case "not-installed":
      return !item.installed;
    case "updatable":
      return item.updatable;
    default:
      return true;
  }
}

export function filterLibraryItems(
  items: readonly LibraryItem[],
  filters: LibraryFilters,
): LibraryItem[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      matchesQuery(item, needle) &&
      matchesStatus(item, filters.status) &&
      matchesType(item, filters.type),
  );
}

/** Look one item up by its grid identity. */
export function findLibraryItem(
  items: readonly LibraryItem[],
  id: string | null,
): LibraryItem | undefined {
  return id === null ? undefined : items.find((item) => item.id === id);
}

/** Why an uninstalled registry entry cannot be installed from the managed
 ** scope, or null when the install button is live.
 **
 ** Installs are global-only by design: every uninstalled plugin can be added
 ** once, at the user level, and every workspace then manages the same install
 ** with its own enable/disable preference. Allowing a workspace to install
 ** would fork the plugin into that workspace's project settings and leave the
 ** other scopes showing a different install state for the same plugin.
 ** Workspace scopes therefore render the install button disabled with the
 ** "install globally" tooltip. */
export type InstallBlockReason = "global-only" | null;

export function installBlockReason(scope: LibraryScope): InstallBlockReason {
  return scope.kind === "global" ? null : "global-only";
}

/** Install target scope for a registry plugin at the managed scope. */
export function pluginInstallScope(scope: LibraryScope): "user" | "project" {
  return scope.kind === "global" ? "user" : "project";
}
