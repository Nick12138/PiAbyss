import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Github,
  RefreshCw,
  Search,
} from "lucide-react";
import { primaryButton, secondaryButton } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { useT } from "../../lib/i18n/use-t";
import type { Translate } from "../../lib/i18n/use-t";
import type { PackageCatalog, PackageCatalogItem, PackageRecord } from "@piabyss/protocol";
import {
  PACKAGE_RESOURCE_TYPES,
  catalogPageRange,
  formatCatalogPublishedAt,
  formatDownloadsPerMonth,
  isCatalogItemInstalled,
  type CatalogSort,
  type ResourceTypeFilter,
} from "../packages/packages-model";
import { TypeBadge } from "./ExtensionCards";

const inputClass =
  "box-border interface-density-control h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted focus:border-focus";

function singularType(t: Translate, type: string): string {
  return type === "extension"
    ? t("typeExtension")
    : type === "skill"
      ? t("typeSkill")
      : type === "prompt"
        ? t("typePrompt")
        : t("typeTheme");
}

function MarketPackageCard({
  item,
  installed,
  locale,
  t,
  mutationBlocked,
  onOpen,
  onInstall,
}: {
  item: PackageCatalogItem;
  installed: boolean;
  locale: "en" | "zh";
  t: Translate;
  mutationBlocked: boolean;
  onOpen: (url: string) => void;
  onInstall: (item: PackageCatalogItem) => void;
}) {
  const installHint = t("packagesMarketInstallHint");
  return (
    <article
      data-market-card={item.name}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-[13px] font-semibold">
          <button
            type="button"
            className="min-w-0 truncate text-left hover:underline"
            title={t("packagesMarketOpenPage", { name: item.name })}
            aria-label={t("packagesMarketOpenPage", { name: item.name })}
            onClick={() => onOpen(item.pageUrl)}
          >
            {item.name}
          </button>
        </h3>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {item.types.map((type) => (
            <TypeBadge key={type} type={type} />
          ))}
        </div>
      </div>
      <p className="line-clamp-2 min-h-10 text-xs leading-5 text-muted" title={item.description}>
        {item.description}
      </p>
      <div className="mt-auto flex items-center gap-2 text-[11px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {item.author && (
            <span className="min-w-0 truncate" title={item.author}>
              {item.author}
            </span>
          )}
          {item.downloadsPerMonth !== undefined && (
            <span className="shrink-0 tabular-nums">
              {t("packagesMarketDownloads", {
                count: formatDownloadsPerMonth(item.downloadsPerMonth),
              })}
            </span>
          )}
          {item.publishedAt !== undefined && (
            <span
              className="shrink-0 tabular-nums"
              title={t("packagesMarketPublished", {
                date: formatCatalogPublishedAt(item.publishedAt, locale),
              })}
            >
              {formatCatalogPublishedAt(item.publishedAt, locale)}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {item.githubUrl && (
            <button
              type="button"
              className="text-muted hover:text-foreground"
              title={t("packagesMarketOpenGithub", { name: item.name })}
              aria-label={t("packagesMarketOpenGithub", { name: item.name })}
              onClick={() => onOpen(item.githubUrl!)}
            >
              <Github size={12} />
            </button>
          )}
          {item.npmUrl && (
            <button
              type="button"
              className="text-muted hover:text-foreground"
              title={t("packagesMarketOpenNpm", { name: item.name })}
              aria-label={t("packagesMarketOpenNpm", { name: item.name })}
              onClick={() => onOpen(item.npmUrl!)}
            >
              <ExternalLink size={12} />
            </button>
          )}
          {installed ? (
            <span className="inline-flex items-center gap-1 text-success">
              <Check size={12} />
              {t("packagesMarketInstalled")}
            </span>
          ) : (
            <button
              type="button"
              className={primaryButton}
              title={installHint}
              disabled={mutationBlocked}
              onClick={() => onInstall(item)}
            >
              <Download size={13} />
              {t("packagesInstallAction")}
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

export type MarketViewState = {
  catalog: PackageCatalog | null;
  state: "idle" | "loading" | "ready" | "error";
  error: string;
  query: string;
  type: ResourceTypeFilter;
  sort: CatalogSort;
};

export function ExtensionMarket({
  view,
  allPackages,
  locale,
  mutationBlocked,
  onQuery,
  onType,
  onSort,
  onRefresh,
  onPage,
  onOpen,
  onInstall,
  onOpenSite,
}: {
  view: MarketViewState;
  allPackages: PackageRecord[];
  locale: "en" | "zh";
  mutationBlocked: boolean;
  onQuery: (query: string) => void;
  onType: (type: ResourceTypeFilter) => void;
  onSort: (sort: CatalogSort) => void;
  onRefresh: () => void;
  onPage: (page: number) => void;
  onOpen: (url: string) => void;
  onInstall: (item: PackageCatalogItem) => void;
  onOpenSite: () => void;
}) {
  const t = useT();
  const catalog = view.catalog;
  const range = catalog ? catalogPageRange(catalog) : null;
  const items = catalog?.items ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-3">
        <label className="relative w-56">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            className={`${inputClass} w-full pl-7`}
            aria-label={t("packagesMarketSearchAria")}
            placeholder={t("packagesMarketSearchPlaceholder")}
            value={view.query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <Select
          className="h-8"
          ariaLabel={t("packagesMarketTypeAria")}
          value={view.type}
          onChange={(next) => onType(next as ResourceTypeFilter)}
          options={[
            { value: "all", label: t("packagesMarketTypeAll") },
            ...PACKAGE_RESOURCE_TYPES.map((type) => ({
              value: type,
              label: singularType(t, type),
            })),
          ]}
        />
        <Select
          className="h-8"
          ariaLabel={t("packagesMarketSortAria")}
          value={view.sort}
          onChange={(next) => onSort(next as CatalogSort)}
          options={[
            { value: "downloads", label: t("packagesMarketSortDownloads") },
            { value: "recent", label: t("packagesMarketSortRecent") },
          ]}
        />
        <button
          type="button"
          className={secondaryButton}
          title={t("packagesMarketRefresh")}
          aria-label={t("packagesMarketRefresh")}
          disabled={view.state === "loading"}
          onClick={onRefresh}
        >
          <RefreshCw size={13} className={view.state === "loading" ? "animate-spin" : ""} />
        </button>
        {catalog && range && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
            <button
              type="button"
              className={secondaryButton}
              title={t("packagesMarketPrev")}
              aria-label={t("packagesMarketPrev")}
              disabled={view.state === "loading" || catalog.page <= 1}
              onClick={() => onPage(catalog.page - 1)}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="min-w-24 text-center tabular-nums">
              {t("packagesMarketRange", {
                start: range.start,
                end: range.end,
                total: catalog.total,
              })}
            </span>
            <button
              type="button"
              className={secondaryButton}
              title={t("packagesMarketNext")}
              aria-label={t("packagesMarketNext")}
              disabled={view.state === "loading" || catalog.page >= catalog.lastPage}
              onClick={() => onPage(catalog.page + 1)}
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>

      {view.state === "error" && !catalog ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle size={24} className="text-danger" />
          <div>
            <p className="text-sm font-medium">{t("packagesMarketError")}</p>
            <p className="mt-1 max-w-lg text-xs text-muted">{view.error}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={onRefresh}>
              <RefreshCw size={13} />
              {t("packagesTryAgain")}
            </button>
            <button type="button" className={secondaryButton} onClick={onOpenSite}>
              <ExternalLink size={13} />
              {t("packagesMarketOpenSite")}
            </button>
          </div>
        </div>
      ) : catalog === null ? (
        <p className="p-8 text-center text-sm text-muted">{t("packagesMarketLoading")}</p>
      ) : items.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted">{t("packagesMarketEmpty")}</p>
      ) : (
        <div
          className="scrollbar-subtle grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 @min-[30rem]:grid-cols-2 @min-[48rem]:grid-cols-3 @min-[70rem]:grid-cols-4 @min-[92rem]:grid-cols-5"
          data-settings-scroll
        >
          {items.map((item) => (
            <MarketPackageCard
              key={item.name}
              item={item}
              installed={isCatalogItemInstalled(item, allPackages)}
              locale={locale}
              t={t}
              mutationBlocked={mutationBlocked}
              onOpen={onOpen}
              onInstall={onInstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}
