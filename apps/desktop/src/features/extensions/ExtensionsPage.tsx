import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { SettingsTopBarActions } from "../settings/settings-top-bar";
import type {
  HostRequestParams,
  PackageCatalog,
  PackageCatalogItem,
  PackageMutationResult,
  PackageRecord,
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  PluginLibraryEntry,
  ResourcePreferenceUpdate,
  ResourceRecord,
  WorkspaceTargetRef,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { userErrorMessage } from "../../lib/notify-operation-error";
import {
  hostErrorLevel,
  localizeHostError,
  localizePackageMessage,
} from "../../lib/bridge/localize-host-error";
import {
  captureRequestGeneration,
  hostContext,
  isExpectedPackageMutationCompletion,
  mergeHostIdentity,
  sessionPackageContext,
  workspaceContext,
} from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { isSameTelegramPath } from "../../lib/telegram-path";
import { defaultPixieWorkspacePath, isSamePixiePath } from "../../lib/pixie-path";
import { useLocale, useT } from "../../lib/i18n/use-t";
import {
  buildScopedToggleUpdates,
  pluginToggleScopes,
  pluginWorkspaceCardState,
  repoExtensionPattern,
} from "../plugin-library/plugin-library-model";
import {
  cachedPluginLibraryUpdates,
  checkPluginLibraryUpdates,
  markPluginLibraryUpdatesApplied,
  type PluginUpdateRow,
} from "../plugin-library/plugin-updates";
import { takePluginConfigDeepLink } from "../plugin-library/plugin-config-deeplink";
import {
  applyOptimisticResourcePreferences,
  buildResourcePreferenceUpdate,
  buildResourcePreferenceUpdates,
  planPackageUpdate,
  type CatalogSort,
  type ResourceTypeFilter,
} from "../packages/packages-model";
import {
  EMPTY_LIBRARY_FILTERS,
  PLUGIN_REGISTRY_NAME,
  buildLibraryItems,
  buildPackageToggleUpdates,
  computeExtensionUpdateRows,
  filterLibraryItems,
  findLibraryItem,
  installBlockReason,
  itemResources,
  pluginInstallScope,
  resourceModeForScope,
  type LibraryFilters,
  type LibraryItem,
  type LibraryScope,
  type LibraryStatusFilter,
  type LibraryTypeFilter,
} from "./extensions-model";
import { ExtensionCard } from "./ExtensionCards";
import { ExtensionsDrawer } from "./ExtensionsDrawer";
import { ExtensionMarket, type MarketViewState } from "./ExtensionMarket";
import { PluginConfigDialog } from "./PluginConfigDialog";
import { useTelegramViewStore } from "../telegram/telegram-view-store";
import { usePixieViewStore } from "../pixie/pixie-store";

type LoadState = "idle" | "loading" | "ready" | "error";
type Tab = "library" | "market";

const CATALOG_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 60_000;
const MARKET_CATALOG_TIMEOUT_MS = 30_000;
const MARKET_QUERY_DEBOUNCE_MS = 300;
const MUTATION_TIMEOUT_MS = 615_000;
const BUSY_RETRY_INITIAL_MS = 250;
const BUSY_RETRY_MAX_MS = 2_000;

const inputClass =
  "box-border interface-density-control h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-focus";

/** Sentinel selection for the scope row's "global" filter: the managed layer
 ** is the user-level preference, shown through the active workspace's
 ** snapshot. Any other selection is a raw workspace path. */
const GLOBAL_SCOPE = "__global__";

const NO_WORKSPACES: string[] = [];

type MutationMethod =
  | "package.install"
  | "package.remove"
  | "package.update"
  | "package.updateAll"
  | "package.reloadResources"
  | "resource.setPreference"
  | "resource.setPreferences"
  | "pluginLibrary.apply";

type Review =
  | { kind: "install-plugin"; entry: PluginLibraryEntry; scope: "user" | "project" }
  | { kind: "install-package"; params: HostRequestParams["package.install"] }
  | {
      kind: "update";
      params: HostRequestParams["package.update"] | HostRequestParams["package.updateAll"];
      packages: PackageRecord[];
    }
  | { kind: "remove"; params: HostRequestParams["package.remove"]; packages: PackageRecord[] };

/** Last path segment for workspace picker labels (POSIX and Windows). */
function workspaceBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function ExtensionsPage() {
  const t = useT();
  const locale = useLocale();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const packageProgress = useAppStore((s) => s.packageProgress);
  const packageRetry = useAppStore((s) => s.packageRetry);
  const setPackageRetry = useAppStore((s) => s.setPackageRetry);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const knownWorkspaces = useAppStore(
    (state) => state.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES,
  );
  // 小精灵工作区不进 knownWorkspaces（设计决策），但它的 project-scope 插件
  // 仍需要在此管理：路径自启动后即可知，追加为专属 chip（Sparkles 徽标），
  // 不落盘、不污染持久化列表。与技能管理页同款。
  const pixieWorkspacePath = usePixieViewStore((state) => state.current?.cwd ?? null);

  const [tab, setTab] = useState<Tab>("library");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(GLOBAL_SCOPE);

  const [catalog, setCatalog] = useState<PluginLibraryCatalog | null>(null);
  const [catalogState, setCatalogState] = useState<LoadState>("idle");
  const [catalogError, setCatalogError] = useState("");
  /** Target workspace snapshots stay cached while switching between chips,
   ** so revisiting a workspace renders immediately instead of flashing empty. */
  const [workspacePackageCache, setWorkspacePackageCache] = useState<Map<string, PackageSnapshot>>(
    () => new Map(),
  );
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [packageLoadError, setPackageLoadError] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState("");

  const [pendingOps, setPendingOps] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const [pendingPreferenceUpdates, setPendingPreferenceUpdates] = useState<
    ResourcePreferenceUpdate[]
  >([]);
  const [review, setReview] = useState<Review | null>(null);
  const [configFor, setConfigFor] = useState<PluginLibraryEntry | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const drawerReturnFocus = useRef<HTMLElement | null>(null);

  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [installSource, setInstallSource] = useState("");

  const [pluginUpdates, setPluginUpdates] = useState<PackageUpdateSummary[] | null>(null);
  const [updateMenuOpen, setUpdateMenuOpen] = useState(false);
  const updateMenuRootRef = useRef<HTMLDivElement | null>(null);

  const [marketCatalog, setMarketCatalog] = useState<PackageCatalog | null>(null);
  const [marketState, setMarketState] = useState<LoadState>("idle");
  const [marketError, setMarketError] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketType, setMarketType] = useState<ResourceTypeFilter>("all");
  const [marketSort, setMarketSort] = useState<CatalogSort>("downloads");

  const [dismissedProgressOp, setDismissedProgressOp] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const pageRef = useRef<HTMLDivElement | null>(null);
  const catalogRequest = useRef(0);
  const snapshotRequest = useRef(0);
  const marketRequest = useRef(0);

  const activePackages = useAppStore((s) => s.packages);
  const globalFilter = selectedWorkspacePath === GLOBAL_SCOPE;
  const targetSelection = targetParams();
  const targetCwd = targetSelection?.targetWorkspaceCwd ?? null;
  const workspaceCacheKey = targetCwd ? `${host?.hostInstanceId ?? ""}:${targetCwd}` : "";
  const targetedPackages = workspaceCacheKey
    ? (workspacePackageCache.get(workspaceCacheKey) ?? null)
    : null;
  const managedPackages = targetSelection ? targetedPackages : activePackages;
  const scope = useMemo<LibraryScope>(
    () => (globalFilter ? { kind: "global" } : { kind: "workspace", current: targetCwd === null }),
    [globalFilter, targetCwd],
  );
  const mode = resourceModeForScope(scope);
  const toggleScope = mode;

  const allResources = useMemo(
    () =>
      applyOptimisticResourcePreferences(
        managedPackages?.resources ?? [],
        pendingPreferenceUpdates,
      ),
    [managedPackages?.resources, pendingPreferenceUpdates],
  );
  const allPackages = useMemo(
    () => managedPackages?.configured ?? [],
    [managedPackages?.configured],
  );

  const updateRows = useMemo(
    () =>
      catalog && managedPackages && pluginUpdates
        ? computeExtensionUpdateRows(catalog, managedPackages, pluginUpdates)
        : [],
    [catalog, managedPackages, pluginUpdates],
  );
  const updateSummaries = useMemo(
    () => new Map((pluginUpdates ?? []).map((update) => [update.packageId, update])),
    [pluginUpdates],
  );

  const items = useMemo(
    () =>
      buildLibraryItems({ catalog, packages: managedPackages, scope, updates: updateSummaries }),
    [catalog, managedPackages, scope, updateSummaries],
  );
  const visibleItems = useMemo(() => filterLibraryItems(items, filters), [items, filters]);
  const drawerItem = findLibraryItem(items, drawerId);

  const updateCheckSupported = host?.capabilities.packageUpdateCheck ?? false;
  const reloadRequired = managedPackages?.resourceReloadRequired === true;
  const reconcileRequired = managedPackages?.mutation?.reconcileRequired === true;
  const progressActive = packageProgress?.type === "start" || packageProgress?.type === "progress";
  const mutationRunning = managedPackages?.mutation?.status === "running" || progressActive;
  const mutationBlocked = busy || mutationRunning || reloadRequired || reconcileRequired;
  const progressIdle = progressActive && now - (packageProgress?.lastEventAt ?? now) >= 15_000;
  // Update checks run against the active workspace only — package.checkUpdates
  // takes no workspace target, so the rows would describe the active workspace
  // while the grid shows another one.
  const updatePromptMatchesScope = targetCwd === null && updateRows.length > 0;
  const updatesBusy = Object.keys(pendingOps).some((id) => id.startsWith("plugin-update:"));
  const rowUpdating = (key: string) => pendingOps[`plugin-update:${key}`] === true;

  /** Cross-workspace targeting for host requests. The global filter (and the
   ** active workspace) use the cheap active channel; other selections target
   ** their workspace directly. */
  function targetParams(): WorkspaceTargetRef | undefined {
    if (globalFilter) return undefined;
    const selected = selectedWorkspacePath || workspace?.cwd;
    if (!selected || selected === workspace?.cwd) return undefined;
    return { targetWorkspaceCwd: selected };
  }

  /**
   * Chip model for the scope row: the global filter first, then every known
   * workspace by its basename. Workspace chips keep the "" sentinel value for
   * the active workspace (requests use the cheap active-workspace channel).
   */
  function workspaceChips() {
    const activeCwd = workspace?.cwd ?? "";
    const telegramWorkspacePath = useTelegramViewStore.getState().workspacePath;
    // The pixie workspace is a real folder workspace; the store only knows it
    // after the pixie page mounts, so fall back to the host's default location
    // to recognise (and label) it in the workspace list too.
    const pixiePath = pixieWorkspacePath ?? defaultPixieWorkspacePath(host?.agentDir);
    const paths =
      activeCwd && !knownWorkspaces.some((path) => path === activeCwd)
        ? [activeCwd, ...knownWorkspaces]
        : [...knownWorkspaces];
    if (pixieWorkspacePath && !paths.some((path) => isSamePixiePath(path, pixiePath))) {
      paths.push(pixieWorkspacePath);
    }
    if (activeCwd) {
      paths.sort((left, right) => (left === activeCwd ? -1 : right === activeCwd ? 1 : 0));
    }
    return [
      {
        path: "",
        value: GLOBAL_SCOPE,
        basename: t("pluginsScopeGlobalChip"),
        isActive: false,
        isTelegram: false,
        isPixie: false,
        isGlobal: true,
      },
      ...paths.map((path) => {
        const isPixie = isSamePixiePath(path, pixiePath);
        return {
          path,
          /** "" = active workspace (cheap active-workspace channel). */
          value: path === activeCwd ? "" : path,
          // The folder is literally named "pixie"; show the product name instead.
          basename: isPixie ? t("pixieTitle") : workspaceBasename(path),
          isActive: path === activeCwd,
          isTelegram: isSameTelegramPath(path, telegramWorkspacePath),
          isPixie,
          isGlobal: false,
        };
      }),
    ];
  }

  const chips = workspaceChips();
  const selectedChip = chips.find((chip) => chip.value === selectedWorkspacePath) ?? chips[0]!;
  const scopeLevel =
    scope.kind === "global"
      ? t("extensionsScopeLevelUser")
      : scope.current
        ? t("extensionsScopeLevelProject")
        : t("extensionsScopeLevelReadOnly");

  async function loadCatalog(args: { refresh?: boolean } = {}) {
    if (!host) return;
    const request = ++catalogRequest.current;
    const expectedHostId = host.hostInstanceId;
    setCatalogState("loading");
    setCatalogError("");
    try {
      const response = await hostClient.request(
        "pluginLibrary.catalog",
        hostContext(host),
        args.refresh ? { refresh: true } : {},
        CATALOG_TIMEOUT_MS,
      );
      if (
        request !== catalogRequest.current ||
        useAppStore.getState().host?.hostInstanceId !== expectedHostId
      ) {
        return;
      }
      if (!response.ok) {
        setCatalogError(response.error?.message ?? t("pluginsLoadFailed"));
        setCatalogState(catalog ? "ready" : "error");
        return;
      }
      setCatalog(response.result);
      setCatalogState("ready");
    } catch (error) {
      if (request !== catalogRequest.current) return;
      setCatalogError(error instanceof Error ? error.message : t("pluginsLoadFailed"));
      setCatalogState(catalog ? "ready" : "error");
    }
  }

  /** Load the managed layer's package snapshot: the active workspace writes the
   ** shared store snapshot (with the SERVICE_GRAPH_BUSY backoff the packages
   ** page always had); another workspace fills this page's cache. */
  async function loadSnapshot() {
    if (!host || !workspace?.servicesReady) {
      setPackagesLoading(false);
      return;
    }
    const target = targetParams();
    const request = ++snapshotRequest.current;

    if (target) {
      const cacheKey = `${host.hostInstanceId}:${target.targetWorkspaceCwd}`;
      const hasCachedSnapshot = workspacePackageCache.has(cacheKey);
      setPackageLoadError("");
      setPackagesLoading(!hasCachedSnapshot);
      try {
        const response = await hostClient.request(
          "package.list",
          workspaceContext(host, workspace),
          {
            scope: "all",
            includeResources: true,
            ...target,
          } satisfies HostRequestParams["package.list"],
          SNAPSHOT_TIMEOUT_MS,
        );
        if (request !== snapshotRequest.current) return;
        if (response.ok) {
          setWorkspacePackageCache((previous) => {
            const next = new Map(previous);
            next.set(cacheKey, response.result);
            return next;
          });
        } else if (!hasCachedSnapshot) {
          setPackageLoadError(response.error?.message ?? t("pluginsWorkspaceLoadFailed"));
        }
      } catch (error) {
        if (!hasCachedSnapshot) {
          setPackageLoadError(
            error instanceof Error ? error.message : t("pluginsWorkspaceLoadFailed"),
          );
        }
      } finally {
        if (request === snapshotRequest.current) setPackagesLoading(false);
      }
      return;
    }

    const expected = {
      hostId: host.hostInstanceId,
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
    };
    const isCurrentRequest = () => {
      const current = useAppStore.getState();
      return (
        request === snapshotRequest.current &&
        current.host?.hostInstanceId === expected.hostId &&
        current.workspace?.id === expected.workspaceId &&
        current.workspace?.revision === expected.workspaceRevision
      );
    };
    setLoadState("loading");
    setLoadError("");
    setPackagesLoading(false);
    try {
      const requestList = () =>
        hostClient.request(
          "package.list",
          workspaceContext(host, workspace),
          { scope: "all", includeResources: true },
          SNAPSHOT_TIMEOUT_MS,
        );
      const retryDeadline = Date.now() + MUTATION_TIMEOUT_MS;
      let retryDelay = BUSY_RETRY_INITIAL_MS;
      let response = await requestList();
      while (
        !response.ok &&
        response.error?.code === "SERVICE_GRAPH_BUSY" &&
        response.error.retryable === true &&
        Date.now() < retryDeadline
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        if (!isCurrentRequest()) return;
        retryDelay = Math.min(retryDelay * 2, BUSY_RETRY_MAX_MS);
        response = await requestList();
      }
      const current = useAppStore.getState();
      if (!isCurrentRequest()) return;
      if (!response.ok) throw new Error(response.error?.message ?? t("notifPackagesLoadFailed"));
      current.applyPackageSnapshot(response.result);
      const nextHost = current.host && mergeHostIdentity(current.host, response);
      if (nextHost) current.setHost(nextHost);
      setLoadState("ready");
    } catch (error) {
      if (request !== snapshotRequest.current) return;
      setLoadError(userErrorMessage(error, t("notifPackagesLoadFailed")));
      setLoadState("error");
    }
  }

  async function refreshAll() {
    await Promise.all([
      loadCatalog({ refresh: true }),
      loadSnapshot(),
      tab === "market" ? loadMarket({ refresh: true, page: 1 }) : Promise.resolve(),
    ]);
  }

  useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId]);

  useEffect(() => {
    void loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    host?.hostInstanceId,
    workspace?.id,
    workspace?.revision,
    workspace?.servicesReady,
    selectedWorkspacePath,
  ]);

  // Deep-link handoff (e.g. the memo sync dialog's「配置密钥」button): once the
  // catalog and the managed snapshot are available, open the requested
  // plugin's config dialog directly. Consumed exactly once per request.
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current || !catalog || !managedPackages) return;
    const pluginId = takePluginConfigDeepLink();
    if (pluginId === null) return;
    deepLinkConsumed.current = true;
    const entry = catalog.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry || (entry.config?.length ?? 0) === 0) return;
    const state = pluginWorkspaceCardState(entry, catalog, managedPackages);
    if (state.installed) setConfigFor(entry);
  }, [catalog, managedPackages]);

  useEffect(() => {
    if (!host || !workspace?.servicesReady || !updateCheckSupported) return;
    const cached = cachedPluginLibraryUpdates(host.hostInstanceId, workspace.id);
    if (cached) {
      setPluginUpdates(cached);
      return;
    }
    let cancelled = false;
    void checkPluginLibraryUpdates(host, workspace)
      .then((updates) => {
        if (!cancelled) setPluginUpdates(updates);
      })
      .catch(() => {
        // No update badge on a failed check; the manual refresh flow still
        // works and the next settings-open prefetch retries.
        if (!cancelled) setPluginUpdates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [host, workspace, updateCheckSupported]);

  // Close the update popup on an outside pointer press or Escape. Not a mask:
  // the popup lives inside AppTopBar's drag region, where an overlay would
  // swallow window drags.
  useEffect(() => {
    if (!updateMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!updateMenuRootRef.current?.contains(event.target as Node)) {
        setUpdateMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setUpdateMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [updateMenuOpen]);

  // A removed/updated item must not leave the drawer pointing at nothing.
  useEffect(() => {
    if (drawerId !== null && !items.some((item) => item.id === drawerId)) setDrawerId(null);
  }, [items, drawerId]);

  useEffect(() => {
    if (!progressActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progressActive, packageProgress?.operationId]);

  useEffect(() => {
    // A finished operation should not occupy the strip forever.
    if (packageProgress?.type !== "complete") return;
    const operationId = packageProgress.operationId;
    const timer = window.setTimeout(() => setDismissedProgressOp(operationId), 5_000);
    return () => window.clearTimeout(timer);
  }, [packageProgress?.type, packageProgress?.operationId]);

  useEffect(() => {
    setPendingPreferenceUpdates([]);
  }, [workspace?.id, workspace?.revision]);

  async function loadMarket(args: { page?: number; refresh?: boolean } = {}) {
    if (!host) return;
    const request = ++marketRequest.current;
    const expectedHostId = host.hostInstanceId;
    const page = args.page ?? marketCatalog?.page ?? 1;
    const params: HostRequestParams["package.catalog"] = {
      page,
      sort: marketSort,
      ...(args.refresh ? { refresh: true } : {}),
      ...(marketQuery.trim() ? { query: marketQuery.trim() } : {}),
      ...(marketType !== "all" ? { type: marketType } : {}),
    };
    setMarketState("loading");
    setMarketError("");
    try {
      const response = await hostClient.request(
        "package.catalog",
        hostContext(host),
        params,
        MARKET_CATALOG_TIMEOUT_MS,
      );
      if (
        request !== marketRequest.current ||
        useAppStore.getState().host?.hostInstanceId !== expectedHostId
      ) {
        return;
      }
      if (!response.ok) {
        setMarketError(response.error?.message ?? t("packagesMarketError"));
        setMarketState(marketCatalog ? "ready" : "error");
        return;
      }
      setMarketCatalog(response.result);
      setMarketState("ready");
    } catch (error) {
      if (request !== marketRequest.current) return;
      setMarketError(error instanceof Error ? error.message : t("packagesMarketError"));
      setMarketState(marketCatalog ? "ready" : "error");
    }
  }

  useEffect(() => {
    marketRequest.current += 1;
    setMarketCatalog(null);
    setMarketState("idle");
    setMarketError("");
  }, [host?.hostInstanceId]);

  useEffect(() => {
    if (tab === "market" && marketState === "idle") void loadMarket({ page: 1 });
    // The first page is host-global; later pages and filters request on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, marketState, host?.hostInstanceId]);

  useEffect(() => {
    if (tab !== "market" || marketState === "idle") return;
    const timer = window.setTimeout(() => void loadMarket({ page: 1 }), MARKET_QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketQuery]);

  useEffect(() => {
    if (tab !== "market" || marketState === "idle") return;
    void loadMarket({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketType, marketSort]);

  /** Remove just-updated packages from the local view and the session cache
   ** so the update button/popup clear without another network roundtrip. */
  function markUpdatesApplied(packageIds: readonly string[]) {
    const ids = new Set(packageIds);
    setPluginUpdates((prev) => (prev ? prev.filter((update) => !ids.has(update.packageId)) : prev));
    const current = useAppStore.getState();
    if (current.host && current.workspace) {
      markPluginLibraryUpdatesApplied(current.host.hostInstanceId, current.workspace.id, ids);
    }
  }

  async function runMutation(
    method: MutationMethod,
    params: unknown,
    options?: {
      /** Pending key: the card/drawer it locks. Omitted for bulk flows. */
      opId?: string;
      name?: string;
      notifyInstalled?: boolean;
      allowReconcileRetry?: boolean;
    },
  ): Promise<boolean> {
    // Pin only the host instance + workspace id from this render; every
    // revision is re-read from the live store below. A batch loop ("update
    // all") would otherwise keep reusing this render's packageRevision, and
    // each successful package.update bumps it.
    const live = useAppStore.getState();
    const activeHost = live.host;
    const activeWorkspace = live.workspace;
    if (!host || !workspace || !activeHost || !activeWorkspace) return false;
    if (activeHost.hostInstanceId !== host.hostInstanceId || activeWorkspace.id !== workspace.id) {
      return false;
    }
    if (
      (reloadRequired || reconcileRequired) &&
      method !== "package.reloadResources" &&
      !options?.allowReconcileRetry
    ) {
      pushNotification(
        reconcileRequired
          ? t("notifPackagesReconcileBeforeMutation")
          : t("notifPackagesReloadBeforeMutation"),
        "warning",
      );
      return false;
    }

    const target = targetParams();
    // Cross-workspace toggles bypass the active session's package channel: the
    // host applies them onto a transient view of the target workspace and never
    // touches the active graph's locks/revisions.
    const base = sessionPackageContext(activeHost, activeWorkspace);
    const context: typeof base = target
      ? { ...base, expectedSessionId: null, expectedSessionRevision: 0 }
      : base;
    const generation = captureRequestGeneration(activeHost);
    const optimisticUpdates =
      method === "resource.setPreference"
        ? [params as ResourcePreferenceUpdate]
        : method === "resource.setPreferences"
          ? (params as HostRequestParams["resource.setPreferences"]).updates
          : [];
    if (optimisticUpdates.length > 0) setPendingPreferenceUpdates(optimisticUpdates);
    if (method !== "pluginLibrary.apply") {
      setPackageRetry({ method: method as never, params: params as never });
    }
    if (options?.opId) setPendingOps((prev) => ({ ...prev, [options.opId!]: true }));
    setBusy(true);
    try {
      const response = await hostClient.request(
        method,
        context,
        (target && method === "resource.setPreferences"
          ? { ...(params as object), ...target }
          : params) as never,
        MUTATION_TIMEOUT_MS,
      );
      const current = useAppStore.getState();
      if (
        !isExpectedPackageMutationCompletion(current.host, generation, response) ||
        current.workspace?.id !== activeWorkspace.id ||
        current.workspace?.revision !== activeWorkspace.revision
      ) {
        return false;
      }
      if (!response.ok) {
        const err = new Error(
          response.error?.code === "AGENT_BUSY" && target
            ? t("pluginsWorkspaceTargetBusy")
            : response.error
              ? localizeHostError(response.error, t)
              : t("notifPackagesOperationFailed"),
        );
        // Preserve the raw host error code so the transient "busy" codes can be
        // classified by hostErrorLevel in the catch below (toast-only, not history).
        if (response.error?.code) (err as Error & { code?: string }).code = response.error.code;
        throw err;
      }
      // The mutation result is authoritative; ignore any older package.list still in flight.
      snapshotRequest.current += 1;
      setPendingPreferenceUpdates([]);
      const result = response.result as PackageMutationResult;
      if (target) {
        const cacheKey = `${activeHost.hostInstanceId}:${target.targetWorkspaceCwd}`;
        setWorkspacePackageCache((previous) => {
          const next = new Map(previous);
          next.set(cacheKey, result.packageSnapshot);
          return next;
        });
      } else {
        useAppStore.getState().applyPackageMutationResult(result);
      }
      if (result.status === "partialFailure" || result.reconcileRequired) {
        pushNotification(
          result.warnings
            .map((warning) => localizeHostError(warning, t))
            .filter(Boolean)
            .join("; ") || t("notifPackagesPartialFailure"),
          "warning",
        );
      } else if (result.status === "failed") {
        pushNotification(
          result.warnings[0]
            ? localizeHostError(result.warnings[0], t)
            : t("notifPackagesOperationFailed"),
          result.warnings[0] ? hostErrorLevel(result.warnings[0]) : "error",
        );
      }
      setLoadError("");
      setLoadState("ready");
      const currentHost = useAppStore.getState().host;
      const nextHost = currentHost && mergeHostIdentity(currentHost, response);
      if (nextHost) useAppStore.getState().setHost(nextHost);
      // Toggle operations stay silent — the switch already says it. Installs
      // get a toast because the button morphs into a switch off-screen.
      if (options?.notifyInstalled) {
        pushNotification(t("notifPluginInstalled", { name: options.name ?? "" }));
      }
      return true;
    } catch (error) {
      setPendingPreferenceUpdates([]);
      pushNotification(
        error instanceof Error ? error.message : t("notifPackagesOperationFailed"),
        hostErrorLevel(error as { code?: string }),
      );
      return false;
    } finally {
      if (optimisticUpdates.length > 0) setPendingPreferenceUpdates([]);
      if (options?.opId) {
        const opId = options.opId;
        setPendingOps((prev) => {
          const next = { ...prev };
          delete next[opId];
          return next;
        });
      }
      setBusy(false);
    }
  }

  /* ------------------------------ installs ------------------------------ */

  function beginPluginInstall(item: LibraryItem) {
    const entry = item.entry;
    if (!entry) return;
    setReview({ kind: "install-plugin", entry, scope: pluginInstallScope(scope) });
  }

  function beginSourceInstall() {
    if (!installSource.trim()) return;
    setReview({
      kind: "install-package",
      params: { source: installSource.trim(), scope: "user" },
    });
  }

  function beginMarketInstall(item: PackageCatalogItem) {
    setReview({
      kind: "install-package",
      params: { source: item.installSource, scope: "user" },
    });
  }

  function beginRemoveReview(item: LibraryItem) {
    if (!item.record) return;
    setReview({
      kind: "remove",
      params: { packageId: item.record.id },
      packages: [item.record],
    });
  }

  function beginUpdateReview(item: LibraryItem) {
    if (!item.record) return;
    const plan = planPackageUpdate([item.record], false);
    if (!plan) return;
    setReview({ kind: "update", params: plan.params, packages: plan.packages });
  }

  function confirmReview() {
    if (!review) return;
    const pending = review;
    setReview(null);
    if (pending.kind === "install-plugin") {
      const entry = pending.entry;
      if (entry.install.type === "repo") {
        void runMutation(
          "pluginLibrary.apply",
          {
            source: catalog?.repoSource,
            pattern: repoExtensionPattern(entry.install.path),
            enabled: true,
          },
          { opId: entry.id, name: entry.name, notifyInstalled: true },
        );
      } else {
        void runMutation(
          "package.install",
          { source: entry.install.source, scope: pending.scope },
          { opId: entry.id, name: entry.name, notifyInstalled: true },
        );
      }
      return;
    }
    if (pending.kind === "install-package") {
      setInstallSource("");
      void runMutation("package.install", pending.params, { notifyInstalled: true });
      return;
    }
    if (pending.kind === "remove") {
      void runMutation("package.remove", pending.params, {
        opId: pending.packages[0]?.id,
      });
      return;
    }
    void runMutation(
      pending.params === null ? "package.updateAll" : "package.update",
      pending.params,
      {
        opId: pending.packages[0] ? `plugin-update:package:${pending.packages[0].id}` : undefined,
      },
    );
  }

  /* ------------------------------- toggles ------------------------------ */

  async function toggleItem(item: LibraryItem, enable: boolean): Promise<boolean> {
    if (item.kind === "plugin") {
      if (!catalog || !item.entry) return false;
      // The registry decides which layers may carry the switch; this guard
      // keeps any other caller from writing a layer the plugin forbids.
      if (!pluginToggleScopes(item.entry).includes(toggleScope)) return false;
      const state = pluginWorkspaceCardState(item.entry, catalog, managedPackages);
      const updates = buildScopedToggleUpdates(state.extensionResources, toggleScope, enable);
      if (!updates) return true;
      return runMutation(
        "resource.setPreferences",
        { updates },
        { opId: item.id, name: item.name },
      );
    }
    const updates = buildPackageToggleUpdates(itemResources(item, allResources), mode, enable);
    if (updates.length === 0) return true;
    return runMutation("resource.setPreferences", { updates }, { opId: item.id, name: item.name });
  }

  function setPackagePreference(item: LibraryItem, preference: "inherit" | "enabled" | "disabled") {
    const updates = buildResourcePreferenceUpdates(
      itemResources(item, allResources),
      mode,
      preference,
    );
    if (updates.length > 0) {
      void runMutation("resource.setPreferences", { updates }, { opId: item.id });
    }
  }

  function setResourcePreference(
    item: LibraryItem,
    resource: ResourceRecord,
    preference: "inherit" | "enabled" | "disabled",
  ) {
    const update = buildResourcePreferenceUpdate(resource, mode, preference);
    // The plural form carries the workspace target, so a previewed workspace's
    // resource preference never lands on the active one.
    if (update)
      void runMutation("resource.setPreferences", { updates: [update] }, { opId: item.id });
  }

  /* ------------------------------- actions ------------------------------ */

  async function applyPluginUpdate(row: PluginUpdateRow): Promise<boolean> {
    const ok = await runMutation(
      "package.update",
      { packageId: row.packageId },
      {
        opId: `plugin-update:${row.key}`,
        name: row.label,
      },
    );
    if (ok) markUpdatesApplied([row.packageId]);
    return ok;
  }

  async function applyAllPluginUpdates() {
    // Unique package ids in display order; rows sharing a package (repo
    // plugins) update together in one mutation. Serial on purpose: each
    // package.update bumps the host's packageRevision, and runMutation re-reads
    // the live revision per request.
    const rows = [...new Map(updateRows.map((row) => [row.packageId, row])).values()];
    for (const row of rows) {
      const ok = await runMutation(
        "package.update",
        { packageId: row.packageId },
        {
          opId: `plugin-update:${row.key}`,
          name: row.label,
        },
      );
      if (!ok) return;
      markUpdatesApplied([row.packageId]);
    }
    if (rows.length > 0) pushNotification(t("notifPluginsUpdated", { count: rows.length }));
  }

  async function openExternal(url: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  async function openFolder(item: LibraryItem) {
    const path = item.record?.installedPath;
    if (!path) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_open_path", { path });
    } catch {
      pushNotification(t("packagesOpenFolderFailed"), "warning");
    }
  }

  function openDrawer(item: LibraryItem, opener: HTMLElement | null) {
    drawerReturnFocus.current = opener;
    setDrawerId(item.id);
  }

  /** Disabled-install tooltip for the managed scope (null when install is live). */
  function installBlockedTitleFor(item: LibraryItem): string | undefined {
    if (!item.entry) return undefined;
    const reason = installBlockReason(item.entry, scope);
    if (reason === "scope") return t("pluginsWorkspaceInstallDisabled");
    if (reason === "repo-global-only") return t("extensionsRepoInstallGlobalOnly");
    return undefined;
  }

  if (!workspace?.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
        {t("packagesSelectWorkspace")}
      </div>
    );
  }

  const marketView: MarketViewState = {
    catalog: marketCatalog,
    state: marketState,
    error: marketError,
    query: marketQuery,
    type: marketType,
    sort: marketSort,
  };
  const libraryLoading =
    !catalog ||
    (!managedPackages &&
      loadState !== "error" &&
      !(targetCwd !== null && packageLoadError !== "" && !packagesLoading));
  const libraryError = catalogState === "error" && !catalog;
  const snapshotError =
    targetCwd !== null
      ? !managedPackages && !packagesLoading && packageLoadError !== ""
      : !managedPackages && loadState === "error";

  return (
    <div
      ref={pageRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface"
      aria-busy={pendingPreferenceUpdates.length > 0 || undefined}
    >
      {review && (
        <Dialog
          title={
            review.kind === "install-plugin"
              ? t("pluginInstallReviewTitle")
              : review.kind === "install-package"
                ? t("packagesInstallReviewTitle")
                : review.kind === "remove"
                  ? t("packagesRemoveReviewTitle")
                  : t("packagesUpdateReviewTitle")
          }
          confirmLabel={
            review.kind === "install-plugin"
              ? t("pluginInstallConfirm")
              : review.kind === "install-package"
                ? t("packagesInstallConfirm")
                : review.kind === "remove"
                  ? t("packagesRemoveConfirm")
                  : review.params === null
                    ? t("packagesUpdateAllConfirm")
                    : t("packagesUpdateConfirm")
          }
          tone={review.kind === "remove" ? "danger" : "default"}
          onCancel={() => setReview(null)}
          onConfirm={confirmReview}
        >
          {review.kind === "install-plugin" ? (
            <>
              <p>
                {review.scope === "user"
                  ? t("pluginInstallReviewBody", { name: review.entry.name })
                  : t("pluginInstallReviewBodyProject", { name: review.entry.name })}
              </p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("pluginInstallSource")}</dt>
                <dd className="break-all font-mono text-foreground">
                  {review.entry.install.type === "repo"
                    ? `${catalog?.repoSource ?? ""} (${repoExtensionPattern(review.entry.install.path)})`
                    : review.entry.install.source}
                </dd>
              </dl>
            </>
          ) : review.kind === "install-package" ? (
            <>
              <p>{t("packagesInstallWarning")}</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("packagesSource")}</dt>
                <dd className="break-all font-mono text-foreground">{review.params.source}</dd>
                <dt>{t("packagesScope")}</dt>
                <dd className="capitalize text-foreground">{review.params.scope}</dd>
              </dl>
            </>
          ) : review.kind === "remove" ? (
            <>
              <p>{t("packagesRemoveWarning")}</p>
              <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
                <dt>{t("packagesPackage")}</dt>
                <dd className="truncate text-foreground">{review.packages[0]?.displayName}</dd>
                <dt>{t("packagesSource")}</dt>
                <dd className="break-all font-mono text-foreground">
                  {review.packages[0]?.source}
                </dd>
                <dt>{t("packagesScope")}</dt>
                <dd className="text-foreground">
                  {review.packages[0]?.scope === "project"
                    ? t("packagesScopeProject")
                    : t("packagesScopeUser")}
                </dd>
              </dl>
            </>
          ) : (
            <>
              <p>{t("packagesUpdateWarning")}</p>
              {review.packages.some((item) => item.scope === "project") && (
                <p className="mt-2 text-warning">{t("packagesUpdateProjectWarning")}</p>
              )}
              <ul className="mt-3 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 text-xs text-foreground">
                {review.packages.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3 px-1 py-1">
                    <span className="truncate">{item.displayName}</span>
                    <span className="shrink-0 text-muted">{item.versionOrRef ?? item.scope}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Dialog>
      )}

      {configFor && <PluginConfigDialog entry={configFor} onClose={() => setConfigFor(null)} />}

      {drawerItem && (
        <ExtensionsDrawer
          item={drawerItem}
          scope={scope}
          resources={itemResources(drawerItem, allResources)}
          pending={pendingOps[drawerItem.id] === true}
          mutationBlocked={mutationBlocked}
          installBlockedTitle={installBlockedTitleFor(drawerItem)}
          returnFocusTo={drawerReturnFocus.current}
          anchor={pageRef.current}
          onClose={() => setDrawerId(null)}
          onUpdate={(item) => {
            if (item.installed) beginUpdateReview(item);
            else beginPluginInstall(item);
          }}
          onInstall={beginPluginInstall}
          onRemove={beginRemoveReview}
          onOpenFolder={(item) => void openFolder(item)}
          onPackagePreference={setPackagePreference}
          onResourcePreference={(item, resource, preference) =>
            setResourcePreference(item, resource, preference)
          }
        />
      )}

      <SettingsTopBarActions title={t("navExtensions")} subtitle={t("extensionsSubtitle")}>
        {/* 视图切换放顶栏，样式对齐「用量」页的日期筛选：同样的容器、同样的
            accent 选中态。刻意不带 data-ui="segmented"——那套钩子会被
            theme-family（vercel / apple）再改写一遍，就和用量页不一致了。 */}
        <div
          className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-raised p-0.5"
          role="group"
          aria-label={t("extensionsTabGroup")}
        >
          {(
            [
              ["library", "extensionsTabLibrary"],
              ["market", "extensionsTabMarket"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tab === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted hover:bg-surface-overlay hover:text-foreground"
              }`}
              onClick={() => {
                setTab(id);
                // The drawer belongs to the library grid; the market has no
                // detail view, so switching tabs dismisses it.
                setDrawerId(null);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
        {updatePromptMatchesScope && (
          <div ref={updateMenuRootRef} className="relative flex" data-plugin-updates>
            <button
              type="button"
              className="relative flex size-7 items-center justify-center rounded-md text-warning hover:bg-surface-overlay hover:text-foreground"
              title={t("pluginsUpdateAction")}
              aria-label={t("pluginsUpdateAction")}
              aria-expanded={updateMenuOpen}
              onClick={() => setUpdateMenuOpen((open) => !open)}
            >
              <ArrowDownToLine size={14} />
              <span
                className={`absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-semibold leading-none text-surface${
                  updatesBusy ? " animate-pulse" : ""
                }`}
              >
                {updateRows.length}
              </span>
            </button>
            {updateMenuOpen && (
              <div
                data-plugin-updates-menu
                data-tauri-drag-region="false"
                className="absolute right-0 top-8 z-50 w-72 rounded-lg border border-border bg-surface p-2 shadow-lg"
              >
                <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
                  <span className="truncate text-xs font-medium">
                    {t("pluginsUpdateTitle", { count: updateRows.length })}
                  </span>
                  <button
                    type="button"
                    data-plugin-update-all
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                    disabled={updatesBusy}
                    onClick={() => void applyAllPluginUpdates()}
                  >
                    {t("pluginsUpdateAll")}
                  </button>
                </div>
                <div className="flex flex-col">
                  {updateRows.map((row) => (
                    <div
                      key={row.key}
                      data-plugin-update-row={row.key}
                      className="flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-surface-overlay"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">
                          {row.label}
                          {row.repoPluginCount !== undefined &&
                            row.repoPluginCount > 1 &&
                            ` · ${t("pluginsUpdateRepoBundle", { count: row.repoPluginCount })}`}
                        </p>
                        {row.current && row.available && (
                          <p className="text-[11px] tabular-nums text-muted">
                            v{row.current} → v{row.available}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        data-plugin-update-one={row.key}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs leading-4 text-foreground hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={updatesBusy}
                        onClick={() => void applyPluginUpdate(row)}
                      >
                        {rowUpdating(row.key) && (
                          <Loader2 size={11} className="animate-spin text-accent" />
                        )}
                        {rowUpdating(row.key) ? t("pluginsUpdating") : t("pluginsUpdateOne")}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
          title={t("pluginsRefresh")}
          aria-label={t("pluginsRefresh")}
          disabled={catalogState === "loading" || packagesLoading || busy}
          onClick={() => void refreshAll()}
        >
          <RefreshCw
            size={14}
            className={catalogState === "loading" || loadState === "loading" ? "animate-spin" : ""}
          />
        </button>
        {tab === "market" && (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-accent"
            onClick={() => void openExternal("https://pi.dev/packages")}
          >
            {t("packagesCatalogLink")} <ExternalLink size={11} />
          </button>
        )}
      </SettingsTopBarActions>

      {/* 管理范围：市场是纯全局安装入口，所以只在这一栏显示（Tab 已在顶栏）。 */}
      {tab === "library" && (
        <div
          className="flex flex-wrap items-center gap-1.5 px-6 pb-3 pt-3"
          role="group"
          aria-label={t("pluginsManageScope")}
        >
          <span className="shrink-0 text-xs text-muted">{t("pluginsManageScope")}</span>
          {chips.map((chip) => {
            const selected = chip.value === selectedWorkspacePath;
            const label = chip.isActive
              ? `${chip.basename} · ${t("pluginsWorkspaceActive")}`
              : chip.basename;
            return (
              <button
                key={chip.path}
                type="button"
                aria-pressed={selected}
                aria-label={label}
                title={chip.path || undefined}
                className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
                  selected
                    ? "border-accent/60 bg-accent/10 text-foreground"
                    : "border-border text-muted hover:bg-surface-overlay hover:text-foreground"
                }`}
                onClick={() => setSelectedWorkspacePath(chip.value)}
              >
                {chip.isGlobal ? (
                  <User size={12} className="shrink-0 text-muted" aria-hidden />
                ) : chip.isTelegram ? (
                  <Send size={12} className="shrink-0 text-muted" aria-hidden />
                ) : chip.isPixie ? (
                  <Sparkles size={12} className="shrink-0 text-muted" aria-hidden />
                ) : null}
                <span className="max-w-48 truncate">{chip.basename}</span>
                {chip.isActive && !chip.isGlobal && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-success"
                    title={t("pluginsWorkspaceActive")}
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
          {packagesLoading && <RefreshCw size={12} className="animate-spin text-muted" />}
        </div>
      )}

      {catalog && catalog.warnings.length > 0 && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-6 py-2 text-xs"
        >
          <AlertTriangle size={14} className="text-warning" />
          <span className="min-w-48 flex-1 text-warning" title={catalog.warnings.join("\n")}>
            {t("pluginsWarnings")}: {catalog.warnings.join("; ")}
          </span>
        </div>
      )}

      {packageProgress &&
        pendingPreferenceUpdates.length === 0 &&
        dismissedProgressOp !== packageProgress.operationId && (
          <div
            data-settings-top-banner
            className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs"
          >
            <RefreshCw size={13} className={progressActive ? "animate-spin" : ""} />
            <span className="min-w-0 flex-1 truncate text-muted" title={packageProgress.source}>
              {(packageProgress.type === "error"
                ? (localizePackageMessage(packageProgress.message, t) ?? packageProgress.message)
                : packageProgress.message) ?? packageProgress.source}
            </span>
            <span className={packageProgress.type === "error" ? "text-danger" : "text-muted"}>
              {progressIdle
                ? t("packagesProgressStillWaiting")
                : packageProgress.type === "error"
                  ? t("packagesProgressFailed")
                  : packageProgress.type === "complete"
                    ? t("packagesProgressDone")
                    : t("packagesProgressWorking")}
            </span>
            <button
              type="button"
              title={t("commonDismiss")}
              aria-label={t("packagesProgressDismiss")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
              onClick={() => setDismissedProgressOp(packageProgress.operationId)}
            >
              <X size={13} />
            </button>
          </div>
        )}

      {pendingPreferenceUpdates.length > 0 && (
        <div
          data-settings-top-banner
          className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-overlay/50 px-4 text-xs"
          role="status"
          aria-live="polite"
        >
          <RefreshCw size={13} className="animate-spin" />
          <span className="font-medium">{t("packagesApplyingPrefs")}</span>
          <span className="min-w-0 flex-1 truncate text-muted">
            {t("packagesApplyingPrefsDetail", { count: pendingPreferenceUpdates.length })}
          </span>
        </div>
      )}

      {reconcileRequired && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs"
        >
          <AlertTriangle size={14} className="text-warning" />
          <span className="min-w-48 flex-1 text-warning">{t("packagesReconcileWarning")}</span>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void loadSnapshot()}
          >
            {t("packagesReloadState")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !packageRetry}
            onClick={() =>
              packageRetry &&
              void runMutation(
                packageRetry.method as MutationMethod,
                packageRetry.params as never,
                { allowReconcileRetry: true },
              )
            }
          >
            {t("packagesRetryOperation")}
          </button>
        </div>
      )}

      {reloadRequired && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs"
        >
          <span className="min-w-48 flex-1 text-warning">{t("packagesReloadRequired")}</span>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => void runMutation("package.reloadResources", null)}
          >
            {t("packagesReloadResources")}
          </button>
        </div>
      )}

      {loadState === "error" && activePackages && (
        <div
          data-settings-top-banner
          className="flex flex-wrap items-center gap-2 border-b border-danger/35 bg-danger/10 px-4 py-2 text-xs"
        >
          <AlertTriangle size={14} className="text-danger" />
          <span className="min-w-48 flex-1 text-danger">
            {t("packagesRefreshFailed", { message: loadError })}
          </span>
          <button type="button" className={secondaryButton} onClick={() => void loadSnapshot()}>
            <RefreshCw size={13} /> {t("packagesTryAgain")}
          </button>
        </div>
      )}

      {tab === "market" ? (
        <ExtensionMarket
          view={marketView}
          allPackages={allPackages}
          locale={locale}
          mutationBlocked={mutationBlocked}
          onQuery={setMarketQuery}
          onType={setMarketType}
          onSort={setMarketSort}
          onRefresh={() => void loadMarket({ refresh: true, page: 1 })}
          onPage={(page) => void loadMarket({ page })}
          onOpen={(url) => void openExternal(url)}
          onInstall={beginMarketInstall}
          onOpenSite={() => void openExternal("https://pi.dev/packages")}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
            <label className="relative w-56">
              <input
                className={`${inputClass} w-full`}
                aria-label={t("extensionsSearchAria")}
                placeholder={t("extensionsSearchPlaceholder")}
                value={filters.query}
                onChange={(event) => setFilters({ ...filters, query: event.target.value })}
              />
            </label>
            <Select
              className="h-8"
              ariaLabel={t("extensionsStatusFilter")}
              value={filters.status}
              onChange={(next) => setFilters({ ...filters, status: next as LibraryStatusFilter })}
              options={[
                { value: "all", label: t("extensionsStatusAll") },
                { value: "installed", label: t("extensionsStatusInstalled") },
                { value: "not-installed", label: t("extensionsStatusNotInstalled") },
                { value: "updatable", label: t("extensionsStatusUpdatable") },
              ]}
            />
            <Select
              className="h-8"
              ariaLabel={t("extensionsTypeFilter")}
              value={filters.type}
              onChange={(next) => setFilters({ ...filters, type: next as LibraryTypeFilter })}
              options={[
                { value: "all", label: t("extensionsTypeAll") },
                { value: "plugin", label: t("extensionsTypePlugin") },
                { value: "package", label: t("extensionsTypePackage") },
                { value: "extension", label: t("typeExtension") },
                { value: "skill", label: t("typeSkill") },
                { value: "prompt", label: t("typePrompt") },
                { value: "theme", label: t("typeTheme") },
              ]}
            />
            <span className="flex-1" />
            <input
              className={`${inputClass} w-56`}
              aria-label={t("packagesSourceLabel")}
              placeholder={t("packagesSourcePlaceholder")}
              value={installSource}
              onChange={(event) => setInstallSource(event.target.value)}
            />
            <button
              type="button"
              className={`${primaryButton} shrink-0`}
              disabled={mutationBlocked || !installSource.trim()}
              onClick={beginSourceInstall}
            >
              {t("packagesInstallAction")}
            </button>
          </div>
          <p className="px-6 pb-3 text-xs text-muted" data-extensions-scope-note>
            {t("extensionsScopeNote", {
              scope: selectedChip.basename,
              level: scopeLevel,
              source: PLUGIN_REGISTRY_NAME,
            })}
          </p>

          {libraryError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertTriangle size={24} className="text-danger" />
              <div>
                <p className="text-sm font-medium">{t("pluginsLoadFailed")}</p>
                <p className="mt-1 max-w-lg text-xs text-muted">{catalogError}</p>
              </div>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => void loadCatalog({ refresh: true })}
              >
                <RefreshCw size={13} />
                {t("pluginsRetry")}
              </button>
            </div>
          ) : snapshotError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertTriangle size={24} className="text-danger" />
              <p className="max-w-lg text-xs text-muted">{packageLoadError}</p>
              <button type="button" className={secondaryButton} onClick={() => void loadSnapshot()}>
                <RefreshCw size={13} />
                {t("pluginsRetry")}
              </button>
            </div>
          ) : libraryLoading ? (
            <p className="p-6 text-center text-sm text-muted">{t("extensionsLoading")}</p>
          ) : visibleItems.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted">{t("extensionsEmpty")}</p>
          ) : (
            <div
              className="scrollbar-subtle grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 @min-[30rem]:grid-cols-2 @min-[70rem]:grid-cols-3 @min-[92rem]:grid-cols-4"
              data-settings-scroll
            >
              {visibleItems.map((item) => (
                <ExtensionCard
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  scope={scope}
                  pending={pendingOps[item.id] === true}
                  installBlockedTitle={installBlockedTitleFor(item)}
                  onOpen={openDrawer}
                  onInstall={beginPluginInstall}
                  onToggle={toggleItem}
                  onConfigure={(target) => target.entry && setConfigFor(target.entry)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
