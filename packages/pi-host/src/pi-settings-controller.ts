import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  HostError,
  PiSettingsPatch,
  PiSettingsSnapshot,
  ModelSummary,
  ThinkingLevel,
} from "@piabyss/protocol";
import { createHostError } from "@piabyss/protocol";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { MethodHandler } from "./server.js";
import { logger } from "./logger.js";

function settingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function readGlobalSettings(agentDir: string): Record<string, unknown> {
  const path = settingsPath(agentDir);
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function writeGlobalSettings(agentDir: string, patch: Record<string, unknown>): void {
  const path = settingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const current = readGlobalSettings(agentDir);
  const next = { ...current, ...patch };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function modelSummaries(runtime: ModelRuntime): ModelSummary[] {
  return runtime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    providerName: runtime.getProvider(model.provider)?.name,
    modelId: model.id,
    name: model.name ?? model.id,
    // Same source as model.list's summarizeModel — clients (e.g. the schedule
    // form's thinking-depth picker) rely on per-model levels being present.
    thinkingLevels: getSupportedThinkingLevels(model).map(String),
    input: model.input ?? [],
  }));
}

function snapshot(settingsManager: SettingsManager, runtime: ModelRuntime): PiSettingsSnapshot {
  const settings = settingsManager.getGlobalSettings();
  return {
    ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
    ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
    defaultThinkingLevel: settingsManager.getDefaultThinkingLevel() ?? "medium",
    retryMaxRetries: settings.retry?.maxRetries ?? 3,
    defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    ...(settings.defaultTools ? { defaultTools: [...settings.defaultTools] } : {}),
    ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
    models: modelSummaries(runtime),
  };
}

function validateDefaultModel(
  runtime: ModelRuntime,
  provider: string | undefined,
  modelId: string | undefined,
): HostError | undefined {
  if (!provider && !modelId) return undefined;
  if (!provider || !modelId) {
    return createHostError("INVALID_REQUEST", "Default model requires both provider and model");
  }
  const model = runtime
    .getAvailableSnapshot()
    .find((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (!model) {
    return createHostError("MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);
  }
  return undefined;
}

function applyCurrentSessionSettings(session: AgentSession | null, patch: PiSettingsPatch): void {
  if (!session) return;
  if (patch.defaultThinkingLevel !== undefined) {
    session.setThinkingLevel(patch.defaultThinkingLevel as ThinkingLevel);
  }
  if (patch.retryMaxRetries !== undefined) session.setAutoRetryEnabled(true);
  if (patch.steeringMode !== undefined) session.setSteeringMode(patch.steeringMode);
  if (patch.followUpMode !== undefined) session.setFollowUpMode(patch.followUpMode);
}

export function createPiSettingsHandlers(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Partial<Record<string, MethodHandler>> {
  const getRuntime = () => factory.deps.modelRuntime;
  const globalSettingsManager = SettingsManager.create(process.cwd(), agentDir, {
    projectTrusted: false,
  });
  const getSettingsManager = () => globalSettingsManager;

  return {
    "piSettings.get": async () => {
      const settingsManager = getSettingsManager();
      if (!settingsManager) {
        return { error: createHostError("HOST_NOT_READY", "Settings manager is not ready") };
      }
      return { result: snapshot(settingsManager, getRuntime()) };
    },
    "piSettings.patch": async (ctx) => {
      const settingsManager = getSettingsManager();
      if (!settingsManager) {
        return { error: createHostError("HOST_NOT_READY", "Settings manager is not ready") };
      }
      const patch = ctx.params as PiSettingsPatch;
      const settings = settingsManager.getGlobalSettings();
      const nextProvider = patch.defaultProvider ?? settings.defaultProvider;
      const nextModel = patch.defaultModel ?? settings.defaultModel;
      const modelError = validateDefaultModel(getRuntime(), nextProvider, nextModel);
      if (modelError) return { error: modelError };

      const jsonPatch: Record<string, unknown> = {};
      if (patch.defaultProvider !== undefined) jsonPatch.defaultProvider = patch.defaultProvider;
      if (patch.defaultModel !== undefined) jsonPatch.defaultModel = patch.defaultModel;
      if (patch.defaultThinkingLevel !== undefined) {
        jsonPatch.defaultThinkingLevel = patch.defaultThinkingLevel;
      }
      if (patch.retryMaxRetries !== undefined) {
        jsonPatch.retry = {
          ...(settings.retry ?? {}),
          enabled: true,
          maxRetries: patch.retryMaxRetries,
        };
      }
      if (patch.defaultProjectTrust !== undefined) {
        jsonPatch.defaultProjectTrust = patch.defaultProjectTrust;
      }
      if (patch.steeringMode !== undefined) jsonPatch.steeringMode = patch.steeringMode;
      if (patch.followUpMode !== undefined) jsonPatch.followUpMode = patch.followUpMode;
      if (patch.defaultTools !== undefined) {
        // De-duplicate while keeping the caller's order. Pi treats an empty array
        // as "no built-in tools" (extension tools stay enabled), so persist it
        // verbatim rather than dropping the key.
        jsonPatch.defaultTools = [...new Set(patch.defaultTools)];
      }
      if (patch.httpProxy !== undefined) {
        const proxy = patch.httpProxy.trim();
        // An empty value clears the setting; writeGlobalSettings serializes the
        // `undefined` assignment as an absent key, keeping settings.json clean.
        if (proxy) {
          let parsed: URL;
          try {
            parsed = new URL(proxy);
          } catch {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                "httpProxy must be a valid http(s) proxy URL",
              ),
            };
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
              error: createHostError(
                "INVALID_REQUEST",
                "httpProxy must use the http: or https: scheme",
              ),
            };
          }
          jsonPatch.httpProxy = proxy;
        } else {
          jsonPatch.httpProxy = undefined;
        }
      }

      try {
        writeGlobalSettings(factory.deps.agentDir, jsonPatch);
        await settingsManager.reload();
        const graphSettings = factory.getGraph()?.settingsManager;
        if (graphSettings && patch.defaultProjectTrust !== undefined) {
          graphSettings.setProjectTrusted(patch.defaultProjectTrust !== "never");
        }
        await graphSettings?.reload();
        applyCurrentSessionSettings(factory.getGraph()?.agentSession ?? null, patch);
        return { result: snapshot(settingsManager, getRuntime()) };
      } catch (error) {
        logger.warn("Failed to patch Pi settings", {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "Failed to write Pi settings",
          ),
        };
      }
    },
  };
}
