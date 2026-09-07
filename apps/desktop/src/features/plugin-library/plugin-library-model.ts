import type {
  ModelSummary,
  PackageRecord,
  PackageSnapshot,
  PluginLibraryCatalog,
  PluginLibraryConfigItem,
  PluginLibraryEntry,
  ResourceRecord,
} from "@piabyss/protocol";

/**
 * Pure derivation for the plugin-library view: from the curated registry
 * entry plus the current package snapshot, decide the card's status and
 * which resources belong to the plugin.
 *
 * - npm/git plugins are whole packages: installed iff the package is
 *   configured, enabled iff all of its extension resources are enabled.
 * - repo plugins live inside the registry repository package: the entry's
 *   resources are identified by path, and the card mirrors their state.
 */

type PluginCardStatus = "not-installed" | "disabled" | "enabled";

export type PluginCardState = {
  status: PluginCardStatus;
  packageRecord?: PackageRecord;
  /** Extension resources backing this plugin (empty when not installed). */
  extensionResources: ResourceRecord[];
};

/** Normalize an npm/git install source like pi's package identity rules do,
 *  so "npm:pkg@1.0", "git:github.com/a/b" and "https://github.com/a/b" all
 *  match the same configured package record. */
export function normalizeInstallIdentity(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4);
    const match = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
    return `npm:${match?.[1] ?? spec}`;
  }
  if (trimmed.startsWith("git:")) {
    const rest = trimmed.slice(4).trim().replace(/#.*$/, "");
    let host: string | undefined;
    let path: string | undefined;
    const scp = rest.match(/^(?:git@)?([^/:]+):(.+)$/);
    if (scp && (rest.startsWith("git@") || scp[1].includes("."))) {
      host = scp[1];
      path = scp[2];
    } else {
      const shorthand = rest.match(/^([^/]+)\/(.+)$/);
      if (shorthand) {
        const alias = shorthand[1].toLowerCase();
        if (alias === "github" || alias === "gitlab" || alias === "bitbucket") {
          host = `${alias}.com`;
          path = shorthand[2];
        } else if (alias.includes(".")) {
          host = alias;
          path = shorthand[2];
        } else if (!alias.includes(":")) {
          // pi treats git:owner/repo as the historical GitHub shorthand.
          host = "github.com";
          path = `${shorthand[1]}/${shorthand[2]}`;
        }
      }
      const aliasMatch = rest.match(/^(github|gitlab|bitbucket):(.+)$/i);
      if (!host && aliasMatch) {
        host = `${aliasMatch[1].toLowerCase()}.com`;
        path = aliasMatch[2];
      }
      if (!host) {
        try {
          const url = new URL(rest);
          if (["git:", "ssh:", "http:", "https:"].includes(url.protocol)) {
            host = url.hostname;
            path = url.pathname;
          }
        } catch {
          // not a URL-shaped source
        }
      }
    }
    if (host && path != null) {
      const cleanPath = path
        .replace(/^\//, "")
        .replace(/#.*$/, "")
        .replace(/@[^/]+$/, "")
        .replace(/\.git$/, "");
      return `git:${host.toLowerCase()}/${cleanPath}`;
    }
    return `git:${rest}`;
  }
  try {
    const url = new URL(trimmed);
    if (["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
      const path = url.pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "")
        .replace(/@[^/]+$/, "");
      return `git:${url.hostname.toLowerCase()}/${path}`;
    }
  } catch {
    // fall through
  }
  return trimmed;
}

/** Extension glob that selects exactly this repo plugin (pi settings object
 *  form), e.g. "packages/pi-web/extensions/**". */
export function repoExtensionPattern(path: string): string {
  return `${path.replace(/\\/g, "/").replace(/\/+$/, "")}/extensions/**`;
}

/* ------------------------------------------------------------ */
/* Dynamic config options: pi:vision-models / pi:models         */
/* ------------------------------------------------------------ */

/** Well-known dynamic option source for select config items. Unknown sources
 *  must be rendered like a regular static select / text input.
 *
 *  Single-select sources (one runtime model):
 *    - `pi:vision-models` — vision-capable models only
 *    - `pi:models`        — every configured model
 *  Ordered fallback-list sources (one row per fallback entry):
 *    - `pi:vision-models-fallback` — vision-capable models only
 *    - `pi:models-fallback`        — every configured model
 */
export const OPTIONS_SOURCE_VISION_MODELS = "pi:vision-models";
export const OPTIONS_SOURCE_MODELS = "pi:models";
export const OPTIONS_SOURCE_VISION_FALLBACK_MODELS = "pi:vision-models-fallback";
export const OPTIONS_SOURCE_MODELS_FALLBACK = "pi:models-fallback";

/** Env names that store an ordered fallback model list. Catalogs that still
 *  declare the item as a plain text input are recognized by env name so the
 *  list UI keeps working before the registry migrates to `optionsSource`. */
const FALLBACK_LIST_ENVS = new Set(["PI_VISION_FALLBACK_MODELS", "SUBAGENT_FALLBACK_MODELS"]);

/** Which runtime model list a config item needs. */
export type ModelOptionsKind = "vision" | "all";

export function isVisionCapable(model: ModelSummary): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

/** Select option for a model: the persisted value keeps the provider/modelId
 *  form (it becomes the plugin's env var), the label shows the human-readable
 *  provider and model names. */
export function modelOption(model: ModelSummary): { value: string; label: string } {
  return {
    value: `${model.provider}/${model.modelId}`,
    label: `${model.providerName ?? model.provider} · ${model.name ?? model.modelId}`,
  };
}

/** True when this config item wants a runtime-generated model single-select. */
export function wantsModelOptions(item: PluginLibraryConfigItem): boolean {
  return (
    item.type === "select" &&
    (item.optionsSource === OPTIONS_SOURCE_VISION_MODELS ||
      item.optionsSource === OPTIONS_SOURCE_MODELS)
  );
}

/** True when this item stores an ordered, comma-separated fallback model list. */
export function wantsModelListOptions(item: PluginLibraryConfigItem): boolean {
  return (
    (item.type === "select" &&
      (item.optionsSource === OPTIONS_SOURCE_VISION_FALLBACK_MODELS ||
        item.optionsSource === OPTIONS_SOURCE_MODELS_FALLBACK)) ||
    FALLBACK_LIST_ENVS.has(item.env)
  );
}

/** Which runtime model list this config item needs: "vision" filters to
 *  image-capable models, "all" uses every configured model. */
export function modelOptionsKind(item: PluginLibraryConfigItem): ModelOptionsKind {
  if (
    item.optionsSource === OPTIONS_SOURCE_MODELS ||
    item.optionsSource === OPTIONS_SOURCE_MODELS_FALLBACK ||
    // Legacy catalogs declare the subagent fallback list as a plain text
    // input; its env name still means the full model list.
    item.env === "SUBAGENT_FALLBACK_MODELS"
  ) {
    return "all";
  }
  return "vision";
}

/** Posix-normalized absolute path used for substring matching. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function sourceMatches(record: PackageRecord, source: string): boolean {
  return (
    record.source === source ||
    record.identity === source ||
    record.identity === normalizeInstallIdentity(source)
  );
}

function repoPluginResources(
  packages: PackageSnapshot,
  pkg: PackageRecord,
  repoPath: string,
): ResourceRecord[] {
  const marker = `/${normalizePath(repoPath).replace(/\/+$/, "")}/`;
  return packages.resources.filter(
    (resource) => resource.packageId === pkg.id && normalizePath(resource.path).includes(marker),
  );
}

export function pluginCardState(
  entry: PluginLibraryEntry,
  catalog: PluginLibraryCatalog,
  packages: PackageSnapshot | null,
): PluginCardState {
  if (!packages) return { status: "not-installed", extensionResources: [] };

  const install = entry.install;
  if (install.type === "repo") {
    const repoPkg = packages.configured.find((record) => sourceMatches(record, catalog.repoSource));
    if (!repoPkg) return { status: "not-installed", extensionResources: [] };
    const owned = repoPluginResources(packages, repoPkg, install.path);
    const extensions = owned.filter((resource) => resource.type === "extension");
    if (extensions.length === 0) {
      return { status: "not-installed", packageRecord: repoPkg, extensionResources: [] };
    }
    return {
      status: extensions.some((resource) => resource.enabled) ? "enabled" : "disabled",
      packageRecord: repoPkg,
      extensionResources: extensions,
    };
  }
  // install is npm/git here.

  const pkg = packages.configured.find((record) => sourceMatches(record, install.source));
  if (!pkg) return { status: "not-installed", extensionResources: [] };
  const extensions = packages.resources.filter(
    (resource) => resource.packageId === pkg.id && resource.type === "extension",
  );
  // A package without extension resources (skills-only etc.) is "enabled" as
  // long as it is installed; there is nothing to toggle.
  return {
    status: extensions.every((resource) => resource.enabled) ? "enabled" : "disabled",
    packageRecord: pkg,
    extensionResources: extensions,
  };
}

/** Initial form values for a config schema: stored value wins over default. */
export function initialConfigValues(
  entry: PluginLibraryEntry,
  pluginEnv: Record<string, Record<string, string>> | undefined,
): Record<string, string> {
  const stored = pluginEnv?.[entry.id] ?? {};
  const values: Record<string, string> = {};
  for (const item of entry.config ?? []) {
    values[item.env] = stored[item.env] ?? item.default ?? "";
  }
  return values;
}

/** Build the pluginEnv map to persist: drop empty values; drop plugins that
 *  end up with no values at all. */
export function buildPluginEnvPatch(
  pluginEnv: Record<string, Record<string, string>> | undefined,
  pluginId: string,
  values: Record<string, string>,
): Record<string, Record<string, string>> {
  const next: Record<string, Record<string, string>> = { ...(pluginEnv ?? {}) };
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value.length > 0) cleaned[name] = value;
  }
  if (Object.keys(cleaned).length > 0) {
    next[pluginId] = cleaned;
  } else {
    delete next[pluginId];
  }
  return next;
}

/** Human-usable listing of missing required config fields. */
export function missingRequiredConfig(
  entry: PluginLibraryEntry,
  values: Record<string, string>,
): Array<{ label: string }> {
  return (entry.config ?? [])
    .filter((item) => item.required === true && !(values[item.env] ?? "").trim())
    .map((item) => ({ label: item.label }));
}
