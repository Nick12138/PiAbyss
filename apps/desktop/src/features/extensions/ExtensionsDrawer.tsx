import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, FolderOpen, Trash2, X } from "lucide-react";
import { secondaryButton } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import type { Translate } from "../../lib/i18n/use-t";
import type { PackageRecord, ResourceRecord, ResourceType } from "@piabyss/protocol";
import {
  canConfigureResource,
  resourcePreference,
  type ResourceMode,
} from "../packages/packages-model";
import {
  effectiveResourceEnabled,
  groupResourcesByType,
  packagePreferenceState,
  resourceDisplayName,
  type LibraryItem,
  type LibraryScope,
  type PreferenceState,
} from "./extensions-model";
import { TypeBadge, itemBadgeType } from "./ExtensionCards";

type Preference = "inherit" | "enabled" | "disabled";

/** Keep in sync with the panel's transition-duration. */
const DRAWER_ANIMATION_MS = 200;

function preferenceLabel(t: Translate, value: Preference): string {
  return value === "inherit"
    ? t("packagesPrefInherit")
    : value === "enabled"
      ? t("packagesPrefEnabled")
      : t("packagesPrefDisabled");
}

function scopeLabel(t: Translate, scope: PackageRecord["scope"]): string {
  return scope === "project" ? t("packagesScopeProject") : t("packagesScopeUser");
}

function pluralType(t: Translate, type: ResourceType): string {
  return type === "extension"
    ? t("typeExtensions")
    : type === "skill"
      ? t("typeSkills")
      : type === "prompt"
        ? t("typePrompts")
        : t("typeThemes");
}

function Segmented({
  label,
  values,
  state,
  disabled,
  onPick,
}: {
  label: string;
  values: readonly Preference[];
  state: PreferenceState;
  disabled: boolean;
  onPick: (preference: Preference) => void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={label}
      data-ui="segmented"
      className="interface-density-control inline-flex h-8 gap-1 rounded-lg border border-border bg-surface-raised p-0.5"
    >
      {values.map((value) => (
        <button
          key={value}
          type="button"
          aria-label={t("packagesPrefAria", { value: preferenceLabel(t, value), label })}
          aria-pressed={state === value}
          data-ui="segmented-item"
          data-state={state === value ? "active" : "inactive"}
          className={`rounded-md px-2.5 text-xs capitalize ${
            state === value
              ? "bg-selection text-selection-foreground"
              : "text-muted hover:text-foreground"
          }`}
          disabled={disabled || state === null}
          onClick={() => onPick(value)}
        >
          {preferenceLabel(t, value)}
        </button>
      ))}
    </div>
  );
}

function ResourceRow({
  resource,
  record,
  mode,
  disabled,
  onPreference,
}: {
  resource: ResourceRecord;
  record: PackageRecord;
  mode: ResourceMode;
  disabled: boolean;
  onPreference: (resource: ResourceRecord, preference: Preference) => void;
}) {
  const t = useT();
  const configurable = canConfigureResource(resource, mode);
  const preference = resourcePreference(resource, mode);
  const readOnlyReason =
    resource.control.kind === "owner-extension"
      ? t("packagesManagedByExtension")
      : resource.control.kind === "read-only"
        ? resource.control.reason
        : undefined;
  // The global layer has no "inherit": it is the base every workspace inherits
  // from, so only enable/disable apply there.
  const values: readonly Preference[] =
    mode === "project" ? ["inherit", "enabled", "disabled"] : ["enabled", "disabled"];

  return (
    <li
      data-resource-row={resource.id}
      className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <TypeBadge type={resource.type} />
          <span className="truncate text-sm font-medium">
            {resourceDisplayName(resource, record)}
          </span>
          {resource.type === "skill" && resource.manualOnly && (
            <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted">
              {t("packagesManualOnly")}
            </span>
          )}
          {resource.diagnostics.some((item) => item.severity === "error") && (
            <AlertTriangle size={13} className="text-danger" />
          )}
        </div>
        <p className="mt-1 truncate font-mono text-[11px] text-muted" title={resource.path}>
          {resource.relativePath ?? resource.path}
        </p>
        {resource.diagnostics.map((diagnostic, index) => (
          <p
            key={`${diagnostic.message}-${index}`}
            className={`mt-1 text-[11px] ${
              diagnostic.severity === "error"
                ? "text-danger"
                : diagnostic.severity === "warning"
                  ? "text-warning"
                  : "text-muted"
            }`}
          >
            {diagnostic.message}
          </p>
        ))}
      </div>
      <div className="flex min-w-40 items-center justify-end gap-3">
        <span className={`text-[11px] ${resource.enabled ? "text-success" : "text-muted"}`}>
          {resource.enabled ? t("packagesActive") : t("packagesInactive")}
        </span>
        {configurable ? (
          <Segmented
            label={t("packagesPrefAria", {
              value: preferenceLabel(t, preference),
              label: resource.name,
            })}
            values={values}
            state={preference}
            disabled={disabled}
            onPick={(next) => onPreference(resource, next)}
          />
        ) : (
          <span className="max-w-44 text-right text-[11px] text-muted" title={readOnlyReason}>
            {readOnlyReason ?? t("packagesReadOnly")}
          </span>
        )}
      </div>
    </li>
  );
}

export function ExtensionsDrawer({
  item,
  scope,
  resources,
  pending,
  mutationBlocked,
  installBlockedTitle,
  onClose,
  onUpdate,
  onInstall,
  onRemove,
  onOpenFolder,
  onPackagePreference,
  onResourcePreference,
  returnFocusTo,
  anchor,
}: {
  item: LibraryItem;
  scope: LibraryScope;
  /** Resources owned by this item (already scoped to its package / repo folder). */
  resources: ResourceRecord[];
  pending: boolean;
  mutationBlocked: boolean;
  /** Set when installing is not possible from the managed scope. */
  installBlockedTitle?: string;
  onClose: () => void;
  onUpdate: (item: LibraryItem) => void;
  onInstall: (item: LibraryItem) => void;
  onRemove: (item: LibraryItem) => void;
  onOpenFolder: (item: LibraryItem) => void;
  onPackagePreference: (item: LibraryItem, preference: Preference) => void;
  onResourcePreference: (
    item: LibraryItem,
    resource: ResourceRecord,
    preference: Preference,
  ) => void;
  /** Element that opened the drawer; focus goes back there on close. */
  returnFocusTo: HTMLElement | null;
  /** The page shell the drawer floats over: it is portalled to <body> and
   ** pinned to this element's rect, so it never participates in the settings
   ** layout and never covers the app top bar. */
  anchor: HTMLElement | null;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const mode: ResourceMode = scope.kind === "global" ? "user" : "project";
  const record = item.record;
  const disabled = pending || mutationBlocked;
  // Enter/exit animation: the panel mounts off-canvas and slides in on the next
  // frame; closing reverses it and only then unmounts (via onClose).
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The panel is fixed-positioned against the page shell's rect: it floats over
  // the grid without joining the settings flex layout (no reflow / squeeze) and
  // stops below the app top bar.
  const [bounds, setBounds] = useState<{ top: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      setBounds({ top: rect.top, height: rect.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  useEffect(() => {
    if (!bounds) return;
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [bounds]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  // Focus moves into the panel once it actually exists (the first render only
  // measures the anchor) and goes back to the opener on unmount.
  const [focused, setFocused] = useState(false);
  const returnFocusRef = useRef(returnFocusTo);
  returnFocusRef.current = returnFocusTo;
  useEffect(() => {
    if (!bounds || focused) return;
    closeRef.current?.focus();
    setFocused(true);
  }, [bounds, focused]);
  useEffect(() => () => returnFocusRef.current?.focus(), []);

  function requestClose() {
    if (closeTimer.current !== null) return;
    setOpen(false);
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), DRAWER_ANIMATION_MS);
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Consume the key like Dialog does: the Settings overlay also listens for
      // Escape on window, and closing the drawer must not close Settings too.
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    // document (bubble) rather than window, so this runs before SettingsPage's
    // window-level Escape handler can act on the same key.
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
    // requestClose only touches refs/state setters, so a mount-stable listener
    // is safe and keeps Escape working across re-renders.
  }, []);

  const groups = groupResourcesByType(resources);
  const enabledCount = resources.filter((resource) =>
    effectiveResourceEnabled(resource, mode),
  ).length;
  const packageState = packagePreferenceState(resources, mode);
  // Repo plugins live inside the shared registry package, so "remove" would drop
  // every curated plugin at once: the action stays with the package card.
  const canRemove = item.kind === "package" || item.entry?.install.type !== "repo";

  if (!bounds) return null;

  // Portalled to <body> like Dialog: a themed ancestor with a filter/transform
  // would otherwise become the containing block and drag the panel into it.
  return createPortal(
    <>
      <div
        data-extensions-drawer-mask
        data-state={open ? "open" : "closed"}
        style={{ top: bounds.top, height: bounds.height }}
        className={`fixed inset-x-0 z-40 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={requestClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
        data-extensions-drawer={item.id}
        data-state={open ? "open" : "closed"}
        style={{ top: bounds.top, height: bounds.height }}
        className={`fixed right-0 z-[45] flex w-[430px] max-w-[92vw] flex-col border-l border-border bg-surface shadow-[-16px_0_40px_rgba(0,0,0,0.25)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold">{item.name}</h2>
              <TypeBadge type={itemBadgeType(item)} />
              {item.updatable && (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">
                  {t("extensionsUpdateBadge")}
                </span>
              )}
              {scope.kind === "workspace" && item.kind === "plugin" && item.globalOnly && (
                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-muted">
                  {t("pluginsScopeGlobalOnly")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted">
              {item.author ?? item.record?.source ?? item.id}
              {item.version && (
                <span className="ml-1 font-mono">
                  · {item.kind === "plugin" ? `v${item.version}` : item.version}
                </span>
              )}
              {item.updatable && item.latestVersion && (
                <span className="ml-1 font-mono text-warning">→ {item.latestVersion}</span>
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-extensions-drawer-close
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground"
            title={t("extensionsDrawerClose")}
            aria-label={t("extensionsDrawerClose")}
            onClick={requestClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-8 pt-3.5" data-extensions-drawer-body>
          <div className="mb-1 flex flex-wrap gap-1.5">
            {item.installed ? (
              <>
                {item.updatable && (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={disabled}
                    onClick={() => onUpdate(item)}
                  >
                    <Download size={13} />
                    {t("packagesUpdate")}
                  </button>
                )}
                {record?.installedPath && (
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => onOpenFolder(item)}
                  >
                    <FolderOpen size={13} />
                    {t("packagesOpenFolder")}
                  </button>
                )}
                <button
                  type="button"
                  className={`${secondaryButton} border-danger/40 text-danger hover:bg-danger/10`}
                  disabled={disabled || !canRemove}
                  title={canRemove ? undefined : t("extensionsRepoRemoveHint")}
                  onClick={() => onRemove(item)}
                >
                  <Trash2 size={13} />
                  {t("packagesRemove")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={secondaryButton}
                disabled={disabled || installBlockedTitle !== undefined}
                title={installBlockedTitle}
                onClick={() => onInstall(item)}
              >
                <Download size={13} />
                {t("packagesInstallAction")}
              </button>
            )}
          </div>

          <section className="mt-4">
            <h3 className="mb-2 text-xs text-muted">{t("packagesDetailsGroup")}</h3>
            <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted">{t("packagesSource")}</dt>
              <dd className="break-all">{record?.source ?? item.author ?? "—"}</dd>
              <dt className="text-muted">{t("packagesIdentity")}</dt>
              <dd className="break-all font-mono text-[11.5px]">{record?.identity ?? item.id}</dd>
              <dt className="text-muted">{t("packagesTypeVersion")}</dt>
              <dd>
                {item.kind === "plugin"
                  ? t("extensionsTypePlugin")
                  : item.resourceTypes.length > 0
                    ? item.resourceTypes.map((type) => pluralType(t, type)).join(" / ")
                    : t("extensionsTypePackage")}
                {item.version
                  ? ` · ${item.kind === "plugin" ? `v${item.version}` : item.version}`
                  : ""}
                {item.updatable && item.latestVersion ? ` → ${item.latestVersion}` : ""}
              </dd>
              <dt className="text-muted">{t("packagesInstalledPath")}</dt>
              <dd className="break-all font-mono text-[11.5px]">
                {record?.installedPath ?? t("packagesManagedByPi")}
              </dd>
              {record && (
                <>
                  <dt className="text-muted">{t("packagesScope")}</dt>
                  <dd>{scopeLabel(t, record.scope)}</dd>
                </>
              )}
            </dl>
          </section>

          {groups.length > 0 && record && (
            <section className="mt-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs text-muted">{t("packagesResourcesGroup")}</h3>
                  <p className="mt-1 text-xs text-muted">
                    {t("packagesEnabledDisabled", {
                      enabled: enabledCount,
                      disabled: resources.length - enabledCount,
                    })}
                  </p>
                </div>
                <Segmented
                  label={t("packagesPackageAria", { name: item.name })}
                  values={
                    mode === "project"
                      ? ["inherit", "enabled", "disabled"]
                      : ["enabled", "disabled"]
                  }
                  state={packageState}
                  disabled={disabled}
                  onPick={(preference) => onPackagePreference(item, preference)}
                />
              </div>
              <div className="space-y-3">
                {groups.map((group) => (
                  <div key={group.type}>
                    <h4 className="mb-1 text-[11px] font-semibold uppercase text-muted">
                      {pluralType(t, group.type)}
                    </h4>
                    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                      {group.resources.map((resource) => (
                        <ResourceRow
                          key={resource.id}
                          resource={resource}
                          record={record}
                          mode={mode}
                          disabled={disabled}
                          onPreference={(target, preference) =>
                            onResourcePreference(item, target, preference)
                          }
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
