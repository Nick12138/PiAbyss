import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  THINKING_LEVELS,
  detectModelThinking,
  type DiscoveredProviderModel,
  type HostError,
  type ProviderDraft,
  type ProviderModelConfig,
  type ProviderSnapshot,
  type ThinkingLevelMap,
} from "@piabyss/protocol";
import type { Translate } from "../../lib/i18n/use-t";

export type ProviderDraftState = ProviderDraft & { originalId?: string };

export function snapshotToDraft(provider: ProviderSnapshot): ProviderDraftState {
  return {
    id: provider.id,
    originalId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    modelsUrl: provider.modelsUrl ?? "",
    api: provider.api,
    headers: { ...provider.headers },
    compat: {
      supportsDeveloperRole: provider.compat?.supportsDeveloperRole ?? null,
      supportsReasoningEffort: provider.compat?.supportsReasoningEffort ?? null,
    },
    models: provider.models.map((model) => {
      const detected = detectModelThinking(model.id);
      const useProfile =
        model.reasoning && model.thinkingLevelMap === undefined && detected.source === "profile";
      return {
        ...model,
        ...(model.thinkingLevelMap
          ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
          : useProfile && detected.thinkingLevelMap
            ? { thinkingLevelMap: { ...detected.thinkingLevelMap } }
            : {}),
        input: [...model.input],
      };
    }),
  };
}

export function providerDraftFingerprint(draft: ProviderDraftState): string {
  return JSON.stringify({
    ...draft,
    models: [...draft.models]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
  });
}

export function emptyProviderDraft(): ProviderDraftState {
  return {
    id: "",
    name: "New Provider",
    baseUrl: "",
    modelsUrl: "",
    api: "openai-completions",
    headers: { "User-Agent": "PiAbyss/0.3.2" },
    compat: {
      supportsDeveloperRole: null,
      supportsReasoningEffort: null,
    },
    models: [],
  };
}

/** Smallest unused positive-integer Provider ID across the current list.
 *  Existing string IDs (e.g. "openai") are left untouched and ignored here. */
export function nextProviderId(existingIds: string[]): string {
  const used = new Set(existingIds.map((id) => id.trim()).filter(Boolean));
  let n = 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

export function enabledProviderCatalog(models: ProviderModelConfig[]): DiscoveredProviderModel[] {
  return models.map((model) => {
    const detected = detectModelThinking(model.id);
    return {
      ...model,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      input: [...model.input],
      enabled: true,
      thinkingSource: model.reasoning && detected.source === "profile" ? "profile" : "configured",
    };
  });
}

export function stripProviderModelState(model: DiscoveredProviderModel): ProviderModelConfig {
  const { enabled: _enabled, thinkingSource: _thinkingSource, ...config } = model;
  return config;
}

export function customThinkingMap(model: DiscoveredProviderModel): ThinkingLevelMap {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => {
      const configured = model.thinkingLevelMap?.[level];
      if (configured !== undefined) return [level, configured];
      return [level, ["off", "minimal", "low", "medium", "high"].includes(level) ? level : null];
    }),
  ) as ThinkingLevelMap;
}

export function automaticThinkingConfig(
  modelId: string,
): Pick<DiscoveredProviderModel, "reasoning" | "thinkingLevelMap" | "thinkingSource"> {
  const detected = detectModelThinking(modelId);
  return {
    reasoning: true,
    thinkingLevelMap: detected.thinkingLevelMap,
    thinkingSource: detected.reasoning ? detected.source : "default",
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateProviderDraft(draft: ProviderDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "providersErrorNameRequired";
  if (!draft.id.trim()) errors.id = "providersErrorIdRequired";
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) errors.baseUrl = "providersErrorBaseUrlRequired";
  else if (!isHttpUrl(baseUrl)) errors.baseUrl = "providersErrorUrlFormat";
  const modelsUrl = draft.modelsUrl?.trim();
  if (modelsUrl && !isHttpUrl(modelsUrl)) errors.modelsUrl = "providersErrorUrlFormat";
  return errors;
}

export function providerDraftForSave(
  draft: ProviderDraft,
  hadStoredCompatibility = false,
): ProviderDraft {
  const compat = draft.compat;
  const hasCompatibilityOverride = Object.values(compat ?? {}).some(
    (value) => typeof value === "boolean",
  );
  return {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    ...(draft.modelsUrl?.trim() ? { modelsUrl: draft.modelsUrl.trim() } : {}),
    api: draft.api,
    authHeader: draft.api === "openai-completions" || draft.api === "openai-responses",
    headers: draft.headers,
    ...((hadStoredCompatibility || hasCompatibilityOverride) && compat ? { compat } : {}),
    models: draft.models,
  };
}

export function providerSaveFailureMessage(message: string, provider: ProviderDraft): string {
  if (
    message.includes("invalid provider.save params") &&
    (provider.modelsUrl !== undefined || provider.compat !== undefined)
  ) {
    return "Pi Host must be restarted before saving Models URL or compatibility overrides. Restart Host in Host settings, then save again.";
  }
  return message;
}

export function providerLoadFailureMessage(error: HostError | undefined, fallback: string): string {
  const message = error?.message ?? fallback;
  const details = error?.details;
  const operationKind =
    details !== null &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    typeof details.operationKind === "string"
      ? details.operationKind
      : null;
  return operationKind ? `${message} (${operationKind})` : message;
}

export function providerThinkingMode(
  model: DiscoveredProviderModel,
): "auto" | "custom" | "disabled" {
  if (!model.reasoning) return "disabled";
  return model.thinkingSource === "manual" ||
    (model.thinkingSource === "configured" && model.thinkingLevelMap !== undefined)
    ? "custom"
    : "auto";
}

export function providerThinkingSourceLabel(t: Translate, model: DiscoveredProviderModel): string {
  switch (model.thinkingSource) {
    case "provider":
      return t("providersThinkingProvider");
    case "profile":
      return t("providersThinkingProfile");
    case "inferred":
      return t("providersThinkingInferred");
    case "manual":
      return t("providersThinkingManual");
    case "configured":
      return t("providersThinkingConfigured");
    default:
      return model.reasoning ? t("providersThinkingAutoDefaults") : t("providersThinkingNone");
  }
}

export function newProviderModel(id: string): DiscoveredProviderModel {
  const detected = detectModelThinking(id);
  return {
    id,
    name: id,
    reasoning: detected.reasoning,
    ...(detected.thinkingLevelMap ? { thinkingLevelMap: detected.thinkingLevelMap } : {}),
    input: ["text"],
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    enabled: true,
    thinkingSource: detected.source,
  };
}
