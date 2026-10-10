import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Tag,
  User,
} from "lucide-react";
import { Dialog, primaryButton, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { SettingsTopBarActions } from "../settings/settings-top-bar";
import type {
  HostRequestParams,
  ModelSummary,
  PackageMutationResult,
  PackageSnapshot,
  PackageUpdateSummary,
  PluginLibraryCatalog,
  PluginLibraryConfigItem,
  PluginLibraryEntry,
  WorkspaceTargetRef,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { localizeHostError } from "../../lib/bridge/localize-host-error";
import { requestWithRetry } from "../../lib/bridge/request-retry";
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
import { useT } from "../../lib/i18n/use-t";
import {
  buildPluginEnvPatch,
  initialConfigValues,
  isVisionCapable,
  missingRequiredConfig,
  modelOption,
  modelOptionsKind,
  repoExtensionPattern,
  wantsModelListOptions,
  wantsModelOptions,
} from "./plugin-library-model";
import {
  cachedPluginLibraryUpdates,
  checkPluginLibraryUpdates,
  computePluginUpdateRows,
  markPluginLibraryUpdatesApplied,
  type PluginUpdateRow,
} from "./plugin-updates";
import {
  buildScopedToggleUpdates,
  pluginToggleScopes,
  pluginWorkspaceCardState,
  type PluginToggleScope,
  type PluginWorkspaceCardState,
} from "./plugin-library-model";
import { takePluginConfigDeepLink } from "./plugin-config-deeplink";
import { useTelegramViewStore } from "../telegram/telegram-view-store";
import {
  notifyDesktopSettingsSaveFailure,
  persistDesktopSettings,
} from "../../lib/desktop-settings";

type LoadState = "idle" | "loading" | "ready" | "error";

const CATALOG_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;
const MUTATION_TIMEOUT_MS = 615_000;

const inputClass =
  "box-border interface-density-control h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-focus";

function PluginIcon({ icon, name }: { icon: string; name: string }) {
  // Emoji icons render inline; image paths are not fetched (WebView CSP blocks
  // remote images), so anything else falls back to the first letter.
  const isEmoji = /\p{Extended_Pictographic}/u.test(icon);
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 select-none items-center justify-center rounded-md bg-surface-overlay text-base"
    >
      {isEmoji ? icon : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Last path segment for workspace picker labels (POSIX and Windows). */
function workspaceBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const NO_WORKSPACES: string[] = [];

/** Sentinel selection for the scope row's "global" filter: the managed
 ** layer is the user-level preference, shown through the active workspace's
 ** snapshot. Any other selection is a raw workspace path. */
const GLOBAL_SCOPE = "__global__";

/** Hook fetching the runtime's available models for dynamic select config
 *  items (`optionsSource: "pi:vision-models" | "pi:models"`). Returns the
 *  full list; the caller filters by `modelOptionsKind` when it needs the
 *  vision-only subset. */
function useRuntimeModels(enabled: boolean): readonly ModelSummary[] | null {
  const host = useAppStore((s) => s.host);
  const hostId = host?.hostInstanceId;
  const [models, setModels] = useState<readonly ModelSummary[] | null>(null);

  useEffect(() => {
    if (!enabled || !hostId) {
      setModels(null);
      return;
    }
    const currentHost = useAppStore.getState().host;
    if (!currentHost) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModels(null);
    void hostClient
      .request("piSettings.get", hostContext(currentHost), null)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          setModels([]);
          return;
        }
        const raw = response.result?.models;
        setModels(Array.isArray(raw) ? raw : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, hostId]);

  return models;
}

/** Shared configuration dialog: one instance serves every plugin card. */
function listRows(value: string): string[] {
  const rows = value.split(",").map((part) => part.trim());
  return rows.length > 0 ? rows : [""];
}

/** Ordered fallback-model list control (one Select row per fallback entry).
 *  `models` must already be filtered to the config item's kind
 *  (`modelOptionsKind`); `loading` drives the disabled placeholder state. */
function ModelFallbackListControl({
  item,
  value,
  models,
  loading,
  onChange,
}: {
  item: PluginLibraryConfigItem;
  value: string;
  models: readonly ModelSummary[];
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const rows = listRows(value);
  const options = [
    { value: "", label: t("pluginsModelFallbackChoose") },
    ...models.map(modelOption),
  ];
  const knownValues = new Set(options.map((option) => option.value));
  for (const row of rows) {
    if (row && !knownValues.has(row)) {
      options.push({ value: row, label: row });
      knownValues.add(row);
    }
  }
  const noModels = !loading && models.length === 0;

  function updateRow(index: number, next: string) {
    const nextRows = [...rows];
    nextRows[index] = next;
    onChange(nextRows.join(","));
  }

  function removeRow(index: number) {
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    onChange(nextRows.join(","));
  }

  return (
    <div className="flex flex-col gap-1.5" data-model-fallback-models={item.env}>
      {rows.map((row, index) => {
        const rowOptions = options.some((option) => option.value === row)
          ? options
          : [...options, { value: row, label: row }];
        return (
          <div className="flex items-center gap-1.5" key={`${index}-${row}`}>
            <Select
              className="h-8 min-w-0 flex-1"
              ariaLabel={`${item.label} ${index + 1}`}
              value={row}
              disabled={loading || (noModels && !row)}
              onChange={(next) => updateRow(index, next)}
              options={rowOptions}
            />
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("pluginsModelFallbackRemove")}
              disabled={rows.length === 1 && !row}
              onClick={() => removeRow(index)}
            >
              <Minus size={14} />
            </button>
            {index === rows.length - 1 && (
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-surface-overlay hover:text-foreground"
                aria-label={t("pluginsModelFallbackAdd")}
                onClick={() => onChange([...rows, ""].join(","))}
              >
                <Plus size={14} />
              </button>
            )}
          </div>
        );
      })}
      {noModels && (
        <p className="text-[11px] leading-4 text-muted">{t("pluginsModelFallbackNoModels")}</p>
      )}
    </div>
  );
}

function PluginConfigDialog({
  entry,
  onClose,
}: {
  entry: PluginLibraryEntry;
  onClose: () => void;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const desktopSettings = useAppStore((s) => s.desktopSettings);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialConfigValues(entry, desktopSettings?.pluginEnv),
  );
  const [saving, setSaving] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  const needsRuntimeModels = (entry.config ?? []).some(
    (item) => wantsModelOptions(item) || wantsModelListOptions(item),
  );
  const runtimeModels = useRuntimeModels(needsRuntimeModels);

  async function save() {
    const missing = missingRequiredConfig(entry, values);
    if (missing.length > 0) {
      pushNotification(t("pluginsConfigRequiredMissing", { label: missing[0]!.label }), "error");
      return;
    }
    setSaving(true);
    try {
      const persistedValues = { ...values };
      for (const item of entry.config ?? []) {
        if (wantsModelListOptions(item)) {
          persistedValues[item.env] = listRows(values[item.env] ?? "")
            .filter(Boolean)
            .join(",");
        }
      }
      await persistDesktopSettings({
        pluginEnv: buildPluginEnvPatch(desktopSettings?.pluginEnv, entry.id, persistedValues),
      });
      // Extensions run inside the Host process, so env vars land live; the
      // desktop-settings copy is what the next Host spawn re-injects.
      if (host) {
        const vars: Record<string, string | null> = {};
        for (const item of entry.config ?? []) {
          const value = persistedValues[item.env] ?? "";
          vars[item.env] = value.length > 0 ? value : null;
        }
        if (Object.keys(vars).length > 0) {
          const response = await hostClient.request(
            "pluginLibrary.setEnv",
            hostContext(host),
            { vars },
            15_000,
          );
          if (!response.ok)
            throw new Error(
              response.error ? localizeHostError(response.error, t) : "pluginLibrary.setEnv",
            );
        }
      }
      pushNotification(t("pluginsConfigSaved"));
      onClose();
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
    } finally {
      setSaving(false);
    }
  }

  function renderControl(item: PluginLibraryConfigItem) {
    const id = `plugin-${entry.id}-${item.key}`;
    // Runtime model list narrowed to the config item's kind (vision / all).
    const kindModels = (model: readonly ModelSummary[] | null): readonly ModelSummary[] =>
      modelOptionsKind(item) === "vision" ? (model ?? []).filter(isVisionCapable) : (model ?? []);
    // 1. Dynamic model single-select.
    if (wantsModelOptions(item)) {
      const loading = runtimeModels === null;
      const filtered = kindModels(runtimeModels);
      if (loading) {
        return (
          <Select
            className="h-8"
            ariaLabel={item.label}
            value=""
            disabled
            onChange={() => {}}
            options={[{ value: "", label: t("pluginsLoading") }]}
          />
        );
      }
      if (filtered.length === 0) {
        return (
          <>
            <input
              id={id}
              className={inputClass}
              type="text"
              autoComplete="off"
              placeholder={item.placeholder ?? "provider/modelId"}
              value={values[item.env] ?? ""}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [item.env]: event.target.value }))
              }
            />
            <p className="text-[11px] leading-4 text-muted">
              {modelOptionsKind(item) === "vision"
                ? t("pluginsVisionModelFallbackHelp")
                : t("pluginsModelFallbackHelp")}
            </p>
          </>
        );
      }
      const current = values[item.env] ?? item.default ?? "";
      const options = [
        { value: "", label: t("pluginsVisionModelAuto") },
        ...filtered.map(modelOption),
      ];
      // Keep a previously-persisted custom/stale value visible in the dropdown.
      if (current && !options.some((opt) => opt.value === current)) {
        options.push({ value: current, label: current });
      }
      return (
        <Select
          className="h-8"
          ariaLabel={item.label}
          value={current}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
          options={options}
        />
      );
    }

    // 2. Ordered fallback model list. The env-name check keeps older catalogs
    // working while the registry migrates items from text to the dynamic
    // source declaration.
    if (wantsModelListOptions(item)) {
      return (
        <ModelFallbackListControl
          item={item}
          value={values[item.env] ?? item.default ?? ""}
          models={kindModels(runtimeModels)}
          loading={runtimeModels === null}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
        />
      );
    }

    // 3. Static select with options (or unknown optionsSource that has static fallback options).
    if (item.type === "select" && (item.options?.length ?? 0) > 0) {
      return (
        <Select
          className="h-8"
          ariaLabel={item.label}
          value={values[item.env] ?? item.default ?? ""}
          onChange={(next) => setValues((prev) => ({ ...prev, [item.env]: next }))}
          options={(item.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
        />
      );
    }

    // 4. Fallback for unknown optionsSource without static options or regular text items.
    if (item.secret) {
      const shown = showSecrets[item.key] ?? false;
      return (
        <div className="relative">
          <input
            id={id}
            className={`${inputClass} w-full pr-8`}
            type={shown ? "text" : "password"}
            autoComplete="off"
            placeholder={item.placeholder}
            value={values[item.env] ?? ""}
            onChange={(event) => setValues((prev) => ({ ...prev, [item.env]: event.target.value }))}
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-muted hover:text-foreground"
            title={shown ? t("providersKeyHide") : t("providersKeyShow")}
            onClick={() => setShowSecrets((prev) => ({ ...prev, [item.key]: !shown }))}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      );
    }
    return (
      <input
        id={id}
        className={inputClass}
        type="text"
        autoComplete="off"
        placeholder={item.placeholder}
        value={values[item.env] ?? ""}
        onChange={(event) => setValues((prev) => ({ ...prev, [item.env]: event.target.value }))}
      />
    );
  }

  return (
    <Dialog
      title={t("pluginsConfigDialogTitle", { name: entry.name })}
      confirmLabel={t("commonSave")}
      onCancel={onClose}
      onConfirm={() => void save()}
    >
      <div data-plugin-config-form={entry.id} className="flex flex-col gap-3">
        {(entry.config ?? []).map((item) => (
          <div key={item.key} className="flex flex-col gap-1">
            <label className="text-xs" htmlFor={`plugin-${entry.id}-${item.key}`}>
              {item.label}
              {item.required ? <span className="text-danger"> *</span> : null}
              <span className="ml-1 font-mono text-[10px] text-muted">{item.env}</span>
            </label>
            {renderControl(item)}
            {item.description && (
              <p className="text-[11px] leading-4 text-muted">{item.description}</p>
            )}
          </div>
        ))}
        <p className="text-[11px] leading-4 text-muted">{t("pluginsConfigHint")}</p>
        {saving && <span className="sr-only">{t("pluginsConfigSaved")}</span>}
      </div>
    </Dialog>
  );
}

function PluginCard({
  entry,
  state,
  pending,
  manageLocked,
  showConfig,
  scope,
  onInstall,
  onToggle,
  onConfigure,
}: {
  entry: PluginLibraryEntry;
  /** Card state derived from the managed workspace's snapshot. */
  state: PluginWorkspaceCardState;
  /** True while this card's install/toggle mutation is in flight. Other
   *  cards stay interactive — only this card's controls are locked. */
  pending: boolean;
  /** True when installation cannot target the managed workspace (any
   ** non-active selection): the install button renders disabled with a hint. */
  manageLocked: boolean;
  /** True when the global filter is active: configuration is available
   ** (config values are user-level) and installation targets the active
   ** workspace. */
  showConfig: boolean;
  /** Which preference scope the switch writes to ("user" = global). */
  scope: PluginToggleScope;
  onInstall: (entry: PluginLibraryEntry) => void;
  /** Applies the toggle in the background. Resolves true on success. */
  onToggle: (entry: PluginLibraryEntry, enable: boolean) => Promise<boolean>;
  onConfigure: (entry: PluginLibraryEntry) => void;
}) {
  const t = useT();
  // Optimistic toggle: the switch flips immediately, the mutation runs in the
  // background, and the authoritative workspace snapshot clears the override.
  // A failed mutation reverts the override instead.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const installed = state.installed;
  const configurable = showConfig && (entry.config?.length ?? 0) > 0;
  const enabled = optimistic ?? state.enabled;
  const toggleAllowed = scope === "user" ? state.userConfigurable : state.workspaceConfigurable;
  // Global-only plugins (registry `toggleScopes: ["user"]`) are not workspace
  // manageable: the switch is replaced by a read-only state readout, because a
  // workspace can neither enable nor disable them.
  const globalOnlyCard = scope === "project" && state.globalOnly;
  /** A legacy project override still wins at runtime, so say so instead of
   ** implying the workspace cannot affect this plugin. */
  const globalOnlyHint = state.hasProjectOverride
    ? t("pluginsScopeGlobalOnlyOverrideHint")
    : t("pluginsScopeGlobalOnlyHint");

  async function handleToggle(next: boolean) {
    if (pending) return;
    setOptimistic(next);
    const ok = await onToggle(entry, next);
    if (!ok) setOptimistic(null);
  }

  return (
    <article
      data-plugin-card={entry.id}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex items-start gap-2">
        <PluginIcon icon={entry.icon} name={entry.name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="truncate text-[13px] font-semibold">{entry.name}</h3>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">v{entry.version}</span>
          </div>
          <p className="truncate text-[11px] text-muted">{entry.author ?? entry.id}</p>
        </div>
        {installed && (
          <div className="flex shrink-0 items-center gap-3">
            {(entry.config?.length ?? 0) > 0 &&
              (configurable ? (
                <button
                  type="button"
                  data-plugin-config-button
                  className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                  title={t("pluginsConfigOpen")}
                  aria-label={t("pluginsConfigOpen")}
                  disabled={pending}
                  onClick={() => onConfigure(entry)}
                >
                  <Settings2 size={14} />
                </button>
              ) : (
                <span
                  data-plugin-config-placeholder
                  className="size-7 shrink-0"
                  aria-hidden="true"
                />
              ))}
            {/* The switch itself carries the state; a separate badge is redundant.
                Global-only plugins get a read-only readout in the workspace view. */}
            {globalOnlyCard ? (
              <span
                data-plugin-global-only={entry.id}
                title={globalOnlyHint}
                className="flex shrink-0 items-center gap-1.5"
              >
                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-muted">
                  {t("pluginsScopeGlobalOnly")}
                </span>
                {state.hasProjectOverride && (
                  <span title={t("pluginsScopeGlobalOnlyOverrideHint")}>
                    <AlertTriangle
                      size={12}
                      className="text-warning"
                      aria-label={t("pluginsScopeGlobalOnlyOverrideHint")}
                    />
                  </span>
                )}
                <span className="text-[11px] tabular-nums text-muted">
                  {enabled ? t("pluginStatusEnabled") : t("pluginStatusDisabled")}
                </span>
              </span>
            ) : (
              <Switch
                checked={enabled}
                disabled={pending || !toggleAllowed}
                label={t("pluginStatusEnabled")}
                onChange={(next) => void handleToggle(next)}
              />
            )}
          </div>
        )}
      </div>

      {entry.tags && entry.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
          <Tag size={11} className="shrink-0" />
          {entry.tags.map((tag) => (
            <span key={tag} className="rounded bg-surface-overlay px-1.5 py-0.5">
              {tag}
            </span>
          ))}
        </div>
      )}

      <p className="line-clamp-2 text-xs leading-5 text-muted" title={entry.description}>
        {entry.description}
      </p>

      {!installed && (
        <div className="mt-auto flex items-center gap-2 pt-1">
          <button
            type="button"
            className={primaryButton}
            disabled={pending || manageLocked}
            title={manageLocked ? t("pluginsWorkspaceInstallDisabled") : undefined}
            onClick={() => onInstall(entry)}
          >
            <Download size={13} />
            {t("packagesInstallAction")}
          </button>
        </div>
      )}
    </article>
  );
}

export function PluginLibraryPage() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const workspace = useAppStore((s) => s.workspace);
  const pushNotification = useAppStore((s) => s.pushNotification);
  // All user-known workspace paths; the filter lets any of them be managed
  // without switching the active workspace (same model as SkillsSettings).
  const knownWorkspaces = useAppStore(
    (state) => state.desktopSettings?.knownWorkspaces ?? NO_WORKSPACES,
  );

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
  // Per-card pending set: flipping one plugin never locks the others.
  const [pendingOps, setPendingOps] = useState<Record<string, true>>({});
  const [review, setReview] = useState<PluginLibraryEntry | null>(null);
  const [configFor, setConfigFor] = useState<PluginLibraryEntry | null>(null);
  // Update check result (hydrated from the settings-open prefetch cache when
  // present); null until the first check for this host+workspace completes.
  const [pluginUpdates, setPluginUpdates] = useState<PackageUpdateSummary[] | null>(null);
  const [updateMenuOpen, setUpdateMenuOpen] = useState(false);
  // True while the "update all" loop is running, so the button swaps its label
  // for a spinner even when the pending-op set is between rows.
  const [updateAllRunning, setUpdateAllRunning] = useState(false);
  const updateMenuRootRef = useRef<HTMLDivElement | null>(null);
  // "" = active workspace; otherwise the selected workspace's raw path.
  // Selection for the scope row: GLOBAL_SCOPE (default) manages the user-
  // level layer; a workspace path manages that workspace's project layer.
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState(GLOBAL_SCOPE);
  const listRequest = useRef(0);
  // Managed snapshot: the active workspace's store snapshot for the global
  // filter; a targeted fetch for a workspace selection.
  const activePackages = useAppStore((s) => s.packages);
  const globalFilter = selectedWorkspacePath === GLOBAL_SCOPE;
  const targetSelection = targetParams();
  const workspaceCacheKey = targetSelection
    ? `${host?.hostInstanceId ?? ""}:${targetSelection.targetWorkspaceCwd}`
    : "";
  const targetedPackages = workspaceCacheKey
    ? (workspacePackageCache.get(workspaceCacheKey) ?? null)
    : null;
  const managedPackages = targetSelection ? targetedPackages : activePackages;
  // Global filter toggles write user preferences; workspace selections write
  // that workspace's project preferences.
  const toggleScope: PluginToggleScope = globalFilter ? "user" : "project";

  // 点击弹窗外或按 Escape 时关闭。不能依赖点击遮罩层的 click 事件：本弹窗渲染在
  // AppTopBar 的 data-tauri-drag-region 拖拽区子树内，外部按下鼠标会先被 Tauri
  // 当作窗口拖拽，click 永远不会触发，遮罩层方案会导致整个窗口都无法交互。
  useEffect(() => {
    if (!updateMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!updateMenuRootRef.current?.contains(event.target as Node)) {
        setUpdateMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // A dialog or modal above us already acted on this Escape.
      if (event.key === "Escape" && !event.defaultPrevented) setUpdateMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [updateMenuOpen]);
  const catalogRequest = useRef(0);

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
    const paths =
      activeCwd && !knownWorkspaces.some((path) => path === activeCwd)
        ? [activeCwd, ...knownWorkspaces]
        : [...knownWorkspaces];
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
        isGlobal: true,
      },
      ...paths.map((path) => ({
        path,
        /** "" = active workspace (cheap active-workspace channel). */
        value: path === activeCwd ? "" : path,
        basename: workspaceBasename(path),
        isActive: path === activeCwd,
        isTelegram: isSameTelegramPath(path, telegramWorkspacePath),
        isGlobal: false,
      })),
    ];
  }

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

  async function ensurePackages() {
    if (!host || !workspace?.servicesReady) {
      setPackagesLoading(false);
      return;
    }
    const target = targetParams();
    // Active workspace: the store snapshot is authoritative; nothing to fetch.
    if (!target) {
      setPackagesLoading(false);
      return;
    }
    const request = ++listRequest.current;
    const cacheKey = `${host.hostInstanceId}:${target.targetWorkspaceCwd}`;
    setPackageLoadError("");
    const hasCachedSnapshot = workspacePackageCache.has(cacheKey);
    // Cached data remains visible while a fresh projection is fetched.
    setPackagesLoading(!hasCachedSnapshot);
    try {
      const response = await requestWithRetry(() =>
        hostClient.request(
          "package.list",
          workspaceContext(host, workspace),
          {
            scope: "all",
            includeResources: true,
            ...target,
          } satisfies HostRequestParams["package.list"],
          PACKAGE_LIST_TIMEOUT_MS,
        ),
      );
      if (request !== listRequest.current) return;
      if (response?.ok) {
        setWorkspacePackageCache((previous) => {
          const next = new Map(previous);
          next.set(cacheKey, response.result);
          return next;
        });
      } else if (!hasCachedSnapshot) {
        setPackageLoadError(response?.error?.message ?? t("pluginsWorkspaceLoadFailed"));
      }
    } catch (error) {
      if (!hasCachedSnapshot) {
        setPackageLoadError(
          error instanceof Error ? error.message : t("pluginsWorkspaceLoadFailed"),
        );
      }
    } finally {
      if (request === listRequest.current) setPackagesLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.hostInstanceId]);

  // Deep-link handoff (e.g. the memo sync dialog's「配置密钥」button): once the
  // catalog and the managed snapshot are available, open the requested
  // plugin's config dialog directly. Consumed exactly once per request; a
  // missing/not-installed entry still lands on the plugin list, where the
  // card itself is the next best target.
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
    void ensurePackages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    host?.hostInstanceId,
    workspace?.id,
    workspace?.revision,
    workspace?.servicesReady,
    selectedWorkspacePath,
  ]);

  const updateCheckSupported = host?.capabilities.packageUpdateCheck ?? false;
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
        // No update button on a failed check; the manual refresh flow still
        // works and the next settings-open prefetch retries.
        if (!cancelled) setPluginUpdates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [host, workspace, updateCheckSupported]);

  const updateRows = useMemo(
    () =>
      catalog && managedPackages && pluginUpdates
        ? computePluginUpdateRows(catalog, managedPackages, pluginUpdates)
        : [],
    [catalog, managedPackages, pluginUpdates],
  );
  const updatesBusy = Object.keys(pendingOps).some((id) => id.startsWith("plugin-update:"));
  // Per-row pending: the row button swaps to a spinner while its own
  // package.update is in flight (covers both single and update-all flows).
  const rowUpdating = (key: string) => pendingOps[`plugin-update:${key}`] === true;

  /** Remove just-updated packages from the local view and the session cache
   *  so the update button/popup clear without another network roundtrip. */
  function markUpdatesApplied(packageIds: readonly string[]) {
    const ids = new Set(packageIds);
    setPluginUpdates((prev) => (prev ? prev.filter((update) => !ids.has(update.packageId)) : prev));
    const current = useAppStore.getState();
    if (current.host && current.workspace) {
      markPluginLibraryUpdatesApplied(current.host.hostInstanceId, current.workspace.id, ids);
    }
  }

  async function applyPluginUpdate(row: PluginUpdateRow): Promise<boolean> {
    const ok = await runMutation(
      "package.update",
      { packageId: row.packageId },
      `plugin-update:${row.key}`,
      row.label,
    );
    if (ok) markUpdatesApplied([row.packageId]);
    return ok;
  }

  async function applyAllPluginUpdates() {
    // Unique package ids in display order; rows sharing a package (repo
    // plugins) update together in one mutation.
    const rows = [...new Map(updateRows.map((row) => [row.packageId, row])).values()];
    setUpdateAllRunning(true);
    try {
      for (const row of rows) {
        const ok = await runMutation(
          "package.update",
          { packageId: row.packageId },
          `plugin-update:${row.key}`,
          row.label,
        );
        if (!ok) return; // host/workspace changed or the mutation failed — stop here.
        markUpdatesApplied([row.packageId]);
      }
      if (rows.length > 0) pushNotification(t("notifPluginsUpdated", { count: rows.length }));
    } finally {
      setUpdateAllRunning(false);
    }
  }

  async function runMutation(
    method:
      "package.install" | "package.update" | "resource.setPreferences" | "pluginLibrary.apply",
    params: HostRequestParams[typeof method],
    pluginId: string,
    name: string,
    options?: { notifyInstalled?: boolean },
  ): Promise<boolean> {
    if (!host || !workspace) return false;
    const target = targetParams();
    // Cross-workspace toggles bypass the active session's package channel:
    // the host applies them onto a transient view of the target workspace and
    // never touches the active graph's locks/revisions. Only session-bound
    // mutation contexts carry the workspace target.
    const base = sessionPackageContext(host, workspace);
    const context: typeof base = target
      ? { ...base, expectedSessionId: null, expectedSessionRevision: 0 }
      : base;
    const generation = captureRequestGeneration(host);
    setPendingOps((prev) => ({ ...prev, [pluginId]: true }));
    try {
      const response = await hostClient.request(
        method,
        context,
        (target && method === "resource.setPreferences"
          ? { ...params, ...target }
          : params) as never,
        MUTATION_TIMEOUT_MS,
      );
      const current = useAppStore.getState();
      if (
        !isExpectedPackageMutationCompletion(current.host, generation, response) ||
        current.workspace?.id !== workspace.id ||
        current.workspace?.revision !== workspace.revision
      )
        return false;
      if (!response.ok)
        throw new Error(
          response.error?.code === "AGENT_BUSY" && target
            ? t("pluginsWorkspaceTargetBusy")
            : response.error
              ? localizeHostError(response.error, t)
              : t("notifPluginActionFailed"),
        );
      listRequest.current += 1;
      const result = response.result as PackageMutationResult;
      // Targeted mutations update only this page's scoped snapshot;
      // active-workspace mutations flow through the shared store.
      if (target) {
        const cacheKey = `${host.hostInstanceId}:${target.targetWorkspaceCwd}`;
        setWorkspacePackageCache((previous) => {
          const next = new Map(previous);
          next.set(cacheKey, result.packageSnapshot);
          return next;
        });
      } else {
        useAppStore.getState().applyPackageMutationResult(result);
      }
      const currentHost = useAppStore.getState().host;
      const nextHost = currentHost && mergeHostIdentity(currentHost, response);
      if (nextHost) useAppStore.getState().setHost(nextHost);
      // Toggle operations stay silent — the switch already says it. Installs
      // get a toast because the button morphs into a switch off-screen.
      if (options?.notifyInstalled) pushNotification(t("notifPluginInstalled", { name }));
      return true;
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("notifPluginActionFailed"),
        "error",
      );
      return false;
    } finally {
      setPendingOps((prev) => {
        const next = { ...prev };
        delete next[pluginId];
        return next;
      });
    }
  }

  async function confirmInstall(entry: PluginLibraryEntry) {
    if (!catalog) return;
    if (entry.install.type === "repo") {
      await runMutation(
        "pluginLibrary.apply",
        {
          source: catalog.repoSource,
          pattern: repoExtensionPattern(entry.install.path),
          enabled: true,
        },
        entry.id,
        entry.name,
        { notifyInstalled: true },
      );
    } else {
      await runMutation(
        "package.install",
        { source: entry.install.source, scope: "user" },
        entry.id,
        entry.name,
        { notifyInstalled: true },
      );
    }
  }

  async function toggle(entry: PluginLibraryEntry, enable: boolean): Promise<boolean> {
    if (!catalog) return false;
    // The registry decides which layers may carry the switch. A global-only
    // plugin renders a read-only badge instead of a switch; this guard keeps
    // any other caller from writing a workspace override behind its back.
    if (!pluginToggleScopes(entry).includes(toggleScope)) return false;
    const state = pluginWorkspaceCardState(entry, catalog, managedPackages);
    const updates = buildScopedToggleUpdates(state.extensionResources, toggleScope, enable);
    if (!updates) return true;
    return runMutation("resource.setPreferences", { updates }, entry.id, entry.name);
  }

  if (!workspace?.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
        {t("packagesSelectWorkspace")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      {review && (
        <Dialog
          title={t("pluginInstallReviewTitle")}
          confirmLabel={t("pluginInstallConfirm")}
          onCancel={() => setReview(null)}
          onConfirm={() => {
            const entry = review;
            setReview(null);
            void confirmInstall(entry);
          }}
        >
          <p>{t("pluginInstallReviewBody", { name: review.name })}</p>
          <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-surface p-3 text-xs">
            <dt>{t("pluginInstallSource")}</dt>
            <dd className="break-all font-mono text-foreground">
              {review.install.type === "repo"
                ? `${catalog?.repoSource ?? ""} (${repoExtensionPattern(review.install.path)})`
                : review.install.source}
            </dd>
          </dl>
        </Dialog>
      )}

      {configFor && <PluginConfigDialog entry={configFor} onClose={() => setConfigFor(null)} />}

      <SettingsTopBarActions title={t("navPlugins")} subtitle={t("pluginsSubtitle")}>
        {updateRows.length > 0 && (
          <div ref={updateMenuRootRef} className="relative flex" data-plugin-updates>
            <button
              type="button"
              className="relative flex size-7 items-center justify-center rounded-md text-warning hover:bg-surface-overlay hover:text-foreground"
              title={t("pluginsUpdateAction")}
              aria-label={t("pluginsUpdateAction")}
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
                  <span className="flex min-w-0 items-center gap-1 truncate text-xs font-medium">
                    {updatesBusy && (
                      <Loader2 size={12} className="shrink-0 animate-spin text-warning" />
                    )}
                    <span className="truncate">
                      {t("pluginsUpdateTitle", { count: updateRows.length })}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-plugin-update-all
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                    disabled={updatesBusy}
                    onClick={() => void applyAllPluginUpdates()}
                  >
                    {updateAllRunning && <Loader2 size={11} className="animate-spin" />}
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
          disabled={catalogState === "loading" || packagesLoading}
          onClick={() => void loadCatalog({ refresh: true })}
        >
          <RefreshCw size={14} className={catalogState === "loading" ? "animate-spin" : ""} />
        </button>
      </SettingsTopBarActions>

      {/* 管理范围行与技能页同款：不做通栏工具栏，四周与内容区同为 24px，
          与卡片网格之间也留 24px，和技能页 gap-6 的节奏一致。 */}
      <div className="flex flex-col gap-1.5 px-6 pt-6 pb-6">
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("pluginsManageScope")}
        >
          <span className="shrink-0 text-xs text-muted">{t("pluginsManageScope")}</span>
          {workspaceChips().map((chip) => {
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
                ) : (
                  chip.isTelegram && <Send size={12} className="shrink-0 text-muted" aria-hidden />
                )}
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
      </div>

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

      {catalogState === "error" && !catalog ? (
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
      ) : !catalog ? (
        <p className="p-6 text-center text-sm text-muted">{t("pluginsLoading")}</p>
      ) : catalog.plugins.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">{t("pluginsEmpty")}</p>
      ) : targetSelection && !managedPackages && packagesLoading ? (
        <p className="p-6 text-center text-sm text-muted">{t("pluginsWorkspaceLoading")}</p>
      ) : targetSelection && !managedPackages && packageLoadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle size={24} className="text-danger" />
          <p className="max-w-lg text-xs text-muted">{packageLoadError}</p>
          <button type="button" className={secondaryButton} onClick={() => void ensurePackages()}>
            <RefreshCw size={13} />
            {t("pluginsRetry")}
          </button>
        </div>
      ) : (
        <div
          className="scrollbar-subtle grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 @min-[36rem]:grid-cols-2 @min-[64rem]:grid-cols-3 @min-[96rem]:grid-cols-4"
          data-settings-scroll
        >
          {catalog.plugins.map((entry) => (
            <PluginCard
              key={entry.id}
              entry={entry}
              state={pluginWorkspaceCardState(entry, catalog, managedPackages)}
              pending={pendingOps[entry.id] === true}
              manageLocked={targetParams() !== undefined}
              showConfig={globalFilter}
              scope={toggleScope}
              onInstall={(item) => setReview(item)}
              onToggle={toggle}
              onConfigure={setConfigFor}
            />
          ))}
        </div>
      )}
    </div>
  );
}
