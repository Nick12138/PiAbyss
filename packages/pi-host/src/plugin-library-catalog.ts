import {
  createHostError,
  type HostError,
  type PluginLibraryCatalog,
  type PluginLibraryEntry,
} from "@piabyss/protocol";

/**
 * PiAbyss's curated plugin library is data-driven: the registry repository
 * (github.com/Nick12138/my-pi-plugins) publishes a machine-readable
 * `plugins.json` at its root, and this module fetches, validates, and caches
 * it. The renderer cannot fetch it itself — the WebView CSP only allows
 * `connect-src 'self' ipc:` — so catalog traffic goes through the Host like
 * the pi.dev package catalog does.
 */
export const PLUGIN_LIBRARY_REGISTRY_URL =
  "https://raw.githubusercontent.com/Nick12138/my-pi-plugins/main/plugins.json";
export const PLUGIN_LIBRARY_REPO_SOURCE = "git:github.com/Nick12138/my-pi-plugins";

const CATALOG_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REGISTRY_BYTES = 512 * 1024;

type CatalogFetcher = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let cache: { atMs: number; catalog: PluginLibraryCatalog } | null = null;

/** Test hook. */
export function resetPluginLibraryCatalogCache(): void {
  cache = null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function sanitizeInstall(value: unknown): PluginLibraryEntry["install"] | null {
  if (!isObject(value)) return null;
  if (value.type === "repo" && isString(value.path) && isSafeRepoPath(value.path)) {
    return { type: "repo", path: value.path };
  }
  if ((value.type === "npm" || value.type === "git") && isString(value.source)) {
    return { type: value.type, source: value.source };
  }
  return null;
}

/** Repo paths must stay inside the registry repository. */
function isSafeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 256 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("..") &&
    !path.includes("\0")
  );
}

function sanitizeConfigItem(
  value: unknown,
): PluginLibraryEntry["config"] extends (infer T)[] | undefined ? T | null : never {
  if (!isObject(value)) return null;
  if (!isString(value.key) || value.key.length === 0) return null;
  if (value.type !== "text" && value.type !== "select") return null;
  if (!isString(value.label) || !isString(value.env) || value.env.length === 0) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)) return null;
  if (value.secret !== undefined && typeof value.secret !== "boolean") return null;
  if (value.required !== undefined && typeof value.required !== "boolean") return null;
  if (!optionalString(value.placeholder) || !optionalString(value.description)) return null;
  if (!optionalString(value.default)) return null;
  if (!optionalString(value.optionsSource)) return null;
  const item: NonNullable<PluginLibraryEntry["config"]>[number] = {
    key: value.key,
    type: value.type,
    label: value.label,
    env: value.env,
    ...(value.secret !== undefined ? { secret: value.secret as boolean } : {}),
    ...(value.required !== undefined ? { required: value.required as boolean } : {}),
    ...(isString(value.placeholder) ? { placeholder: value.placeholder } : {}),
    ...(isString(value.description) ? { description: value.description } : {}),
    ...(isString(value.default) ? { default: value.default } : {}),
    ...(isString(value.optionsSource) ? { optionsSource: value.optionsSource } : {}),
  };
  if (value.type === "select") {
    if (value.options !== undefined && !Array.isArray(value.options)) return null;
    const options = Array.isArray(value.options)
      ? value.options.filter(
          (option): option is { value: string; label: string } =>
            isObject(option) && isString(option.value) && isString(option.label),
        )
      : [];
    if (options.length > 0) item.options = options;
    // Without a dynamic optionsSource, a select must carry static options;
    // with one, options may be missing or empty and are built at runtime.
    if (!item.options && !isString(value.optionsSource)) return null;
  }
  return item;
}

function sanitizeEntry(value: unknown): PluginLibraryEntry | null {
  if (!isObject(value)) return null;
  if (!isString(value.id) || !/^[a-z0-9][a-z0-9-]*$/.test(value.id)) return null;
  if (!isString(value.name) || !isString(value.description)) return null;
  if (!isString(value.icon) || !isString(value.version)) return null;
  const install = sanitizeInstall(value.install);
  if (!install) return null;
  const entry: PluginLibraryEntry = {
    id: value.id,
    name: value.name,
    description: value.description,
    icon: value.icon,
    version: value.version,
    install,
  };
  if (isString(value.author)) entry.author = value.author;
  if (Array.isArray(value.tags)) {
    entry.tags = value.tags.filter((tag): tag is string => isString(tag));
  }
  if (value.config !== undefined) {
    if (!Array.isArray(value.config)) return null;
    const config = value.config
      .map(sanitizeConfigItem)
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (config.length !== value.config.length) return null;
    if (config.length > 0) entry.config = config;
  }
  return entry;
}

export type PluginLibraryCatalogOutcome = { catalog: PluginLibraryCatalog } | { error: HostError };

export async function getPluginLibraryCatalog(
  args: {
    refresh?: boolean;
    fetchImpl?: CatalogFetcher;
    nowMs?: number;
  } = {},
): Promise<PluginLibraryCatalogOutcome> {
  const nowMs = args.nowMs ?? Date.now();
  if (!args.refresh && cache && nowMs - cache.atMs < CATALOG_TTL_MS) {
    return { catalog: cache.catalog };
  }
  const fetchImpl: CatalogFetcher = args.fetchImpl ?? fetch;
  const registryUrl = args.refresh
    ? `${PLUGIN_LIBRARY_REGISTRY_URL}?_piabyss_refresh=${encodeURIComponent(String(nowMs))}`
    : PLUGIN_LIBRARY_REGISTRY_URL;
  let text: string;
  try {
    const response = await fetchImpl(registryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...(args.refresh ? { "cache-control": "no-cache" } : {}),
      },
    });
    if (!response.ok) {
      return {
        error: createHostError(
          "CATALOG_UNAVAILABLE",
          `Plugin registry request failed with HTTP ${response.status}`,
          { retryable: true },
        ),
      };
    }
    text = await response.text();
  } catch (error) {
    return {
      error: createHostError(
        "CATALOG_UNAVAILABLE",
        error instanceof Error ? error.message : "Plugin registry request failed",
        { retryable: true },
      ),
    };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REGISTRY_BYTES) {
    return {
      error: createHostError("CATALOG_UNAVAILABLE", "Plugin registry file is too large", {
        retryable: true,
      }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      error: createHostError("CATALOG_UNAVAILABLE", "Plugin registry is not valid JSON", {
        retryable: true,
      }),
    };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.plugins)) {
    return {
      error: createHostError(
        "CATALOG_UNAVAILABLE",
        "Plugin registry does not match the plugins.json spec",
      ),
    };
  }
  const plugins: PluginLibraryEntry[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  for (const raw of parsed.plugins) {
    const entry = sanitizeEntry(raw);
    if (!entry) {
      const label = isObject(raw) && isString(raw.id) ? raw.id : "<unknown>";
      warnings.push(`Dropped invalid registry entry "${label}"`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      warnings.push(`Dropped duplicate registry entry "${entry.id}"`);
      continue;
    }
    seenIds.add(entry.id);
    plugins.push(entry);
  }
  const catalog: PluginLibraryCatalog = {
    specVersion: typeof parsed.specVersion === "number" ? parsed.specVersion : 0,
    registryUrl: PLUGIN_LIBRARY_REGISTRY_URL,
    repoSource: PLUGIN_LIBRARY_REPO_SOURCE,
    fetchedAt: nowMs,
    plugins,
    warnings,
  };
  cache = { atMs: nowMs, catalog };
  return { catalog };
}
