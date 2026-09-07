import type { AgentSession, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { detectModelThinking } from "@piabyss/protocol";
import { readModelsConfig } from "./provider-models-config.js";

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
 */
export async function applyKnownThinkingProfiles(
  modelRegistry: ModelRegistry,
  modelRuntime?: ModelRuntime,
  modelsPath?: string,
): Promise<number> {
  let applied = 0;
  const providerIds = new Set<string>(modelRegistry.getRegisteredProviderIds());
  if (modelsPath) {
    try {
      const config = await readModelsConfig(modelsPath);
      for (const providerId of Object.keys(config.providers)) providerIds.add(providerId);
    } catch {
      // Unreadable models.json: fall back to registered providers only.
    }
  }

  for (const providerId of providerIds) {
    const config = modelRegistry.getRegisteredProviderConfig(providerId);
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
