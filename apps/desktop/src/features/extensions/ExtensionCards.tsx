import { useState } from "react";
import { AlertTriangle, Boxes, Download, Settings2, Tag } from "lucide-react";
import { Switch } from "../../components/Switch";
import { primaryButton } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import type { Translate } from "../../lib/i18n/use-t";
import type { ResourceType } from "@piabyss/protocol";
import { PACKAGE_RESOURCE_TYPES } from "../packages/packages-model";
import type { LibraryItem, LibraryScope } from "./extensions-model";

// One hue per kind so the badges never read as the same thing: plugin (violet)
// / extension (accent) / skill (green) / prompt (amber) / theme (blue).
const TYPE_BADGE_CLASS: Record<ResourceType, string> = {
  extension: "bg-accent/15 text-accent",
  skill: "bg-success/15 text-success",
  prompt: "bg-warning/15 text-warning",
  theme: "bg-theme/15 text-theme",
};

function singularType(t: Translate, type: ResourceType): string {
  return type === "extension"
    ? t("typeExtension")
    : type === "skill"
      ? t("typeSkill")
      : type === "prompt"
        ? t("typePrompt")
        : t("typeTheme");
}

function isResourceType(type: string): type is ResourceType {
  return (PACKAGE_RESOURCE_TYPES as readonly string[]).includes(type);
}

/** Kind badge: "plugin" for registry entries, the resource type otherwise. */
export function TypeBadge({ type }: { type: string }) {
  const t = useT();
  if (type === "plugin") {
    return (
      <span className="shrink-0 whitespace-nowrap rounded bg-plugin/15 px-1 py-px text-[11px] font-medium text-plugin">
        {t("extensionsTypePlugin")}
      </span>
    );
  }
  if (!isResourceType(type)) {
    return (
      <span className="shrink-0 whitespace-nowrap rounded bg-surface-overlay px-1 py-px text-[11px] font-medium text-muted">
        {type}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded px-1 py-px text-[11px] font-medium ${TYPE_BADGE_CLASS[type]}`}
    >
      {singularType(t, type)}
    </span>
  );
}

/** Primary badge type for an item: plugins say "plugin", packages say what
 ** they actually provide (first resource kind they carry). */
export function itemBadgeType(item: LibraryItem): string {
  if (item.kind === "plugin") return "plugin";
  return item.resourceTypes[0] ?? "package";
}

function ItemIcon({ item }: { item: LibraryItem }) {
  if (item.kind === "package") {
    return (
      <span
        aria-hidden
        className="flex size-8 shrink-0 select-none items-center justify-center rounded-md bg-surface-overlay text-muted"
      >
        <Boxes size={16} />
      </span>
    );
  }
  const icon = item.icon ?? "";
  // Emoji icons render inline; image paths are not fetched (WebView CSP blocks
  // remote images), so anything else falls back to the first letter.
  const isEmoji = /\p{Extended_Pictographic}/u.test(icon);
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 select-none items-center justify-center rounded-md bg-surface-overlay text-base"
    >
      {isEmoji ? icon : item.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ExtensionCard({
  item,
  scope,
  pending,
  installBlockedTitle,
  onOpen,
  onInstall,
  onToggle,
  onConfigure,
}: {
  item: LibraryItem;
  scope: LibraryScope;
  /** True while this card's install/toggle mutation is in flight. Other cards
   *  stay interactive — only this card's controls are locked. */
  pending: boolean;
  /** Set when the install button renders disabled (scope / repo-only plugin). */
  installBlockedTitle?: string;
  /** `opener` is the element focus returns to when the drawer closes. */
  onOpen: (item: LibraryItem, opener: HTMLElement | null) => void;
  onInstall: (item: LibraryItem) => void;
  /** Applies the toggle in the background. Resolves true on success. */
  onToggle: (item: LibraryItem, enable: boolean) => Promise<boolean>;
  onConfigure: (item: LibraryItem) => void;
}) {
  const t = useT();
  // Optimistic toggle: the switch flips immediately, the mutation runs in the
  // background, and the authoritative snapshot clears the override. A failed
  // mutation reverts the override instead.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const installed = item.installed;
  const enabled = optimistic ?? item.enabled;
  const globalScope = scope.kind === "global";
  const workspaceScope = !globalScope;
  // Global-only plugins (registry `toggleScopes: ["user"]`) cannot be toggled
  // from a workspace: the switch becomes a read-only readout instead.
  const globalOnlyCard = workspaceScope && item.kind === "plugin" && item.globalOnly;
  const globalOnlyHint = item.hasProjectOverride
    ? t("pluginsScopeGlobalOnlyOverrideHint")
    : t("pluginsScopeGlobalOnlyHint");
  const showConfig = installed && item.kind === "plugin" && item.hasConfig && globalScope;
  const showConfigPlaceholder =
    installed && item.kind === "plugin" && item.hasConfig && !globalScope;

  async function handleToggle(next: boolean) {
    if (pending) return;
    setOptimistic(next);
    const ok = await onToggle(item, next);
    if (!ok) setOptimistic(null);
  }

  return (
    <article
      data-extension-card={item.id}
      data-plugin-card={item.kind === "plugin" ? item.id : undefined}
      data-package-card={item.kind === "package" ? item.id : undefined}
      className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-muted/45"
      onClick={(event) => onOpen(item, event.currentTarget)}
    >
      <div className="flex items-start gap-2">
        <ItemIcon item={item} />
        <div className="min-w-0 flex-1">
          {/* Title row: name + kind badge. The row is content-sized (`w-fit`)
           ** and capped at the card width, so the badge always sits flush against
           ** the name: short names are not padded out by a min-width floor (that
           ** used to leave a gap that varied with name length) and long names
           ** truncate instead of pushing the badge away or collapsing to zero. */}
          <div className="flex w-fit max-w-full min-w-0 items-baseline gap-1.5">
            <button
              type="button"
              title={item.name}
              className="min-w-0 truncate text-left text-[13px] font-semibold"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(item, event.currentTarget);
              }}
            >
              {item.name}
            </button>
            <TypeBadge type={itemBadgeType(item)} />
          </div>
          {/* Compact, left-aligned meta run: author · version. No flex-1 on the
           ** author — stretching it pushed the version to the far edge and left
           ** a hole in the middle of the line. */}
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
            <span className="min-w-0 truncate">
              {item.author ?? item.record?.source ?? item.id}
            </span>
            {item.version && (
              <span
                title={item.kind === "plugin" ? `v${item.version}` : item.version}
                className="max-w-[55%] shrink-0 truncate tabular-nums"
              >
                · {item.kind === "plugin" ? `v${item.version}` : item.version}
              </span>
            )}
          </p>
        </div>
        {installed ? (
          <div className="flex shrink-0 items-center gap-3">
            {workspaceScope && item.kind === "package" && (
              <span
                title={t("extensionsPackageGlobalHint")}
                className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-muted"
              >
                {t("extensionsPackageGlobalBadge")}
              </span>
            )}
            {showConfig && (
              <button
                type="button"
                data-plugin-config-button
                className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                title={t("pluginsConfigOpen")}
                aria-label={t("pluginsConfigOpen")}
                disabled={pending}
                onClick={(event) => {
                  event.stopPropagation();
                  onConfigure(item);
                }}
              >
                <Settings2 size={14} />
              </button>
            )}
            {showConfigPlaceholder && (
              <span data-plugin-config-placeholder className="size-7 shrink-0" aria-hidden="true" />
            )}
            {globalOnlyCard ? (
              <span
                data-plugin-global-only={item.id}
                title={globalOnlyHint}
                className="flex shrink-0 items-center gap-1.5"
              >
                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-muted">
                  {t("pluginsScopeGlobalOnly")}
                </span>
                {item.hasProjectOverride && (
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
              <span onClick={(event) => event.stopPropagation()}>
                <Switch
                  checked={enabled}
                  disabled={pending || !item.toggleable}
                  label={t("pluginStatusEnabled")}
                  onChange={(next) => void handleToggle(next)}
                />
              </span>
            )}
          </div>
        ) : (
          /* Not installed: the install action sits where the switch lives on an
           ** installed card, instead of taking a whole row of its own at the
           ** bottom (which left uninstalled cards taller than installed ones). */
          <button
            type="button"
            data-extension-install-button
            className={`${primaryButton} shrink-0`}
            disabled={pending || installBlockedTitle !== undefined}
            title={installBlockedTitle}
            onClick={(event) => {
              event.stopPropagation();
              onInstall(item);
            }}
          >
            <Download size={13} />
            {t("packagesInstallAction")}
          </button>
        )}
      </div>

      {item.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
          <Tag size={11} className="shrink-0" />
          {item.tags.map((tag) => (
            <span key={tag} className="rounded bg-surface-overlay px-1.5 py-0.5">
              {tag}
            </span>
          ))}
        </div>
      )}

      <p className="line-clamp-2 text-xs leading-5 text-muted" title={item.description}>
        {item.description}
      </p>
    </article>
  );
}
