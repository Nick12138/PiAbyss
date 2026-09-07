import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type JsonObject = Record<string, unknown>;
export type ModelsConfig = {
  root: JsonObject;
  providers: JsonObject;
  original: string | null;
};

export const ENABLED_PROVIDERS_KEY = "piabyssEnabledProviders";
export const LEGACY_ACTIVE_PROVIDER_KEY = "piabyssActiveProvider";
// Per-builtin-provider model allow-lists: { providerId: modelId[] }. A missing
// entry means every model of that provider is offered.
export const PROVIDER_MODELS_KEY = "piabyssProviderModels";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readModelsConfig(path: string): Promise<ModelsConfig> {
  let original: string | null = null;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (original === null || !original.trim()) {
    const providers: JsonObject = {};
    return { root: { providers }, providers, original };
  }
  const parsed = JSON.parse(original) as unknown;
  if (!isObject(parsed)) throw new Error("models.json root must be an object");
  const providers = parsed.providers;
  if (providers === undefined) {
    const next: JsonObject = {};
    parsed.providers = next;
    return { root: parsed, providers: next, original };
  }
  if (!isObject(providers)) throw new Error("models.json providers must be an object");
  return { root: parsed, providers, original };
}

export function resolveEnabledProviders(
  config: ModelsConfig,
  preferredProvider?: string,
  extraProviderIds: readonly string[] = [],
): string[] {
  const customIds = Object.entries(config.providers)
    .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
    .map(([id]) => id);
  // Builtin (SDK) providers become enableable after a login, so the id
  // universe is custom providers plus whatever the runtime composes.
  const knownIds = new Set([...customIds, ...extraProviderIds]);
  if (knownIds.size === 0) return [];
  const configured = config.root[ENABLED_PROVIDERS_KEY];
  if (Array.isArray(configured)) {
    return [
      ...new Set(
        configured.filter((id): id is string => typeof id === "string" && knownIds.has(id)),
      ),
    ];
  }
  const legacyActive = config.root[LEGACY_ACTIVE_PROVIDER_KEY];
  if (typeof legacyActive === "string" && customIds.includes(legacyActive)) {
    return [legacyActive];
  }
  if (preferredProvider && knownIds.has(preferredProvider)) return [preferredProvider];
  const fallback =
    customIds.find((id) => {
      const provider = config.providers[id];
      return isObject(provider) && Array.isArray(provider.models) && provider.models.length > 0;
    }) ?? customIds[0];
  return fallback ? [fallback] : [];
}

export async function getEnabledProviderIds(
  agentDir: string,
  preferredProvider?: string,
  knownProviderIds: readonly string[] = [],
): Promise<string[] | undefined> {
  try {
    const config = await readModelsConfig(join(agentDir, "models.json"));
    const hasCustomProviders = Object.values(config.providers).some(isObject);
    const hasConfiguredList = Array.isArray(config.root[ENABLED_PROVIDERS_KEY]);
    if (!hasCustomProviders && !hasConfiguredList) return undefined;
    return resolveEnabledProviders(config, preferredProvider, knownProviderIds);
  } catch {
    return undefined;
  }
}

export function readProviderModelAllowLists(config: ModelsConfig): Record<string, string[]> {
  const raw = config.root[PROVIDER_MODELS_KEY];
  if (!isObject(raw)) return {};
  const lists: Record<string, string[]> = {};
  for (const [providerId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    lists[providerId] = [...new Set(value.filter((id): id is string => typeof id === "string"))];
  }
  return lists;
}

export async function getProviderModelAllowLists(
  agentDir: string,
): Promise<Record<string, string[]> | undefined> {
  try {
    const config = await readModelsConfig(join(agentDir, "models.json"));
    const lists = readProviderModelAllowLists(config);
    return Object.keys(lists).length > 0 ? lists : undefined;
  } catch {
    return undefined;
  }
}
