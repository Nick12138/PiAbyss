import {
  ModelRuntime,
  type AgentSession,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { detectModelThinking } from "@piabyss/protocol";
import { isObject, readModelsConfig, type JsonObject } from "./provider-models-config.js";

type RegisteredProviderConfig = NonNullable<
  ReturnType<ModelRegistry["getRegisteredProviderConfig"]>
>;
type RegisteredModel = NonNullable<RegisteredProviderConfig["models"]>[number];
type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModels"]>>[number];

/**
 * OpenAI-compatible endpoints (sglang, vllm, Ollama, OpenRouter, …) commonly
 * accept only none/low/medium/high/max — not PiAbyss's extra minimal/xhigh
 * levels. Fold them so an unknown reasoning model never sends an unsupported
 * effort value (sglang rejects "minimal" with a 400). Applies to every
 * protocol that serializes a reasoning_effort string; anthropic/gemini/mistral
 * paths are untouched.
 */
const OPENAI_REASONING_FALLBACK_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "max",
} as const;

function applyToModel(model: RegisteredModel | RuntimeModel, providerApi?: string) {
  if (!model.reasoning || model.thinkingLevelMap !== undefined) return model;
  const detected = detectModelThinking(model.id);
  if (detected.source === "profile" && detected.thinkingLevelMap) {
    return { ...model, thinkingLevelMap: { ...detected.thinkingLevelMap } };
  }
  const api = model.api ?? providerApi;
  if (api === "openai-completions" || api === "openai-responses") {
    return { ...model, thinkingLevelMap: { ...OPENAI_REASONING_FALLBACK_MAP } };
  }
  return model;
}

/**
 * Provider overlays installed by this pass, tracked per registry. Only an
 * overlay this pass created may be wholesale-replaced or dropped on config
 * drift: a genuine extension registration for the same provider id keeps the
 * merge-only semantics it has always had.
 */
const thinkingOverlayOwnership = new WeakMap<ModelRegistry, Set<string>>();

function ownedThinkingOverlays(modelRegistry: ModelRegistry): Set<string> {
  let owned = thinkingOverlayOwnership.get(modelRegistry);
  if (!owned) {
    owned = new Set();
    thinkingOverlayOwnership.set(modelRegistry, owned);
  }
  return owned;
}

/** Key-order-insensitive JSON: overlay snapshots are compared by content, not identity. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isObject(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

/**
 * Compose models.json in isolation — WITHOUT the extension overlays of the
 * live runtime. In the SDK composer an extension `models` array REPLACES the
 * config's model list wholesale, and pinned model objects carry their own
 * absolute baseUrl; reading the live composition therefore feeds a previous
 * pass's snapshot back in and silently freezes every later models.json edit
 * (baseUrl, model list) until a Host restart. A throwaway runtime over the
 * same file is the faithful source of what the config alone composes to.
 * In-memory credentials and store keep the probe free of disk side effects,
 * and a wholesale load/parse failure yields null rather than an empty
 * composition that would read as "every provider vanished".
 */
async function composeConfigOnlyRuntime(modelsPath: string): Promise<ModelRuntime | null> {
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    });
    return runtime.getError() ? null : runtime;
  } catch {
    return null;
  }
}

/**
 * Apply exact built-in capability profiles and the OpenAI-compatible fallback
 * without overriding explicit user configuration.
 *
 * Under SDK 0.82.1 a composed provider rebuilds its model objects on every
 * access, so a mutation applied to a `getAll()` result is discarded — and
 * `find()` would hand the session a different instance without the map.
 * Re-registering routes the profile through the composer's override path,
 * where it survives recomposition and reaches the request layer that actually
 * reads `thinkingLevelMap`.
 *
 * Two provider sources are covered: providers registered through
 * `registerProvider` (extensions) and providers loaded from `models.json`
 * (the ones users actually configure). `modelsPath` lets the pass read the
 * on-disk config to target only user providers — iterating `runtime.getProviders()`
 * instead would also fold SDK built-in providers, which must stay untouched.
 *
 * Overlay maintenance for models.json providers: an overlay this pass
 * installed is re-derived from the config-only composition on every run —
 * re-registered when it drifted, dropped when the provider left the config —
 * so settings edits take effect on the very next refresh instead of only
 * after a Host restart.
 */
export async function applyKnownThinkingProfiles(
  modelRegistry: ModelRegistry,
  modelRuntime?: ModelRuntime,
  modelsPath?: string,
): Promise<number> {
  let applied = 0;
  const providerIds = new Set<string>(modelRegistry.getRegisteredProviderIds());
  let configProviderIds: Set<string> | null = null;
  if (modelsPath) {
    try {
      const config = await readModelsConfig(modelsPath);
      configProviderIds = new Set(
        Object.entries(config.providers)
          .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
          .map(([id]) => id),
      );
      for (const providerId of configProviderIds) providerIds.add(providerId);
    } catch {
      // Unreadable models.json: fall back to registered providers only, and
      // never interpret the read failure as providers being removed.
    }
  }

  const ownedOverlays = ownedThinkingOverlays(modelRegistry);
  let configOnlyRuntime: ModelRuntime | null | undefined;

  for (const providerId of providerIds) {
    const config = modelRegistry.getRegisteredProviderConfig(providerId);

    if (ownedOverlays.has(providerId)) {
      const inConfig = configProviderIds?.has(providerId) === true;
      if (!inConfig) {
        // Gone from models.json (or the file was never readable in this
        // process): without the drop, the overlay keeps the provider and its
        // stale model list alive as a ghost.
        if (configProviderIds) {
          ownedOverlays.delete(providerId);
          modelRegistry.unregisterProvider(providerId);
        }
        continue;
      }
      configOnlyRuntime ??= await composeConfigOnlyRuntime(modelsPath as string);
      // Poisoned config (parse/schema error): keep the previous overlay
      // rather than feeding an empty composition into removals.
      if (!configOnlyRuntime) continue;
      const basis = configOnlyRuntime.getModels(providerId);
      const nextModels = basis.map((model) => applyToModel(model));
      if (nextModels.length === 0) {
        // The config no longer composes any model for this provider: release
        // the overlay so the (possibly erroring) config composition surfaces.
        ownedOverlays.delete(providerId);
        modelRegistry.unregisterProvider(providerId);
        continue;
      }
      if (canonicalJson(config?.models) !== canonicalJson(nextModels)) {
        applied += basis.reduce(
          (count, model, index) => count + (nextModels[index] !== model ? 1 : 0),
          0,
        );
        modelRegistry.registerProvider(providerId, { models: nextModels });
      }
      continue;
    }

    const models = config?.models ?? modelRuntime?.getModels(providerId);
    if (!models || models.length === 0) continue;

    let changed = false;
    const nextModels = models.map((model) => {
      const next = applyToModel(model, config?.api);
      if (next !== model) {
        changed = true;
        applied += 1;
      }
      return next;
    });

    // Re-register only on change: registration recomposes the provider.
    if (changed) {
      modelRegistry.registerProvider(providerId, { ...(config ?? {}), models: nextModels });
      // Claim the overlay only when this pass created it: folding maps into a
      // genuine extension registration must not transfer the wholesale
      // replace/drop semantics (and its model list) to this pass.
      if (!config && configProviderIds?.has(providerId)) {
        ownedOverlays.add(providerId);
      }
    }
  }
  return applied;
}

/** Rebind a live session after ModelRegistry.refresh() without appending a model-change entry. */
export function rebindCurrentSessionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
): boolean {
  const current = session.model;
  if (!current) return false;
  const refreshed = modelRegistry.find(current.provider, current.id);
  if (!refreshed || refreshed === current) return false;
  session.state.model = refreshed;
  session.setThinkingLevel(session.thinkingLevel);
  return true;
}
